import { createNoise2D } from "simplex-noise";
import {
  BufferAttribute,
  Camera,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  Scene,
  Texture,
  UniformsUtils,
  Vector2,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { copyMaterial } from "../components/copy-material";
import { patchMaterial } from "../components/patch-material";
import { BaseEffect, CommonUniforms, defaultValues } from "../effects/base-effect";
import maskUpdateFrag from "../glsl/mask-update.frag";
import modulatorPrecomputeFrag from "../glsl/modulator-precompute.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { createEffectStateView, createStepStateView } from "../store";
import {
  getContextualModAmountsNormalized,
  getMacroAmountValuesNormalized,
  getModAmountValuesNormalized,
  hasActiveModulatorRouting,
  hasNestedModulatorRouting,
} from "../store/modulators";
import type { ParameterKey, SpectrogramData, State } from "../store/types";
import type { ParameterUniform } from "../types";
import { readRenderTargetPixelsAsync } from "./async-readpixels";
import { getFileOnsets } from "./file-onsets";
import { buildModulatorUniforms } from "./modulator-utils";
import { withPlatformDefines } from "./shader-utils";
import { pitchUvToBandIndex, resolveBrushAnchor, resolveBrushFootprint, swungGridCellWidthUv } from "./utils";

// Import EffectType from the dependency-free types module
import type { EffectType } from "../effects/types";
export type { EffectType };

// Effects registry type
export type EffectsRegistry = Record<string, BaseEffect>;

const noise2D = createNoise2D();

// Unit quad in [0,1]², stretched per instance to a pixel range's bounding box
// by patchMaterial's vertex shader.
const PATCH_QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const PATCH_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

function createParameterUniform(value: number, minValue: number, maxValue: number): ParameterUniform {
  return {
    value,
    minValue,
    maxValue,
    modulationAmounts: [],
    contextualModAmounts: [],
    macroAmounts: [],
  };
}

// Mutate a ParameterUniform slot in place from step state, avoiding the wrapper
// allocation that `slot.value = { ... }` would incur.
function writeModulatableParam(
  target: ParameterUniform,
  value: number,
  minValue: number,
  maxValue: number,
  step: State,
  key: ParameterKey,
): void {
  target.value = value;
  target.minValue = minValue;
  target.maxValue = maxValue;
  target.modulationAmounts = getModAmountValuesNormalized(step, key);
  target.contextualModAmounts = getContextualModAmountsNormalized(step, key);
  target.macroAmounts = getMacroAmountValuesNormalized(step, key);
}

/**
 * Textures required for stroke rendering
 */
export interface StrokeTextures {
  packedDataTex: DataTexture;
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
  placeholderTexture: Texture;
  modulatorScaleLut: Texture | null;
  modulator1Texture: Texture | null;
  modulator2Texture: Texture | null;
  modulator3Texture: Texture | null;
}

/**
 * Source file information for cross-file strokes
 */
export interface SourceFileInfo {
  id: string;
  filePath: string;
  displayName: string;
  spectrogramData: SpectrogramData;
  textures: {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  };
  // Nearest-onset lookup row for this file at the current sensitivity, baked by
  // lib/onset-map.ts. Null when the file has no onsets yet.
  onsetTexture?: Texture | null;
}

/**
 * Parameters for a single stroke operation
 */
export interface StrokeParams {
  cursorPos: Vector2;
  preview: boolean;
  bpm: number;
  totalDuration: number;
  viewZoomPower: number;
  viewOffset: number;
  viewZoomPowerY: number;
  viewOffsetY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  // The painted file's own onset map, read by passes after the first, which
  // sample the destination rather than the source file.
  destOnsetTexture?: Texture | null;
}

/**
 * StrokeRenderer - Handles all WebGL-based stroke rendering logic.
 * Extracted from FileRenderer to enable unit testing.
 */
export class StrokeRenderer {
  private gl: WebGLRenderer;
  private spectrogramData: SpectrogramData;
  private textures: StrokeTextures;
  private fileId: string;
  private effects: EffectsRegistry;

  // FBOs for ping-pong rendering
  private fbo1: WebGLRenderTarget;
  private fbo2: WebGLRenderTarget;
  private passFbo1: WebGLRenderTarget;
  private passFbo2: WebGLRenderTarget;
  private strokeMaskFbo: WebGLRenderTarget;
  private strokeMaskFbo2: WebGLRenderTarget;
  private strokeStartFbo: WebGLRenderTarget;
  // Two RGBA float targets (MRT) holding the precomputed per-pixel modulator
  // outputs for the current step. tex[0] = (mod0.xy, mod1.xy); tex[1] = mod2.xy.
  private modulatorFbo: WebGLRenderTarget;

  // Scene objects
  private fboScene: Scene;
  private fboMesh: Mesh;
  private camera: Camera;

  // Materials
  private maskMaterial: RawShaderMaterial;
  private modulatorMaterial: RawShaderMaterial;

  // Preallocated buffer reused across mask-update iterations to avoid allocating
  // a fresh macro array on every step.
  private maskMacroValuesBuf: number[] = [0, 0, 0, 0];

  // State
  // The spectrogram as it was before a preview run of committed strokes.
  // Allocated only while a preview is up.
  private rollbackFbo: WebGLRenderTarget | null = null;
  private pingPong = 0;
  private maskPingPong = 0;
  private isInitialized = false;

  // Test seam: forces committed scissored strokes back onto the legacy
  // full-texture blit + ping-pong-swap path instead of the brush-sized
  // copy-back, so equivalence between the two can be asserted.
  disableScissorCopyBack = false;

  // FBO data cache
  private fboDataCache: Float32Array | null = null;
  private fboDataDirty = true;

  // Dirty region tracking for partial synthesis
  private dirtyRegion: { startX: number; endX: number; startY: number; endY: number } | null = null;

  // UV bounds of the committed dabs of the current stroke, accumulated across
  // its dabs and reset per stroke in beginStroke(). getDirtyPixelRanges() turns
  // these into the packed-pixel footprint the history delta stores. Kept
  // separate from dirtyRegion (which synthesis clears) so a mid-stroke clear
  // can't drop earlier dabs.
  private committedTimeMin = Infinity;
  private committedTimeMax = -Infinity;
  private committedPitchMin = Infinity;
  private committedPitchMax = -Infinity;
  // Monotonic count of stroke starts. Commit-time work that runs async after a
  // stroke (boundary conditioning) captures this before awaiting and drops its
  // result if a new stroke began meanwhile, so it never writes over new dabs.
  private strokeGeneration = 0;

  constructor(
    gl: WebGLRenderer,
    spectrogramData: SpectrogramData,
    textures: StrokeTextures,
    fileId: string,
    effects: EffectsRegistry,
  ) {
    this.gl = gl;
    this.spectrogramData = spectrogramData;
    this.textures = textures;
    this.fileId = fileId;
    this.effects = effects;

    // Create camera
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    // Create FBO scene
    this.fboScene = new Scene();
    this.fboMesh = new Mesh(new PlaneGeometry(2, 2));
    this.fboScene.add(this.fboMesh);

    // Create FBOs
    const { textureWidth, textureHeight } = spectrogramData;

    this.fbo1 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.fbo2 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.passFbo1 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.passFbo2 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.strokeMaskFbo = this.createFBO(textureWidth, textureHeight, RedFormat);
    this.strokeMaskFbo2 = this.createFBO(textureWidth, textureHeight, RedFormat);
    this.strokeStartFbo = this.createFBO(textureWidth, textureHeight, RGBAFormat);

    // Multi-render-target buffer for the precomputed modulator outputs.
    this.modulatorFbo = new WebGLRenderTarget(textureWidth, textureHeight, {
      count: 2,
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });

    // Modulator precompute material — evaluates all modulators per pixel into
    // modulatorFbo's two targets. Reuses the common-uniform set so the same
    // modulator/source/dest uniforms drive it as the effects.
    this.modulatorMaterial = new RawShaderMaterial({
      uniforms: { ...UniformsUtils.clone(defaultValues), nestedModulationActive: { value: false } },
      vertexShader: passThroughVert,
      fragmentShader: withPlatformDefines(modulatorPrecomputeFrag),
      glslVersion: GLSL3,
    });

    // Create mask material
    this.maskMaterial = new RawShaderMaterial({
      uniforms: {
        ...UniformsUtils.clone(defaultValues),
        currentMaskTex: { value: null },
        destMetadataTex: { value: null },
        destInverseMapTex: { value: null },
        destSpectrogramTextureSize: { value: new Vector2(1, 1) },
        destFrameCount: { value: 0 },
        destBandCount: { value: 0 },
        brushBottomLeftUv: { value: new Vector2(0, 0) },
        brushSizeUv: { value: new Vector2(0, 0) },
        strokePressure: { value: 0 },
        strokeTiltX: { value: 0.5 },
        strokeTiltY: { value: 0.5 },
      },
      vertexShader: passThroughVert,
      fragmentShader: withPlatformDefines(maskUpdateFrag),
      glslVersion: GLSL3,
    });

    // UniformsUtils.clone does a deep clone for Three primitives (Vectors/Textures)
    // but leaves plain-object .value fields as shared references with defaultValues.
    // Give this material its own ParameterUniform objects so we can safely mutate
    // them in place on the hot path without touching shared defaults.
    const mu = this.maskMaterial.uniforms;
    mu.brushIntensity = { value: createParameterUniform(1, 0, 1) };
    mu.brushCurveTime = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewTime = { value: createParameterUniform(0.5, 0, 1) };
    mu.brushCurvePitch = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewPitch = { value: createParameterUniform(0.5, 0, 1) };
    mu.macroValues = { value: this.maskMacroValuesBuf };
  }

  /**
   * Hardware blit between two FBOs using WebGL2 blitFramebuffer (GPU DMA copy).
   */
  private blitFBO(src: WebGLRenderTarget, dst: WebGLRenderTarget): void {
    const gl2 = this.gl.getContext() as WebGL2RenderingContext;
    // Force Three.js to initialize the framebuffers by binding them
    this.gl.setRenderTarget(src);
    this.gl.setRenderTarget(dst);
    // Access internal framebuffer handles

    const props = (this.gl as any).properties as { get(obj: unknown): Record<string, unknown> };
    const srcFb = props.get(src).__webglFramebuffer as WebGLFramebuffer;
    const dstFb = props.get(dst).__webglFramebuffer as WebGLFramebuffer;
    const w = src.width;
    const h = src.height;
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, srcFb);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, dstFb);
    gl2.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
    this.gl.setRenderTarget(null);
  }

  /**
   * Copy a contiguous band of rows [rowStart, rowStart+rowCount) from src to dst,
   * leaving all other rows of dst untouched. Used by the committed-stroke
   * copy-back path so only the brush-sized region is moved each stroke.
   */
  private blitFBORows(src: WebGLRenderTarget, dst: WebGLRenderTarget, rowStart: number, rowCount: number): void {
    const gl2 = this.gl.getContext() as WebGL2RenderingContext;
    this.gl.setRenderTarget(src);
    this.gl.setRenderTarget(dst);

    const props = (this.gl as any).properties as { get(obj: unknown): Record<string, unknown> };
    const srcFb = props.get(src).__webglFramebuffer as WebGLFramebuffer;
    const dstFb = props.get(dst).__webglFramebuffer as WebGLFramebuffer;
    const w = src.width;
    const y0 = Math.max(0, rowStart);
    const y1 = Math.min(src.height, rowStart + rowCount);
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, srcFb);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, dstFb);
    gl2.blitFramebuffer(0, y0, w, y1, 0, y0, w, y1, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
    this.gl.setRenderTarget(null);
  }

  private createFBO(width: number, height: number, format: typeof RGBAFormat | typeof RedFormat): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      format,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
  }

  /**
   * Evaluates every modulator's stereo output per pixel into modulatorFbo's two
   * targets, using the step's common uniforms. Effects then sample these textures
   * instead of evaluating the modulators inline. Runs once per step.
   */
  private renderModulatorTextures(commonUniforms: CommonUniforms): void {
    const m = this.modulatorMaterial;
    for (const key in commonUniforms) {
      const src = (commonUniforms as Record<string, { value: unknown } | undefined>)[key];
      if (!src) continue;
      if (key in m.uniforms) {
        m.uniforms[key].value = src.value;
      } else {
        m.uniforms[key] = { value: src.value };
      }
    }
    this.fboMesh.material = m;
    this.gl.setRenderTarget(this.modulatorFbo);
    this.gl.render(this.fboScene, this.camera);
  }

  /**
   * Update the modulator image textures. They load asynchronously (and change
   * when the user picks a different image), so the values captured at
   * construction go stale; the owner re-syncs them here whenever they change.
   */
  updateModulatorTextures(
    modulator1Texture: Texture | null,
    modulator2Texture: Texture | null,
    modulator3Texture: Texture | null,
  ): void {
    this.textures.modulator1Texture = modulator1Texture;
    this.textures.modulator2Texture = modulator2Texture;
    this.textures.modulator3Texture = modulator3Texture;
  }

  /**
   * Initialize the renderer with the spectrogram data.
   * Must be called before rendering strokes.
   */
  initialize(): void {
    if (this.isInitialized) return;

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = this.textures.packedDataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    this.pingPong = 0;

    // Clear both mask FBOs on init
    const oldClearColor = new Color();
    this.gl.getClearColor(oldClearColor);
    const oldClearAlpha = this.gl.getClearAlpha();
    this.gl.setClearColor(0x000000, 0);
    this.gl.setRenderTarget(this.strokeMaskFbo);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(this.strokeMaskFbo2);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(null);
    this.gl.setClearColor(oldClearColor, oldClearAlpha);
    this.maskPingPong = 0;

    // Snapshot initial state to strokeStartFbo
    this.snapshotToStrokeStart(this.fbo1.texture);

    this.fboDataDirty = true;
    this.isInitialized = true;
  }

  /**
   * Snapshot the current FBO state to the strokeStartFbo.
   */
  private snapshotToStrokeStart(sourceTexture: Texture): void {
    const prevMaterial = this.fboMesh.material;

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = sourceTexture;

    const oldTarget = this.gl.getRenderTarget();
    this.gl.setRenderTarget(this.strokeStartFbo);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(oldTarget);

    this.fboMesh.material = prevMaterial;
  }

  /**
   * Resolve brush footprint for a given step state, taking Grid/Full sentinel
   * values on brushSizeTime/brushSizePitch into account. When `anchorTimeUv` is
   * given (the brush's BL time), a Grid-mode time brush under time-snap is sized
   * to the swung grid cell it lands in so snapped strokes tile without gaps.
   */
  resolveBrushFootprint(state: State, bpm: number, totalDuration: number, anchorTimeUv?: number) {
    const footprint = resolveBrushFootprint({
      brushSizeTime: state.brushSizeTime,
      brushSizePitch: state.brushSizePitch,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      bpm,
      totalDuration,
      bandsPerOctave: this.spectrogramData.bandsPerOctave,
      numBands: this.spectrogramData.numBands,
    });
    if (anchorTimeUv !== undefined && !footprint.fullTime) {
      const swungTimeUv = swungGridCellWidthUv(
        anchorTimeUv,
        {
          brushSizeTime: state.brushSizeTime,
          gridSizeBeats: state.gridSizeBeats,
          gridSwing: state.gridSwing,
          snapTime: state.snapTime,
          onsets: getFileOnsets(this.fileId),
        },
        bpm,
        totalDuration,
      );
      if (swungTimeUv !== null) footprint.sizeUv.x = swungTimeUv;
    }
    return footprint;
  }

  /**
   * Calculate brush size in UV coordinates from state size parameters.
   */
  calculateBrushSizeUv(state: State, bpm: number, totalDuration: number): Vector2 {
    return this.resolveBrushFootprint(state, bpm, totalDuration).sizeUv;
  }

  /**
   * Calculate clone-stamp offset from the cursor position, scaled to source UV space.
   * The base source position lives in sourceTimeOffset/sourcePitchOffset params and is
   * added (with modulation) inside the shader, so this helper must not include it.
   */
  calculateSourceOffset(
    lockedOffset: { beats: number; pitch: number } | null | undefined,
    mode: string,
    mousePos: Vector2 | null,
    timeScale: number,
    bandScale: number,
  ): Vector2 {
    if (!mousePos) {
      return new Vector2(0, 0);
    }

    const scaledMouse = new Vector2(mousePos.x * timeScale, mousePos.y * bandScale);

    if (mode === "follow") {
      return new Vector2(0, 0);
    } else if (mode === "fixed") {
      return scaledMouse.clone().negate();
    } else if (mode === "anchored") {
      if (lockedOffset) {
        return new Vector2(lockedOffset.beats, lockedOffset.pitch);
      } else {
        return scaledMouse.clone().negate();
      }
    }

    return new Vector2(0, 0);
  }

  /**
   * Build common uniforms for a specific step.
   */
  buildStepUniforms(
    stepState: State,
    brushSizeUv: Vector2,
    sourceOffsetUv: Vector2,
    destTexture: WebGLRenderTarget | { texture: DataTexture | Texture },
    cursorPos: Vector2,
    sourceFile: SourceFileInfo,
    bpm: number,
    totalDuration: number,
    sourceBpm: number,
    viewZoomPower: number,
    viewOffset: number,
    viewZoomPowerY: number,
    viewOffsetY: number,
    magnitudeLimit: number,
  ): CommonUniforms {
    const { placeholderTexture, modulatorScaleLut, modulator1Texture, modulator2Texture, modulator3Texture } =
      this.textures;

    const modulatorUniforms = buildModulatorUniforms(
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      stepState,
    );

    return {
      // Filled in per step after the modulator precompute pass.
      modulatorTex0: { value: null },
      modulatorTex1: { value: null },
      sourceSpectrogramTex: { value: sourceFile.textures.packed.texture || placeholderTexture },
      sourceSpectrogramTextureSize: { value: sourceFile.spectrogramData.packedTextureSize },
      sourceInverseMapTex: { value: sourceFile.textures.inverse || placeholderTexture },
      sourceMetadataTex: { value: sourceFile.textures.metadata || placeholderTexture },
      sourceMinFreq: { value: sourceFile.spectrogramData.minFreq },
      sourceBandsPerOctave: { value: sourceFile.spectrogramData.bandsPerOctave },
      sourceFrameCount: { value: sourceFile.spectrogramData.numFrames },
      sourceBandCount: { value: sourceFile.spectrogramData.numBands },
      sourceChannelCount: { value: sourceFile.spectrogramData.numChannels },
      sourceSampleRate: { value: sourceFile.spectrogramData.sampleRate },
      sourceOnsetTex: { value: sourceFile.onsetTexture ?? placeholderTexture },
      destSpectrogramTex: { value: destTexture.texture || placeholderTexture },
      destSpectrogramTextureSize: { value: this.spectrogramData.packedTextureSize },
      destInverseMapTex: { value: this.textures.inverseMapTex || placeholderTexture },
      destMetadataTex: { value: this.textures.metadataTex || placeholderTexture },
      destMinFreq: { value: this.spectrogramData.minFreq },
      destBandsPerOctave: { value: this.spectrogramData.bandsPerOctave },
      destFrameCount: { value: this.spectrogramData.numFrames },
      destBandCount: { value: this.spectrogramData.numBands },
      destChannelCount: { value: this.spectrogramData.numChannels },
      destSampleRate: { value: this.spectrogramData.sampleRate },
      originalSpectrogramTex: { value: this.textures.originalPackedDataTex || placeholderTexture },
      viewZoomPower: { value: viewZoomPower },
      viewOffset: { value: viewOffset },
      viewZoomPowerY: { value: viewZoomPowerY },
      viewOffsetY: { value: viewOffsetY },
      brushBottomLeftUv: { value: cursorPos },
      brushCurveTime: {
        value: {
          value: (stepState.brushCurveTime as number) / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushCurveTime"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushCurveTime"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushCurveTime"),
        },
      },
      brushSkewTime: {
        value: {
          value: ((stepState.brushSkewTime as number) + 100) / 200,
          minValue: 0,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushSkewTime"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushSkewTime"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushSkewTime"),
        },
      },
      brushCurvePitch: {
        value: {
          value: (stepState.brushCurvePitch as number) / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushCurvePitch"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushCurvePitch"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushCurvePitch"),
        },
      },
      brushSkewPitch: {
        value: {
          value: ((stepState.brushSkewPitch as number) + 100) / 200,
          minValue: 0,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushSkewPitch"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushSkewPitch"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushSkewPitch"),
        },
      },
      brushSizeUv: { value: brushSizeUv },
      brushIntensity: {
        value: {
          value: stepState.brushIntensity / 100,
          minValue: 0,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushIntensity"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushIntensity"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushIntensity"),
        },
      },
      brushPan: {
        value: {
          value: stepState.brushPan / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushPan"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushPan"),
          macroAmounts: getMacroAmountValuesNormalized(stepState, "brushPan"),
        },
      },
      bpm: { value: bpm },
      sourceOffsetX: { value: sourceOffsetUv.x },
      sourceOffsetY: { value: sourceOffsetUv.y },
      // Beat-based scale: 1 beat in dest UV = 1 beat in source UV
      sourceTimeScale: {
        value: (() => {
          const sourceDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;
          return (bpm * totalDuration) / (sourceBpm * sourceDuration);
        })(),
      },
      sourceBandScale: {
        value: this.spectrogramData.numBands / sourceFile.spectrogramData.numBands,
      },
      sourceTimeOffset: {
        value: {
          value: stepState.sourcePositionMode === "follow" ? 0 : (stepState.sourceTimeOffset as number) / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts:
            stepState.sourcePositionMode === "follow"
              ? getModAmountValuesNormalized(stepState, "sourceTimeOffset").map(() => 0)
              : getModAmountValuesNormalized(stepState, "sourceTimeOffset"),
          contextualModAmounts:
            stepState.sourcePositionMode === "follow"
              ? getContextualModAmountsNormalized(stepState, "sourceTimeOffset").map(() => 0)
              : getContextualModAmountsNormalized(stepState, "sourceTimeOffset"),
          macroAmounts:
            stepState.sourcePositionMode === "follow"
              ? getMacroAmountValuesNormalized(stepState, "sourceTimeOffset").map(() => 0)
              : getMacroAmountValuesNormalized(stepState, "sourceTimeOffset"),
        },
      },
      sourcePitchOffset: {
        value: {
          value: stepState.sourcePositionMode === "follow" ? 0 : (stepState.sourcePitchOffset as number) / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts:
            stepState.sourcePositionMode === "follow"
              ? getModAmountValuesNormalized(stepState, "sourcePitchOffset").map(() => 0)
              : getModAmountValuesNormalized(stepState, "sourcePitchOffset"),
          contextualModAmounts:
            stepState.sourcePositionMode === "follow"
              ? getContextualModAmountsNormalized(stepState, "sourcePitchOffset").map(() => 0)
              : getContextualModAmountsNormalized(stepState, "sourcePitchOffset"),
          macroAmounts:
            stepState.sourcePositionMode === "follow"
              ? getMacroAmountValuesNormalized(stepState, "sourcePitchOffset").map(() => 0)
              : getMacroAmountValuesNormalized(stepState, "sourcePitchOffset"),
        },
      },
      blendMode: { value: stepState.blendMode },
      algorithm: { value: stepState.algorithm },
      magnitudeLimit: { value: magnitudeLimit },
      wrapMode: { value: stepState.brushWrapMode },
      modulators: { value: modulatorUniforms },
      gainLut: { value: modulatorScaleLut || placeholderTexture },
      modulator1ImageTex: { value: modulator1Texture || placeholderTexture },
      modulator2ImageTex: { value: modulator2Texture || placeholderTexture },
      modulator3ImageTex: { value: modulator3Texture || placeholderTexture },
      modulator1SeqDataTex: { value: modulatorUniforms[0]?.seqDataTex || placeholderTexture },
      modulator2SeqDataTex: { value: modulatorUniforms[1]?.seqDataTex || placeholderTexture },
      modulator3SeqDataTex: { value: modulatorUniforms[2]?.seqDataTex || placeholderTexture },
      macroValues: {
        value: (stepState.brushes[stepState.activeBrushIndex]?.macroValues ?? [50, 50, 50, 50]).map((v) => v / 100),
      },
    };
  }

  /**
   * Calculate the scissor row range in the packed texture for a given brush UV extent.
   * Returns null if scissoring wouldn't help (brush covers most of the texture).
   */
  calculateScissorRows(
    brushBottomLeftUv: Vector2,
    brushSizeUv: Vector2,
  ): { rowStart: number; rowCount: number } | null {
    const { numBands, textureWidth, textureHeight, metadata } = this.spectrogramData;

    // Band indices count down in frequency, so the brush's low pitch edge is
    // the highest index.
    const brushLowPitchY = brushBottomLeftUv.y;
    const brushHighPitchY = brushBottomLeftUv.y + brushSizeUv.y;

    // Add margin for effects that sample neighboring bands
    const margin = 4;
    const highBand = Math.min(numBands - 1, Math.floor(pitchUvToBandIndex(brushLowPitchY, numBands)) + margin);
    const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(brushHighPitchY, numBands)) - margin);

    // If brush covers most of the bands, don't bother with scissor
    const bandSpan = highBand - lowBand + 1;
    if (bandSpan >= numBands * 0.8) {
      return null;
    }

    // Get pixel range from metadata (bandStartOffset is at metadata[band * 4])
    const firstPixel = metadata[lowBand * 4];
    const lastBandOffset = metadata[highBand * 4];
    const lastBandLength = metadata[highBand * 4 + 1];
    const lastPixel = lastBandOffset + lastBandLength;

    const rowStart = Math.max(0, Math.floor(firstPixel / textureWidth));
    const rowEnd = Math.min(textureHeight, Math.ceil(lastPixel / textureWidth));

    return { rowStart, rowCount: rowEnd - rowStart };
  }

  /**
   * Render a brush stroke.
   */
  renderStroke(params: StrokeParams, state: State, sourceFile: SourceFileInfo): void {
    if (!this.isInitialized) {
      this.initialize();
    }

    const {
      cursorPos,
      preview,
      bpm,
      totalDuration,
      viewZoomPower,
      viewOffset,
      viewZoomPowerY,
      viewOffsetY,
      pressure,
      tiltX,
      tiltY,
    } = params;

    if (cursorPos.x < 0) return;

    const activeStepState = createStepStateView(state, state.activeStepIndex);
    const activeStep = (state.brushes[state.activeBrushIndex]?.steps ?? [])[state.activeStepIndex];

    // Beat-based scale: converts dest UV to source UV so 1 beat = 1 beat
    const srcBpm = state.filepathsBpm?.[sourceFile.filePath] || bpm;
    const srcDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;
    const timeScale = (bpm * totalDuration) / (srcBpm * srcDuration);
    const bandScale = this.spectrogramData.numBands / sourceFile.spectrogramData.numBands;

    // Active step's footprint determines source offset semantics. In Full mode the
    // brush anchors to 0 on that axis, so the source offset is computed from that
    // anchor rather than the raw cursor.
    const activeFootprint = this.resolveBrushFootprint(activeStepState, bpm, totalDuration, cursorPos.x);
    const activeAnchor = resolveBrushAnchor(cursorPos, activeFootprint.fullTime, activeFootprint.fullPitch);

    const sourceOffsetUv = this.calculateSourceOffset(
      state.isStroking ? activeStep?.lockedOffset : null,
      activeStepState.sourcePositionMode as string,
      activeAnchor,
      timeScale,
      bandScale,
    );

    const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const destinationFbo = this.pingPong === 0 ? this.fbo2 : this.fbo1;

    // Determine the initial source FBO based on sourceDataMode
    const isSameFile = sourceFile.id === this.fileId;
    let initialSourceFbo: WebGLRenderTarget | { texture: DataTexture } =
      activeStepState.sourceDataMode === "original"
        ? { texture: sourceFile.textures.original }
        : isSameFile
          ? currentReadFBO
          : sourceFile.textures.packed;

    let tempFboA = this.passFbo1;
    let tempFboB = this.passFbo2;

    // For multi-step rendering, we iterate through all steps sequentially
    let stepInputFbo: WebGLRenderTarget | { texture: DataTexture } = initialSourceFbo;

    // Non-cumulative strokes: use snapshot as source to prevent self-feedback.
    // Gated by step 0's flags since step 0 is the step that actually consumes
    // initialSourceFbo; subsequent steps read each other's output.
    const firstStepState = createStepStateView(state, 0);
    if (!firstStepState.accumulate && isSameFile && firstStepState.sourceDataMode !== "original") {
      stepInputFbo = this.strokeStartFbo;
      initialSourceFbo = this.strokeStartFbo;
    }

    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    const numSteps = steps.length;

    // Calculate scissor rows from maximum brush extent across all steps.
    // If any step wraps in Y and its brush crosses the [0,1] boundary, skip scissoring
    // so wrapped bands are painted too. When any step is Full-Y the union anchor
    // collapses to y=0 and the extent reaches y=1, so scissoring is a no-op but safe.
    const maxBrushSizeUv = new Vector2(0, 0);
    const unionAnchor = new Vector2(cursorPos.x, cursorPos.y);
    let yWrapsOutOfBounds = false;
    for (let i = 0; i < numSteps; i++) {
      const s = createStepStateView(state, i);
      const fp = this.resolveBrushFootprint(s, bpm, totalDuration, cursorPos.x);
      maxBrushSizeUv.x = Math.max(maxBrushSizeUv.x, fp.sizeUv.x);
      maxBrushSizeUv.y = Math.max(maxBrushSizeUv.y, fp.sizeUv.y);
      if (fp.fullTime) unionAnchor.x = 0;
      if (fp.fullPitch) unionAnchor.y = 0;
      const wrapMode = s.brushWrapMode as number;
      const wrapsY = wrapMode === 2 || wrapMode === 3;
      const stepAnchorY = fp.fullPitch ? 0 : cursorPos.y;
      if (wrapsY && (stepAnchorY < 0 || stepAnchorY + fp.sizeUv.y > 1)) {
        yWrapsOutOfBounds = true;
      }
    }
    const scissorRows = yWrapsOutOfBounds ? null : this.calculateScissorRows(unionAnchor, maxBrushSizeUv);

    // Committed strokes use a copy-back path: render only the brush rows into
    // destinationFbo, then fold those rows back into the canonical buffer, so
    // per-stroke cost stays proportional to the brush rather than the whole
    // texture. Preview strokes still need a fully-valid destination because the
    // display samples destinationFbo directly (getDisplayTexture), so its
    // untouched rows must hold the current spectrogram.
    const committedScissor = scissorRows !== null && !preview && !this.disableScissorCopyBack;
    if (scissorRows) {
      if (!committedScissor) {
        this.blitFBO(currentReadFBO, destinationFbo);
      }

      const scissorVec = new Vector4(0, scissorRows.rowStart, this.spectrogramData.textureWidth, scissorRows.rowCount);
      destinationFbo.scissor.copy(scissorVec);
      destinationFbo.scissorTest = true;
      tempFboA.scissor.copy(scissorVec);
      tempFboA.scissorTest = true;
      tempFboB.scissor.copy(scissorVec);
      tempFboB.scissorTest = true;
      // Only precompute modulators for the rows effects will actually read.
      this.modulatorFbo.scissor.copy(scissorVec);
      this.modulatorFbo.scissorTest = true;
    }

    // Generate random value seeded by position using Perlin noise
    const strokeRandom = (noise2D(cursorPos.x * 50, cursorPos.y * 50) + 1) / 2;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const stepState = createStepStateView(state, stepIndex);
      const stepFootprint = this.resolveBrushFootprint(stepState, bpm, totalDuration, cursorPos.x);
      const stepBrushSizeUv = stepFootprint.sizeUv;
      const stepAnchor = resolveBrushAnchor(cursorPos, stepFootprint.fullTime, stepFootprint.fullPitch);

      // Determine the blend destination for this step
      const blendDestFbo = stepIndex === 0 ? currentReadFBO : stepInputFbo;

      // Build common uniforms for this step
      const sourceBpm = state.filepathsBpm?.[sourceFile.filePath] || bpm;
      const commonUniforms = this.buildStepUniforms(
        stepState,
        stepBrushSizeUv,
        sourceOffsetUv,
        blendDestFbo,
        stepAnchor,
        sourceFile,
        bpm,
        totalDuration,
        sourceBpm,
        viewZoomPower,
        viewOffset,
        viewZoomPowerY,
        viewOffsetY,
        state.magnitudeLimit,
      );

      // Determine source texture based on this step's sourceDataMode
      const stepSourceDataMode = stepState.sourceDataMode;
      const stepSourceFbo =
        stepSourceDataMode === "original" ? { texture: sourceFile.textures.original } : stepInputFbo;

      // Override the source texture to use the correct input for this step
      commonUniforms.sourceSpectrogramTex.value = stepSourceFbo.texture;

      // Precompute this step's modulator outputs into modulatorFbo, then point
      // the effect uniforms at the resulting textures. Done once per step before
      // any effect pass, so the expensive modulator evaluation happens once. When
      // nothing routes to a modulator, every consumer multiplies its output by
      // zero, so skip the pass and bind the zero placeholder instead.
      if (hasActiveModulatorRouting(stepState)) {
        // Nested-modulation routing lives on the step (modulator amounts are
        // per-step parameters), so resolve the gate from the step state, not the
        // global state, before rendering this step's modulators.
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        this.renderModulatorTextures(commonUniforms);
        commonUniforms.modulatorTex0 = { value: this.modulatorFbo.textures[0] };
        commonUniforms.modulatorTex1 = { value: this.modulatorFbo.textures[1] };
      } else {
        commonUniforms.modulatorTex0 = { value: this.textures.placeholderTexture };
        commonUniforms.modulatorTex1 = { value: this.textures.placeholderTexture };
      }

      // Get enabled effects in order for this step
      const stepEffects = stepState.effects as {
        id: string;
        effect: EffectType;
        enabled: boolean;
        params: Record<string, unknown>;
      }[];
      const enabledEffectItems = stepEffects.filter(({ enabled }) => enabled);

      // If no effects are enabled, add a passthrough effect
      if (enabledEffectItems.length === 0) {
        enabledEffectItems.push({ id: "passthrough", effect: "passthrough", enabled: true, params: {} });
      }

      // Create the iterative uniforms set for subsequent passes
      const iterativeUniforms = {
        ...commonUniforms,
        sourceInverseMapTex: commonUniforms.destInverseMapTex,
        sourceMetadataTex: commonUniforms.destMetadataTex,
        sourceMinFreq: commonUniforms.destMinFreq,
        sourceBandsPerOctave: commonUniforms.destBandsPerOctave,
        sourceFrameCount: commonUniforms.destFrameCount,
        sourceBandCount: commonUniforms.destBandCount,
        sourceChannelCount: commonUniforms.destChannelCount,
        sourceSampleRate: commonUniforms.destSampleRate,
        sourceSpectrogramTextureSize: commonUniforms.destSpectrogramTextureSize,
        sourceOnsetTex: { value: params.destOnsetTexture ?? this.textures.placeholderTexture },
        sourceOffsetX: { value: 0 },
        sourceOffsetY: { value: 0 },
        sourceTimeScale: { value: 1.0 },
        sourceBandScale: { value: 1.0 },
        sourceTimeOffset: {
          value: {
            value: 0,
            minValue: -1,
            maxValue: 1,
            modulationAmounts: [0, 0, 0],
            contextualModAmounts: [0, 0, 0, 0, 0, 0, 0, 0],
            macroAmounts: [0, 0, 0, 0],
          },
        },
        sourcePitchOffset: {
          value: {
            value: 0,
            minValue: -1,
            maxValue: 1,
            modulationAmounts: [0, 0, 0],
            contextualModAmounts: [0, 0, 0, 0, 0, 0, 0, 0],
            macroAmounts: [0, 0, 0, 0],
          },
        },
      };

      // Reset currentReadFbo to the step's input for effect processing
      let currentReadFbo: WebGLRenderTarget | { texture: DataTexture } = stepInputFbo;

      const isLastStep = stepIndex === numSteps - 1;

      const brushIterations = stepState.brushIterations as number;

      // Flatten every (effect, iteration, pass) the step will render. Effects
      // drop passes that would be a no-op at the current settings, so first/last
      // pass bookkeeping has to count what actually renders, not what exists.
      const plannedPasses: { effect: BaseEffect; effectState: State; passIndex: number; iteration: number }[] = [];
      for (const effectItem of enabledEffectItems) {
        const effect = this.effects[effectItem.effect];
        if (!effect) continue;
        const effectState = createEffectStateView(state, stepIndex, effectItem);
        const activePasses = effect.getActivePasses?.(effectState) ?? effect.materials.map((_, index) => index);
        if (activePasses.length === 0) continue;
        for (let i = 0; i < brushIterations; i++) {
          for (const passIndex of activePasses) {
            plannedPasses.push({ effect, effectState, passIndex, iteration: i });
          }
        }
      }

      // Every pass dropped out. One passthrough still has to run: it carries the
      // source offset, the brush blend, and the write into destinationFbo.
      if (plannedPasses.length === 0) {
        const passthrough = this.effects.passthrough;
        if (passthrough) {
          plannedPasses.push({
            effect: passthrough,
            effectState: createStepStateView(state, stepIndex),
            passIndex: 0,
            iteration: 0,
          });
        }
      }

      // Apply each planned pass in order
      for (let passOrdinal = 0; passOrdinal < plannedPasses.length; passOrdinal++) {
        const { effect, effectState, passIndex: p, iteration: i } = plannedPasses[passOrdinal];
        const isFirstOfStep = passOrdinal === 0;
        const uniformsForThisIteration = isFirstOfStep ? { ...commonUniforms } : { ...iterativeUniforms };

        // Add contextual modulation uniforms for this iteration/step.
        // The Time/Pitch position sources track the painted aim. On a
        // full-size axis the footprint anchors to 0, so the aim is read
        // straight from the cursor instead of the footprint center, letting
        // full-axis effects still be modulated by where you paint.
        const brushSizeUv = commonUniforms.brushSizeUv.value as Vector2;
        const brushCenterTime = stepFootprint.fullTime ? cursorPos.x : stepAnchor.x + brushSizeUv.x / 2;
        const brushCenterPitch = stepFootprint.fullPitch ? cursorPos.y : stepAnchor.y + brushSizeUv.y / 2;
        uniformsForThisIteration.strokeIterationNormalized = {
          value: brushIterations > 1 ? i / (brushIterations - 1) : 0,
        };
        uniformsForThisIteration.strokeTimePosition = { value: brushCenterTime };
        uniformsForThisIteration.strokePitchPosition = { value: brushCenterPitch };
        uniformsForThisIteration.strokeRandom = { value: strokeRandom };
        uniformsForThisIteration.strokeStepNormalized = {
          value: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
        };
        uniformsForThisIteration.strokePressure = { value: pressure };
        // Normalize tilt from [-90,90] degrees to [0,1] range (center=0.5)
        uniformsForThisIteration.strokeTiltX = { value: (tiltX + 90) / 180 };
        uniformsForThisIteration.strokeTiltY = { value: (tiltY + 90) / 180 };

        const material = effect.materials[p];
        this.fboMesh.material = material;

        const isFinalPassOfStep = passOrdinal === plannedPasses.length - 1;
        const isFinalPass = isFinalPassOfStep && isLastStep;
        const currentWriteFbo = isFinalPass ? destinationFbo : tempFboA;

        const inputTexture = currentReadFbo.texture;

        // The "source" on the first pass of the step is already set correctly in commonUniforms
        if (!isFirstOfStep) {
          uniformsForThisIteration.sourceSpectrogramTex = { value: inputTexture };
        }

        // The "destination" (for blending) is the original target only on the very first pass
        uniformsForThisIteration.destSpectrogramTex = {
          value: isFirstOfStep ? commonUniforms.destSpectrogramTex.value : inputTexture,
        };

        // Pass the mask if enabled (non-cumulative mode)
        if (!stepState.accumulate) {
          const currentMaskFbo = this.maskPingPong === 0 ? this.strokeMaskFbo : this.strokeMaskFbo2;
          (uniformsForThisIteration as any).useStrokeMask = { value: true };
          (uniformsForThisIteration as any).strokeMaskTex = { value: currentMaskFbo.texture };
          // Pass stroke start texture for blend calculations to prevent accumulation with additive blend modes
          (uniformsForThisIteration as any).blendOriginalTex = { value: this.strokeStartFbo.texture };
        } else {
          (uniformsForThisIteration as any).useStrokeMask = { value: false };
          (uniformsForThisIteration as any).strokeMaskTex = { value: this.textures.placeholderTexture };
          (uniformsForThisIteration as any).blendOriginalTex = { value: this.textures.placeholderTexture };
        }

        effect.updateEffectUniforms({
          commonUniforms: uniformsForThisIteration,
          passIndex: p,
          file: sourceFile,
          state: effectState,
        });

        this.gl.setRenderTarget(currentWriteFbo);
        this.gl.render(this.fboScene, this.camera);

        currentReadFbo = currentWriteFbo;

        if (!isFinalPass) {
          [tempFboA, tempFboB] = [tempFboB, tempFboA];
        }
      }

      // The output of this step becomes the input for the next step
      stepInputFbo = currentReadFbo;
    }

    this.gl.setRenderTarget(null);

    // For committed scissored strokes, fold the freshly painted rows back into
    // the canonical read buffer. This region blit is brush-sized, not
    // full-texture, which is what keeps small-brush cost flat as files grow.
    if (committedScissor && scissorRows) {
      this.blitFBORows(destinationFbo, currentReadFBO, scissorRows.rowStart, scissorRows.rowCount);
    }

    // Reset scissor on FBOs if it was enabled
    if (scissorRows) {
      destinationFbo.scissorTest = false;
      this.passFbo1.scissorTest = false;
      this.passFbo2.scissorTest = false;
      this.modulatorFbo.scissorTest = false;
    }

    // If the stroke is not a preview, commit the changes
    if (!preview) {
      // A committed scissored stroke already folded its result into the
      // canonical buffer via copy-back, so the ping-pong must NOT swap;
      // currentReadFBO stays canonical. Every other committed stroke (including
      // the legacy full-blit path) wrote the whole destinationFbo and swaps.
      if (!committedScissor) {
        this.pingPong = 1 - this.pingPong;
      }

      // Update stroke mask for non-cumulative mode. Any step being non-accumulate
      // means the per-step gate in the render loop will sample the mask for that
      // step, so we need a fresh composite covering every non-accumulate step.
      // updateStrokeMask is a no-op when every step is accumulate.
      let anyNonAccumulate = false;
      for (let i = 0; i < numSteps; i++) {
        if (!createStepStateView(state, i).accumulate) {
          anyNonAccumulate = true;
          break;
        }
      }
      if (anyNonAccumulate) {
        this.updateStrokeMask(state, cursorPos, bpm, totalDuration, strokeRandom, pressure, tiltX, tiltY);
      }

      // Update dirty region to include this stroke's bounds
      const dirtyFp = this.resolveBrushFootprint(activeStepState, bpm, totalDuration, cursorPos.x);
      const dirtyAnchor = resolveBrushAnchor(cursorPos, dirtyFp.fullTime, dirtyFp.fullPitch);
      const strokeStartX = dirtyAnchor.x;
      const strokeEndX = dirtyAnchor.x + dirtyFp.sizeUv.x;
      const strokeStartY = dirtyAnchor.y;
      const strokeEndY = dirtyAnchor.y + dirtyFp.sizeUv.y;

      if (this.dirtyRegion) {
        this.dirtyRegion.startX = Math.min(this.dirtyRegion.startX, strokeStartX);
        this.dirtyRegion.endX = Math.max(this.dirtyRegion.endX, strokeEndX);
        this.dirtyRegion.startY = Math.min(this.dirtyRegion.startY, strokeStartY);
        this.dirtyRegion.endY = Math.max(this.dirtyRegion.endY, strokeEndY);
      } else {
        this.dirtyRegion = {
          startX: strokeStartX,
          endX: strokeEndX,
          startY: strokeStartY,
          endY: strokeEndY,
        };
      }

      // A dab changes pixels only within its brush footprint, so accumulate the
      // footprint for the history delta regardless of whether the GPU scissored
      // the render (a full-band dab still has a bounded time window).
      this.committedTimeMin = Math.min(this.committedTimeMin, strokeStartX);
      this.committedTimeMax = Math.max(this.committedTimeMax, strokeEndX);
      this.committedPitchMin = Math.min(this.committedPitchMin, strokeStartY);
      this.committedPitchMax = Math.max(this.committedPitchMax, strokeEndY);

      this.fboDataDirty = true;
    }
  }

  /**
   * Update the stroke mask for non-cumulative mode.
   * Iterates every non-accumulate step so each step's envelope/intensity
   * contribution is composited into the mask (via max in the shader). A pure
   * no-op when every step is set to accumulate.
   */
  private updateStrokeMask(
    state: State,
    cursorPos: Vector2,
    bpm: number,
    totalDuration: number,
    strokeRandom: number,
    pressure: number,
    tiltX: number,
    tiltY: number,
  ): void {
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    const numSteps = steps.length;
    if (numSteps === 0) return;

    const { placeholderTexture, modulator1Texture, modulator2Texture, modulator3Texture, modulatorScaleLut } =
      this.textures;

    const uniforms = this.maskMaterial.uniforms;

    // Bind invariants (same for every step) once.
    uniforms.destMetadataTex.value = this.textures.metadataTex;
    uniforms.destInverseMapTex.value = this.textures.inverseMapTex;
    uniforms.destSpectrogramTextureSize.value = this.spectrogramData.packedTextureSize;
    uniforms.destFrameCount.value = this.spectrogramData.numFrames;
    uniforms.destBandCount.value = this.spectrogramData.numBands;
    uniforms.gainLut.value = modulatorScaleLut || placeholderTexture;
    uniforms.modulator1ImageTex.value = modulator1Texture || placeholderTexture;
    uniforms.modulator2ImageTex.value = modulator2Texture || placeholderTexture;
    uniforms.modulator3ImageTex.value = modulator3Texture || placeholderTexture;
    uniforms.strokeIterationNormalized.value = 1;
    uniforms.strokeRandom.value = strokeRandom;
    uniforms.strokePressure.value = pressure;
    uniforms.strokeTiltX.value = (tiltX + 90) / 180;
    uniforms.strokeTiltY.value = (tiltY + 90) / 180;

    // Fill the preallocated macro buffer in place — the uniform slot was wired
    // to this.maskMacroValuesBuf at construction time.
    const macros = state.brushes[state.activeBrushIndex]?.macroValues ?? [50, 50, 50, 50];
    for (let i = 0; i < 4; i++) this.maskMacroValuesBuf[i] = (macros[i] ?? 50) / 100;

    this.fboMesh.material = this.maskMaterial;

    let renderedAny = false;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const stepState = createStepStateView(state, stepIndex);
      if (stepState.accumulate) continue;

      const footprint = this.resolveBrushFootprint(stepState, bpm, totalDuration, cursorPos.x);
      const brushSizeUv = footprint.sizeUv;
      const brushAnchor = resolveBrushAnchor(cursorPos, footprint.fullTime, footprint.fullPitch);

      // Modulator params are per-step; rebuild for each step.
      const modulatorUniforms = buildModulatorUniforms(
        bpm,
        totalDuration,
        this.spectrogramData.bandsPerOctave,
        this.spectrogramData.numBands,
        stepState,
      );
      uniforms.modulators.value = modulatorUniforms;
      uniforms.modulator1SeqDataTex.value = modulatorUniforms[0]?.seqDataTex || placeholderTexture;
      uniforms.modulator2SeqDataTex.value = modulatorUniforms[1]?.seqDataTex || placeholderTexture;
      uniforms.modulator3SeqDataTex.value = modulatorUniforms[2]?.seqDataTex || placeholderTexture;

      uniforms.strokeTimePosition.value = footprint.fullTime ? cursorPos.x : brushAnchor.x + brushSizeUv.x / 2;
      uniforms.strokePitchPosition.value = footprint.fullPitch ? cursorPos.y : brushAnchor.y + brushSizeUv.y / 2;
      uniforms.strokeStepNormalized.value = numSteps > 1 ? stepIndex / (numSteps - 1) : 0;

      (uniforms.brushBottomLeftUv.value as Vector2).copy(brushAnchor);
      (uniforms.brushSizeUv.value as Vector2).copy(brushSizeUv);

      writeModulatableParam(
        uniforms.brushIntensity.value as ParameterUniform,
        (stepState.brushIntensity as number) / 100,
        0,
        1,
        stepState,
        "brushIntensity",
      );
      writeModulatableParam(
        uniforms.brushCurveTime.value as ParameterUniform,
        (stepState.brushCurveTime as number) / 100,
        -1,
        1,
        stepState,
        "brushCurveTime",
      );
      writeModulatableParam(
        uniforms.brushSkewTime.value as ParameterUniform,
        ((stepState.brushSkewTime as number) + 100) / 200,
        0,
        1,
        stepState,
        "brushSkewTime",
      );
      writeModulatableParam(
        uniforms.brushCurvePitch.value as ParameterUniform,
        (stepState.brushCurvePitch as number) / 100,
        -1,
        1,
        stepState,
        "brushCurvePitch",
      );
      writeModulatableParam(
        uniforms.brushSkewPitch.value as ParameterUniform,
        ((stepState.brushSkewPitch as number) + 100) / 200,
        0,
        1,
        stepState,
        "brushSkewPitch",
      );

      // The mask shader samples the precomputed modulator textures (via
      // getBrushWeight / applyModulation), so render them for this step first,
      // then restore the mask material as the active program. Skip the pass when
      // nothing routes to a modulator (zero placeholder yields the same result).
      if (hasActiveModulatorRouting(stepState)) {
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        this.renderModulatorTextures(uniforms as unknown as CommonUniforms);
        uniforms.modulatorTex0.value = this.modulatorFbo.textures[0];
        uniforms.modulatorTex1.value = this.modulatorFbo.textures[1];
      } else {
        uniforms.modulatorTex0.value = this.textures.placeholderTexture;
        uniforms.modulatorTex1.value = this.textures.placeholderTexture;
      }
      this.fboMesh.material = this.maskMaterial;

      const currentMaskFbo = this.maskPingPong === 0 ? this.strokeMaskFbo : this.strokeMaskFbo2;
      const nextMaskFbo = this.maskPingPong === 0 ? this.strokeMaskFbo2 : this.strokeMaskFbo;
      uniforms.currentMaskTex.value = currentMaskFbo.texture;

      this.gl.setRenderTarget(nextMaskFbo);
      this.gl.render(this.fboScene, this.camera);

      this.maskPingPong = 1 - this.maskPingPong;
      renderedAny = true;
    }

    if (renderedAny) this.gl.setRenderTarget(null);
  }

  /**
   * Get the current FBO data asynchronously.
   */
  async getFBOData(): Promise<Float32Array> {
    if (this.fboDataCache && !this.fboDataDirty) {
      return this.fboDataCache;
    }

    const { packedTextureSize } = this.spectrogramData;
    const fboToRead = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const data = await readRenderTargetPixelsAsync(this.gl, fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y);

    this.fboDataCache = data;
    this.fboDataDirty = false;

    return data;
  }

  /**
   * Set the FBO data from an external source (e.g., for undo/redo).
   */
  setFBOData(data: Float32Array): void {
    const { packedTextureSize } = this.spectrogramData;

    this.releaseRollback();
    this.pingPong = 0;

    const dataTex = new DataTexture(data, packedTextureSize.x, packedTextureSize.y, RGBAFormat, FloatType);
    dataTex.needsUpdate = true;

    this.gl.initTexture(dataTex);

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    this.snapshotToStrokeStart(this.fbo1.texture);

    dataTex.dispose();

    this.fboDataDirty = true;
  }

  /**
   * Update only the texture rows covered by `pixelRanges` (a flat
   * [pixelStart, pixelCount, ...] list in packed-pixel indices) from `data`,
   * which must hold the full packed state. Both the committed FBO and the
   * stroke-start snapshot receive the rows, so when every pixel outside the
   * ranges already matches the FBO this is equivalent to setFBOData at a
   * fraction of the upload cost. Falls back to setFBOData when the ranges
   * span most of the texture.
   */
  patchFBOData(data: Float32Array, pixelRanges: Uint32Array): void {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;
    const height = packedTextureSize.y;

    let patchPixels = 0;
    let numRanges = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      if (pixelRanges[i + 1] === 0) continue;
      patchPixels += pixelRanges[i + 1];
      numRanges++;
    }
    if (patchPixels === 0) return;
    // Past roughly half the texture the gather plus scatter costs more than
    // just re-uploading everything.
    if (patchPixels >= width * height * 0.5) {
      this.setFBOData(data);
      return;
    }

    // Gather the ranges into one compact block, and record where each range
    // landed so the shader can scatter it back.
    const patch = new Float32Array(patchPixels * 4);
    const instances = new Uint32Array(numRanges * 3);
    let srcPixel = 0;
    let inst = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      const start = pixelRanges[i];
      const count = pixelRanges[i + 1];
      if (count === 0) continue;
      patch.set(data.subarray(start * 4, (start + count) * 4), srcPixel * 4);
      instances[inst * 3] = start;
      instances[inst * 3 + 1] = count;
      instances[inst * 3 + 2] = srcPixel;
      srcPixel += count;
      inst++;
    }

    const patchWidth = Math.min(width, patchPixels);
    const patchHeight = Math.ceil(patchPixels / patchWidth);
    const padded =
      patch.length === patchWidth * patchHeight * 4
        ? patch
        : (() => {
            const p = new Float32Array(patchWidth * patchHeight * 4);
            p.set(patch);
            return p;
          })();
    const patchTex = new DataTexture(padded, patchWidth, patchHeight, RGBAFormat, FloatType);
    patchTex.needsUpdate = true;
    this.gl.initTexture(patchTex);

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
    geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
    geometry.setAttribute("aRange", new InstancedBufferAttribute(instances, 3));
    geometry.instanceCount = numRanges;

    patchMaterial.uniforms.patchTex.value = patchTex;
    patchMaterial.uniforms.destWidth.value = width;
    patchMaterial.uniforms.destHeight.value = height;
    patchMaterial.uniforms.patchWidth.value = patchWidth;

    const mesh = new Mesh(geometry, patchMaterial);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);

    // Only the patched pixels are drawn, so the rest of the target must survive
    // the render — no clear.
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    for (const target of [committed, this.strokeStartFbo]) {
      this.gl.setRenderTarget(target);
      this.gl.render(scene, this.camera);
    }
    this.gl.setRenderTarget(null);
    this.gl.autoClear = prevAutoClear;

    geometry.dispose();
    patchTex.dispose();
    this.fboDataDirty = true;
  }

  /**
   * Get the current textures for reading.
   */
  getTextures(): {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  } {
    return {
      packed: this.pingPong === 0 ? this.fbo1 : this.fbo2,
      inverse: this.textures.inverseMapTex,
      metadata: this.textures.metadataTex,
      original: this.textures.originalPackedDataTex,
    };
  }

  /**
   * Get the display texture (for the React component to render).
   */
  getDisplayTexture(isPreview: boolean): Texture {
    const currentFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const nextFBO = this.pingPong === 0 ? this.fbo2 : this.fbo1;
    return isPreview ? nextFBO.texture : currentFBO.texture;
  }

  // Blocks until all GPU work submitted so far has finished. Lets opt-in paint
  // timing attribute true GPU cost to a stroke instead of just the JS dispatch.
  finishGpu(): void {
    this.gl.getContext().finish();
  }

  /**
   * Saves the current spectrogram so a run of committed strokes can be taken
   * back without touching history — what the Generate preview paints onto.
   * Calling it again while a snapshot is held restores that snapshot instead of
   * replacing it, so repeated previews always start from the same pixels.
   */
  captureRollback(): void {
    if (this.rollbackFbo) {
      this.blitFBO(this.rollbackFbo, this.pingPong === 0 ? this.fbo1 : this.fbo2);
    } else {
      this.rollbackFbo = this.createFBO(
        this.spectrogramData.textureWidth,
        this.spectrogramData.textureHeight,
        RGBAFormat,
      );
      this.blitFBO(this.pingPong === 0 ? this.fbo1 : this.fbo2, this.rollbackFbo);
    }
    this.fboDataDirty = true;
  }

  /** Whether a rollback snapshot is currently held. */
  hasRollback(): boolean {
    return this.rollbackFbo !== null;
  }

  /**
   * Puts the saved spectrogram back and drops the snapshot. Returns false when
   * there was nothing to restore.
   */
  restoreRollback(): boolean {
    if (!this.rollbackFbo) return false;
    this.blitFBO(this.rollbackFbo, this.pingPong === 0 ? this.fbo1 : this.fbo2);
    this.releaseRollback();
    this.dirtyRegion = null;
    this.fboDataDirty = true;
    return true;
  }

  /** Drops the snapshot, keeping whatever is currently painted. */
  releaseRollback(): void {
    this.rollbackFbo?.dispose();
    this.rollbackFbo = null;
  }

  /**
   * Begin a new stroke (snapshot current state).
   */
  beginStroke(): void {
    // Reset the committed footprint for the new stroke. Tied to the stroke
    // boundary (not dirtyRegion's clear) so every dab of this stroke folds into
    // one footprint that history reads at commit.
    this.committedTimeMin = Infinity;
    this.committedTimeMax = -Infinity;
    this.committedPitchMin = Infinity;
    this.committedPitchMax = -Infinity;
    this.strokeGeneration++;
  }

  getStrokeGeneration(): number {
    return this.strokeGeneration;
  }

  /**
   * The stroke's committed footprint in unpacked UV, or null when nothing was
   * committed. Time is [timeMin, timeMax]; pitch follows the same UV axis the
   * dirty region uses (0 = top of the texture).
   */
  getCommittedFootprintUv(): { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number } | null {
    if (this.committedTimeMax <= this.committedTimeMin) return null;
    return {
      timeMin: Math.max(0, this.committedTimeMin),
      timeMax: Math.min(1, this.committedTimeMax),
      pitchMin: Math.max(0, this.committedPitchMin),
      pitchMax: Math.min(1, this.committedPitchMax),
    };
  }

  /**
   * Widens the dirty region so the next synthesis covers pixels changed
   * outside the painted rect — boundary conditioning writes into a margin
   * around the stroke's time edges.
   */
  expandDirtyRegion(startX: number, endX: number, startY: number, endY: number): void {
    if (this.dirtyRegion) {
      this.dirtyRegion.startX = Math.min(this.dirtyRegion.startX, startX);
      this.dirtyRegion.endX = Math.max(this.dirtyRegion.endX, endX);
      this.dirtyRegion.startY = Math.min(this.dirtyRegion.startY, startY);
      this.dirtyRegion.endY = Math.max(this.dirtyRegion.endY, endY);
    } else {
      this.dirtyRegion = { startX, endX, startY, endY };
    }
  }

  /**
   * Packed-pixel ranges the current stroke's committed footprint covers, as a
   * flat [pixelStart, pixelCount, ...] list — one range per band, mapping the
   * footprint's time window into each band's packed segment. Returns null when
   * nothing was committed, so history stores a full snapshot.
   */
  getDirtyPixelRanges(): Uint32Array | null {
    if (this.committedTimeMax <= this.committedTimeMin) return null;

    const { numBands, metadata } = this.spectrogramData;
    const pitchMargin = 4;
    const highBand = Math.min(
      numBands - 1,
      Math.floor(pitchUvToBandIndex(this.committedPitchMin, numBands)) + pitchMargin,
    );
    const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(this.committedPitchMax, numBands)) - pitchMargin);
    const t0 = Math.max(0, this.committedTimeMin);
    const t1 = Math.min(1, this.committedTimeMax);
    const timeMargin = 4;

    const ranges: number[] = [];
    for (let b = lowBand; b <= highBand; b++) {
      const offset = Math.round(metadata[b * 4]);
      const length = Math.round(metadata[b * 4 + 1]);
      const start = Math.max(offset, offset + Math.floor(t0 * length) - timeMargin);
      const end = Math.min(offset + length, offset + Math.ceil(t1 * length) + timeMargin);
      if (end > start) ranges.push(start, end - start);
    }
    return ranges.length ? new Uint32Array(ranges) : null;
  }

  /**
   * End the current stroke (prepare for next stroke).
   */
  endStroke(): void {
    // Snapshot the result of the stroke to strokeStartFbo
    const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    this.snapshotToStrokeStart(currentReadFBO.texture);

    // Clear both Mask FBOs and reset ping-pong
    const oldClearColor = new Color();
    this.gl.getClearColor(oldClearColor);
    const oldClearAlpha = this.gl.getClearAlpha();
    this.gl.setClearColor(0x000000, 0);

    this.gl.setRenderTarget(this.strokeMaskFbo);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(this.strokeMaskFbo2);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(null);

    this.gl.setClearColor(oldClearColor, oldClearAlpha);
    this.maskPingPong = 0;
  }

  /**
   * Restore to original state.
   */
  restoreOriginal(): void {
    this.isInitialized = false;
    this.fboDataDirty = true;
    this.dirtyRegion = null;
  }

  /**
   * Check if the renderer is initialized.
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the dirty region (bounding box of all strokes since last clear).
   * Returns UV coordinates (0-1 range).
   */
  getDirtyRegion(): { startX: number; endX: number; startY: number; endY: number } | null {
    return this.dirtyRegion;
  }

  /**
   * Clear the dirty region tracking.
   */
  clearDirtyRegion(): void {
    this.dirtyRegion = null;
  }

  /**
   * Dispose of all WebGL resources.
   */
  dispose(): void {
    this.releaseRollback();
    this.fbo1.dispose();
    this.fbo2.dispose();
    this.passFbo1.dispose();
    this.passFbo2.dispose();
    this.strokeMaskFbo.dispose();
    this.strokeMaskFbo2.dispose();
    this.strokeStartFbo.dispose();
    this.modulatorFbo.dispose();
    this.maskMaterial.dispose();
    this.modulatorMaterial.dispose();
  }
}
