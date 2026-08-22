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
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { copyMaterial } from "../components/copy-material";
import { gatherMaterial } from "../components/gather-material";
import { patchMaterial } from "../components/patch-material";
import { phaseTurnMaterial } from "../components/phase-turn-material";
import { BaseEffect, CommonUniforms, createDefaultUniforms } from "../effects/base-effect";
import maskUpdateFrag from "../glsl/mask-update.frag";
import modulatorPrecomputeFrag from "../glsl/modulator-precompute.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { createEffectStateView, createStepStateView } from "../store";
import { hasActiveModulatorRouting, hasNestedModulatorRouting, paramsRouteModulators } from "../store/modulators";
import type { ParameterKey, SpectrogramData, State } from "../store/types";
import type { ParameterUniform } from "../types";
import { readRenderTargetPixelsAsync } from "./async-readpixels";
import { ATTRACT_MODULATOR_MAP_START } from "./constants";
import { getFileOnsets } from "./file-onsets";
import { buildModulatorUniforms } from "./modulator-utils";
import {
  brushFootprintRanges,
  fullTextureRange,
  FrameWindow,
  PixelRangeList,
  RangeQuadGeometry,
  rowRange,
} from "./range-quads";
import {
  createModContext,
  defaultParameterUniform,
  ModContext,
  parameterUniform,
  ShaderRange,
  staticModulation,
  StrokeContext,
  writeParameterUniform,
} from "./static-modulation";
import { getStrokeScratchPool, StrokeScratch, StrokeScratchPool } from "./stroke-scratch-pool";
import {
  pitchUvToBandIndex,
  resolveBrushAnchor,
  resolveBrushFootprint,
  sourceBandUvSlope,
  swungGridCellWidthUv,
} from "./utils";

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

const createParameterUniform = defaultParameterUniform;

// Bins of margin around the brush's time window in the final-pass footprint,
// covering the sub-bin fallback and the float32 rounding of band offsets.
const FOOTPRINT_MARGIN_BINS = 4;

// Copies the pixels of the drawn ranges from inputTex into the bound target.
const rangeCopyMaterial = new RawShaderMaterial({
  uniforms: {
    inputTex: { value: null },
    destSpectrogramTextureSize: { value: new Vector2(1, 1) },
  },
  vertexShader: rangeQuadVert,
  fragmentShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    uniform sampler2D inputTex;
    out vec4 outColor;

    void main() {
      outColor = texelFetch(inputTex, ivec2(gl_FragCoord.xy), 0);
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});

// Fraction of the texture above which a stroke's footprint is written by a
// whole-texture draw and a buffer swap, rather than folded back by a copy.
const SWAP_FOOTPRINT_FRACTION = 0.5;

/** The packed pixels a stroke's final pass writes, and the bins they hold per band. */
export interface StrokeFootprint extends PixelRangeList {
  binRanges: Float32Array;
  pixels: number;
}

/** Shader-unit ranges of the brush-level parameters, whose sliders run in percent. */
const BRUSH_SHADER_RANGES = {
  brushCurveTime: (step: State): ShaderRange => ({ value: (step.brushCurveTime as number) / 100, min: -1, max: 1 }),
  brushSkewTime: (step: State): ShaderRange => ({
    value: ((step.brushSkewTime as number) + 100) / 200,
    min: 0,
    max: 1,
  }),
  brushCurvePitch: (step: State): ShaderRange => ({ value: (step.brushCurvePitch as number) / 100, min: -1, max: 1 }),
  brushSkewPitch: (step: State): ShaderRange => ({
    value: ((step.brushSkewPitch as number) + 100) / 200,
    min: 0,
    max: 1,
  }),
  brushIntensity: (step: State): ShaderRange => ({ value: step.brushIntensity / 100, min: 0, max: 1 }),
  brushPan: (step: State): ShaderRange => ({ value: step.brushPan / 100, min: -1, max: 1 }),
} satisfies Partial<Record<ParameterKey, (step: State) => ShaderRange>>;

type BrushRangeKey = keyof typeof BRUSH_SHADER_RANGES;

// Source offsets read relative to the brush and carry no modulation in follow mode.
function sourceOffsetUniform(
  step: State,
  key: "sourceTimeOffset" | "sourcePitchOffset",
  ctx: ModContext,
): ParameterUniform {
  if (step.sourcePositionMode === "follow") return defaultParameterUniform(0, -1, 1);
  return parameterUniform(step, key, ctx, { value: (step[key] as number) / 100, min: -1, max: 1 });
}

function brushParamUniform(step: State, key: BrushRangeKey, ctx: ModContext): ParameterUniform {
  return parameterUniform(step, key, ctx, BRUSH_SHADER_RANGES[key](step));
}

// Brush-level modulatable uniforms whose static term is refreshed per iteration.
// Source offsets carry no modulation in follow mode.
const BRUSH_PARAM_UNIFORMS: Array<{ uniform: keyof CommonUniforms; key: ParameterKey; followZero: boolean }> = [
  { uniform: "brushCurveTime", key: "brushCurveTime", followZero: false },
  { uniform: "brushSkewTime", key: "brushSkewTime", followZero: false },
  { uniform: "brushCurvePitch", key: "brushCurvePitch", followZero: false },
  { uniform: "brushSkewPitch", key: "brushSkewPitch", followZero: false },
  { uniform: "brushIntensity", key: "brushIntensity", followZero: false },
  { uniform: "brushPan", key: "brushPan", followZero: false },
  { uniform: "sourceTimeOffset", key: "sourceTimeOffset", followZero: true },
  { uniform: "sourcePitchOffset", key: "sourcePitchOffset", followZero: true },
];

function writeBrushParamStatics(uniforms: CommonUniforms, step: State, ctx: ModContext): void {
  const follow = step.sourcePositionMode === "follow";
  for (const { uniform, key, followZero } of BRUSH_PARAM_UNIFORMS) {
    const target = (uniforms[uniform] as { value: ParameterUniform }).value;
    if (followZero && follow) {
      target.staticSum = 0;
      target.staticWeight = 0;
      continue;
    }
    const { staticSum, staticWeight } = staticModulation(step, key, target.minValue, target.maxValue, ctx);
    target.staticSum = staticSum;
    target.staticWeight = staticWeight;
  }
}

/**
 * Textures required for stroke rendering
 */
export interface StrokeTextures {
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
  // Per-stroke scratch targets, shared across all files through the pool.
  // Bound (and refreshed if another file painted since) by acquireScratch().
  private pool: StrokeScratchPool;
  private scratch: StrokeScratch | null = null;

  // Scene objects
  private fboScene: Scene;
  private fboMesh: Mesh;
  // Instanced range quads: every effect, mask and modulator pass draws only
  // the packed pixel ranges set on it.
  private rangeScene: Scene;
  private rangeMesh: Mesh;
  private rangeGeometry: RangeQuadGeometry;
  private camera: Camera;

  // Materials
  private maskMaterial: RawShaderMaterial;
  private modulatorMaterial: RawShaderMaterial;

  // State
  // The spectrogram as it was before a preview run of committed strokes.
  // Allocated only while a preview is up.
  private rollbackFbo: WebGLRenderTarget | null = null;
  private pingPong = 0;
  private maskPingPong = 0;
  private isInitialized = false;
  // The footprint of the stroke being rendered. Its ranges and bin ranges are
  // reused across dabs.
  private footprint: StrokeFootprint;
  // Per-band bin ranges the ping-pong partner holds a preview for, as the
  // display's lookup texture. Cleared (and previewActive dropped) on commit.
  private previewRangeTex: DataTexture;
  private previewActive = false;
  // Union of the packed rows [rowStart, rowEnd) every dab since the masks were
  // last cleared has written. Outside it both mask buffers are still zero, so a
  // mask update drawn over it alone loses nothing across the ping-pong.
  private maskRows: { rowStart: number; rowEnd: number } | null = null;
  // Set when the scratch targets were (re)allocated and no stroke has yet
  // confirmed the driver accepted them.
  private scratchUnverified = false;

  // Test seam: forces every stroke onto the legacy full-texture render +
  // ping-pong-swap path instead of the footprint draw and copy-back, and the
  // stroke mask onto a full-texture update, so equivalence between the two
  // can be asserted.
  disableScissorCopyBack = false;

  // FBO data cache
  private fboDataCache: Float32Array | null = null;
  private fboDataDirty = true;
  // Bumped on every change to the FBO contents. getFBOData() captures it before
  // its readback and keeps the result only if it still matches, so paint that
  // lands mid-read cannot leave a snapshot taken before it marked clean.
  private fboDataEpoch = 0;

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

    const { textureWidth, textureHeight, numBands } = spectrogramData;

    this.rangeScene = new Scene();
    this.rangeGeometry = new RangeQuadGeometry(numBands * 3);
    this.rangeMesh = new Mesh(this.rangeGeometry.geometry);
    this.rangeMesh.frustumCulled = false;
    this.rangeScene.add(this.rangeMesh);

    this.footprint = {
      ranges: new Uint32Array(numBands * 6),
      count: 0,
      binRanges: new Float32Array(numBands * 4),
      pixels: 0,
    };
    this.previewRangeTex = new DataTexture(this.footprint.binRanges, numBands, 1, RGBAFormat, FloatType);
    this.previewRangeTex.minFilter = NearestFilter;
    this.previewRangeTex.magFilter = NearestFilter;
    this.previewRangeTex.needsUpdate = true;

    // Create FBOs

    this.fbo1 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.fbo2 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.pool = getStrokeScratchPool(gl);

    // Modulator precompute material — evaluates all modulators per pixel into
    // the scratch modulatorFbo's two targets. Reuses the common-uniform set so
    // the same modulator/source/dest uniforms drive it as the effects.
    this.modulatorMaterial = new RawShaderMaterial({
      uniforms: { ...createDefaultUniforms(), nestedModulationActive: { value: false } },
      vertexShader: rangeQuadVert,
      fragmentShader: modulatorPrecomputeFrag,
      glslVersion: GLSL3,
    });

    // Create mask material
    this.maskMaterial = new RawShaderMaterial({
      uniforms: {
        ...createDefaultUniforms(),
        currentMaskTex: { value: null },
        destMetadataTex: { value: null },
        destInverseMapTex: { value: null },
        destSpectrogramTextureSize: { value: new Vector2(1, 1) },
        destFrameCount: { value: 0 },
        destBandCount: { value: 0 },
        brushBottomLeftUv: { value: new Vector2(0, 0) },
        brushSizeUv: { value: new Vector2(0, 0) },
      },
      vertexShader: rangeQuadVert,
      fragmentShader: maskUpdateFrag,
      glslVersion: GLSL3,
    });

    // The mask material mutates these ParameterUniform objects in place on the hot
    // path, so it holds its own rather than the per-step objects the effects get.
    const mu = this.maskMaterial.uniforms;
    mu.brushIntensity = { value: createParameterUniform(1, 0, 1) };
    mu.brushCurveTime = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewTime = { value: createParameterUniform(0.5, 0, 1) };
    mu.brushCurvePitch = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewPitch = { value: createParameterUniform(0.5, 0, 1) };
  }

  /**
   * Draws `material` over the packed pixel ranges of `list` into `target`,
   * leaving every other pixel of the target as it was.
   */
  private drawRanges(material: RawShaderMaterial, target: WebGLRenderTarget, list: PixelRangeList): void {
    if (list.count === 0) return;
    this.rangeGeometry.setRanges(list);
    const size = this.spectrogramData.packedTextureSize;
    if (material.uniforms.destSpectrogramTextureSize) {
      material.uniforms.destSpectrogramTextureSize.value = size;
    } else {
      material.uniforms.destSpectrogramTextureSize = { value: size };
    }
    this.rangeMesh.material = material;
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    this.gl.setRenderTarget(target);
    this.gl.render(this.rangeScene, this.camera);
    this.gl.autoClear = prevAutoClear;
  }

  /** The whole packed texture as one range. */
  private fullRange(): PixelRangeList {
    const { textureWidth, textureHeight } = this.spectrogramData;
    return fullTextureRange(textureWidth, textureHeight);
  }

  /** Marks every bin of every band as holding a preview. */
  private markWholeTexturePreview(): void {
    const { numBands, metadata } = this.spectrogramData;
    const binRanges = this.footprint.binRanges;
    for (let band = 0; band < numBands; band++) {
      binRanges[band * 4] = 0;
      binRanges[band * 4 + 1] = metadata[band * 4 + 1];
    }
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

  private createFBO(width: number, height: number, format: typeof RGBAFormat | typeof RedFormat): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      format,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
  }

  /**
   * Evaluates every modulator's stereo output per pixel into the scratch
   * modulator MRT's two targets, using the step's common uniforms, over
   * `ranges`. Effects then sample these textures instead of
   * evaluating the modulators inline. Runs once per step. Returns the target.
   */
  private renderModulatorTextures(commonUniforms: CommonUniforms, ranges: PixelRangeList): WebGLRenderTarget {
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
    const target = this.pool.modulatorFbo();
    this.drawRanges(m, target, ranges);
    return target;
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
    copyMaterial.uniforms.inputTex.value = this.textures.originalPackedDataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    this.pingPong = 0;

    // The stroke-start snapshot no longer matches the reset canvas; force the
    // next acquireScratch to rebuild it.
    this.pool.disown(this);

    this.invalidateFboData();
    this.isInitialized = true;
  }

  /**
   * Binds the shared scratch targets to this renderer. When another file
   * painted since the last call (or the texture size changed), the masks are
   * cleared and the stroke-start snapshot is rebuilt from the committed state,
   * restoring the between-strokes invariants the paint path relies on.
   */
  private acquireScratch(): StrokeScratch {
    const { textureWidth, textureHeight } = this.spectrogramData;
    const { scratch, refreshed } = this.pool.acquire(this, textureWidth, textureHeight);
    this.scratch = scratch;
    if (refreshed) {
      this.clearMasks(scratch);
      this.maskPingPong = 0;
      const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
      this.snapshotToStrokeStart(scratch, currentReadFBO.texture);
      this.scratchUnverified = true;
    }
    return scratch;
  }

  /**
   * Throws when the driver refused the scratch allocations. The targets are
   * created lazily on first bind, so the refusal only shows up as a GL error
   * after the first stroke that uses them; the check runs once per refresh.
   */
  private verifyScratchAllocation(): void {
    if (!this.scratchUnverified) return;
    this.scratchUnverified = false;
    const context = this.gl.getContext();
    if (context.getError() === context.OUT_OF_MEMORY) {
      throw new Error("The graphics device ran out of memory allocating the stroke buffers.");
    }
  }

  private clearMasks(scratch: StrokeScratch): void {
    const oldClearColor = new Color();
    this.gl.getClearColor(oldClearColor);
    const oldClearAlpha = this.gl.getClearAlpha();
    this.gl.setClearColor(0x000000, 0);
    this.gl.setRenderTarget(scratch.strokeMaskFbo);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(scratch.strokeMaskFbo2);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(null);
    this.gl.setClearColor(oldClearColor, oldClearAlpha);
    this.maskRows = null;
  }

  /**
   * Snapshot the current FBO state to the strokeStartFbo.
   */
  private snapshotToStrokeStart(scratch: StrokeScratch, sourceTexture: Texture): void {
    const prevMaterial = this.fboMesh.material;

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = sourceTexture;

    const oldTarget = this.gl.getRenderTarget();
    this.gl.setRenderTarget(scratch.strokeStartFbo);
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
    ctx: ModContext,
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
      ctx,
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
      brushCurveTime: { value: brushParamUniform(stepState, "brushCurveTime", ctx) },
      brushSkewTime: { value: brushParamUniform(stepState, "brushSkewTime", ctx) },
      brushCurvePitch: { value: brushParamUniform(stepState, "brushCurvePitch", ctx) },
      brushSkewPitch: { value: brushParamUniform(stepState, "brushSkewPitch", ctx) },
      brushSizeUv: { value: brushSizeUv },
      brushIntensity: { value: brushParamUniform(stepState, "brushIntensity", ctx) },
      brushPan: { value: brushParamUniform(stepState, "brushPan", ctx) },
      bpm: { value: bpm },
      sourceOffsetX: { value: sourceOffsetUv.x },
      sourceOffsetY: { value: sourceOffsetUv.y },
      // Beat-based scale: 1 beat in dest UV = 1 beat in source UV
      sourceTimeScale: {
        value: (() => {
          const sourceDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;
          const divisor = sourceBpm * sourceDuration;
          return divisor > 0 ? (bpm * totalDuration) / divisor : 1;
        })(),
      },
      sourceBandScale: {
        value:
          sourceFile.spectrogramData.numBands > 0
            ? this.spectrogramData.numBands / sourceFile.spectrogramData.numBands
            : 1,
      },
      sourceTimeOffset: { value: sourceOffsetUniform(stepState, "sourceTimeOffset", ctx) },
      sourcePitchOffset: { value: sourceOffsetUniform(stepState, "sourcePitchOffset", ctx) },
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
    };
  }

  /**
   * The packed band indices [lowBand, highBand] a brush of the given UV extent
   * can paint, widened by the neighbouring bands effects sample.
   */
  brushBandRange(brushBottomLeftUv: Vector2, brushSizeUv: Vector2): { lowBand: number; highBand: number } {
    const { numBands } = this.spectrogramData;

    // Band indices count down in frequency, so the brush's low pitch edge is
    // the highest index.
    const brushLowPitchY = brushBottomLeftUv.y;
    const brushHighPitchY = brushBottomLeftUv.y + brushSizeUv.y;

    const margin = 4;
    const highBand = Math.min(numBands - 1, Math.floor(pitchUvToBandIndex(brushLowPitchY, numBands)) + margin);
    const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(brushHighPitchY, numBands)) - margin);
    return { lowBand, highBand };
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
    const { lowBand, highBand } = this.brushBandRange(brushBottomLeftUv, brushSizeUv);

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
   * The packed pixels a stroke's final pass writes: the bins of every band in
   * the brush's pitch extent that fall in its time window, with margins.
   * `wholeBands` spreads it over every band and a null `window` over every
   * bin. Returns null when the whole texture is to be drawn instead.
   */
  calculateFootprint(
    brushBottomLeftUv: Vector2,
    brushSizeUv: Vector2,
    window: FrameWindow,
    wholeBands: boolean,
  ): StrokeFootprint | null {
    const { numBands } = this.spectrogramData;
    const bands = wholeBands
      ? { lowBand: 0, highBand: numBands - 1 }
      : this.brushBandRange(brushBottomLeftUv, brushSizeUv);
    const footprint = this.footprint;
    footprint.count = brushFootprintRanges(
      this.spectrogramData,
      bands.lowBand,
      bands.highBand,
      window,
      FOOTPRINT_MARGIN_BINS,
      footprint.ranges,
      footprint.binRanges,
    );
    footprint.pixels = 0;
    for (let i = 0; i < footprint.count; i++) footprint.pixels += footprint.ranges[i * 2 + 1];
    return footprint;
  }

  /**
   * Render a brush stroke.
   */
  renderStroke(params: StrokeParams, state: State, sourceFile: SourceFileInfo): void {
    if (!this.isInitialized) {
      this.initialize();
    }
    const scratch = this.acquireScratch();

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

    // Every source-space conversion below divides by the source's duration and
    // band count, so an empty source would put NaN coordinates into the shaders
    // and write corrupted coefficients over the destination.
    const sourceSpec = sourceFile.spectrogramData;
    if (!(sourceSpec.numFrames > 0) || !(sourceSpec.numBands > 0) || !(sourceSpec.sampleRate > 0)) return;

    const activeStepState = createStepStateView(state, state.activeStepIndex);
    const activeStep = (state.brushes[state.activeBrushIndex]?.steps ?? [])[state.activeStepIndex];

    // Beat-based scale: converts dest UV to source UV so 1 beat = 1 beat
    const srcBpm = state.filepathsBpm?.[sourceFile.filePath] || bpm;
    const srcDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;
    const timeScale = (bpm * totalDuration) / (srcBpm * srcDuration);
    const bandScale = sourceBandUvSlope(this.spectrogramData, sourceFile.spectrogramData);

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

    let tempFboA = scratch.passFbo1;
    let tempFboB = scratch.passFbo2;

    // For multi-step rendering, we iterate through all steps sequentially
    let stepInputFbo: WebGLRenderTarget | { texture: DataTexture } = initialSourceFbo;

    // Non-cumulative strokes: use snapshot as source to prevent self-feedback.
    // Gated by step 0's flags since step 0 is the step that actually consumes
    // initialSourceFbo; subsequent steps read each other's output.
    const firstStepState = createStepStateView(state, 0);
    if (!firstStepState.accumulate && isSameFile && firstStepState.sourceDataMode !== "original") {
      stepInputFbo = scratch.strokeStartFbo;
      initialSourceFbo = scratch.strokeStartFbo;
    }

    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    const numSteps = steps.length;

    // The brush extent across all steps, in pitch and in time. A step that
    // wraps an axis with its brush crossing the [0,1] boundary paints at both
    // ends of that axis, so the extent becomes the whole axis. When any step is
    // Full on an axis the union anchor collapses to 0 and the extent reaches 1.
    const maxBrushSizeUv = new Vector2(0, 0);
    const unionAnchor = new Vector2(cursorPos.x, cursorPos.y);
    let yWrapsOutOfBounds = false;
    let wholeTime = false;
    for (let i = 0; i < numSteps; i++) {
      const s = createStepStateView(state, i);
      const fp = this.resolveBrushFootprint(s, bpm, totalDuration, cursorPos.x);
      maxBrushSizeUv.x = Math.max(maxBrushSizeUv.x, fp.sizeUv.x);
      maxBrushSizeUv.y = Math.max(maxBrushSizeUv.y, fp.sizeUv.y);
      if (fp.fullTime) unionAnchor.x = 0;
      if (fp.fullPitch) unionAnchor.y = 0;
      if (fp.fullTime) wholeTime = true;
      const wrapMode = s.brushWrapMode as number;
      const wrapsY = wrapMode === 2 || wrapMode === 3;
      const wrapsX = wrapMode === 1 || wrapMode === 3;
      const stepAnchorY = fp.fullPitch ? 0 : cursorPos.y;
      const stepAnchorX = fp.fullTime ? 0 : cursorPos.x;
      if (wrapsY && (stepAnchorY < 0 || stepAnchorY + fp.sizeUv.y > 1)) {
        yWrapsOutOfBounds = true;
      }
      if (wrapsX && (stepAnchorX < 0 || stepAnchorX + fp.sizeUv.x > 1)) {
        wholeTime = true;
      }
    }

    // Every pass but the last is read by the passes after it, with whatever
    // reach in time their effect has, so those passes write the brush's full
    // packed rows. The last pass is only ever read at the pixels it paints, so
    // it writes the brush footprint alone. The brush's time window is rounded
    // to frames the way the brush shader rounds it.
    const scissorRows = yWrapsOutOfBounds ? null : this.calculateScissorRows(unionAnchor, maxBrushSizeUv);
    const { textureWidth, numFrames } = this.spectrogramData;
    const window: FrameWindow = wholeTime
      ? null
      : {
          frameStart: Math.floor(unionAnchor.x * numFrames + 0.5),
          frameEnd: Math.floor((unionAnchor.x + maxBrushSizeUv.x) * numFrames + 0.5),
        };
    const footprint = this.disableScissorCopyBack
      ? null
      : this.calculateFootprint(unionAnchor, maxBrushSizeUv, window, yWrapsOutOfBounds);
    const passRanges = scissorRows
      ? rowRange(textureWidth, scissorRows.rowStart, scissorRows.rowCount)
      : this.fullRange();
    // A footprint that covers most of the texture is cheaper to write with a
    // whole-texture draw and a buffer swap than to copy back, and with no
    // rows every pass has written the whole texture, so the swap is sound.
    const { textureHeight } = this.spectrogramData;
    const swapWhole =
      footprint !== null &&
      scissorRows === null &&
      footprint.pixels >= SWAP_FOOTPRINT_FRACTION * textureWidth * textureHeight;
    const copyBack = footprint !== null && !swapWhole;
    // On the legacy path the partner buffer is swapped (or shown) in whole, so
    // the rows the passes leave alone are copied over first.
    const finalRanges = copyBack ? footprint : passRanges;
    if (!footprint && scissorRows) {
      this.blitFBO(currentReadFBO, destinationFbo);
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

      // The Time/Pitch sources track the painted aim. On a full-size axis the
      // footprint anchors to 0, so the aim is read straight from the cursor.
      const stepContext: StrokeContext = {
        iteration: 0,
        time: stepFootprint.fullTime ? cursorPos.x : stepAnchor.x + stepBrushSizeUv.x / 2,
        pitch: stepFootprint.fullPitch ? cursorPos.y : stepAnchor.y + stepBrushSizeUv.y / 2,
        random: strokeRandom,
        step: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
        pressure,
        tiltX: (tiltX + 90) / 180,
        tiltY: (tiltY + 90) / 180,
      };
      const stepModContext = createModContext(stepState, stepContext);

      // Build common uniforms for this step
      const sourceBpm = state.filepathsBpm?.[sourceFile.filePath] || bpm;
      const commonUniforms = this.buildStepUniforms(
        stepState,
        stepModContext,
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

      // Get enabled effects in order for this step
      const stepEffects = stepState.effects as {
        id: string;
        effect: EffectType;
        enabled: boolean;
        params: Record<string, unknown>;
      }[];
      const enabledEffectItems = stepEffects.filter(({ enabled }) => enabled);

      // Precompute this step's modulator outputs into modulatorFbo, then point
      // the effect uniforms at the resulting textures. Done once per step before
      // any effect pass, so the expensive modulator evaluation happens once. When
      // nothing routes to a modulator, every consumer multiplies its output by
      // zero, so skip the pass and bind the zero placeholder instead. Effect
      // parameter amounts live on the effect item, not on the step, and
      // Attract's modulator maps read the textures with no amounts routed.
      const attractReadsModulators = enabledEffectItems.some(
        (item) =>
          item.effect === "attract" &&
          createEffectStateView(state, stepIndex, item).attractMap >= ATTRACT_MODULATOR_MAP_START,
      );
      const effectItemsRouteModulators = enabledEffectItems.some((item) => paramsRouteModulators(item.params));
      if (hasActiveModulatorRouting(stepState) || effectItemsRouteModulators || attractReadsModulators) {
        // Nested-modulation routing lives on the step (modulator amounts are
        // per-step parameters), so resolve the gate from the step state, not the
        // global state, before rendering this step's modulators.
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        const modulatorFbo = this.renderModulatorTextures(commonUniforms, passRanges);
        commonUniforms.modulatorTex0 = { value: modulatorFbo.textures[0] };
        commonUniforms.modulatorTex1 = { value: modulatorFbo.textures[1] };
      } else {
        commonUniforms.modulatorTex0 = { value: this.textures.placeholderTexture };
        commonUniforms.modulatorTex1 = { value: this.textures.placeholderTexture };
      }

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
        sourceTimeOffset: { value: defaultParameterUniform(0, -1, 1) },
        sourcePitchOffset: { value: defaultParameterUniform(0, -1, 1) },
      };

      // Reset currentReadFbo to the step's input for effect processing
      let currentReadFbo: WebGLRenderTarget | { texture: DataTexture } = stepInputFbo;

      const isLastStep = stepIndex === numSteps - 1;

      const brushIterations = stepState.brushIterations as number;

      // Flatten every (effect, iteration, pass) the step will render. Effects
      // drop passes that would be a no-op at the current settings, so first/last
      // pass bookkeeping has to count what actually renders, not what exists.
      const plannedPasses: {
        effect: BaseEffect;
        effectState: State;
        passIndex: number;
        iteration: number;
        inSwappedDomain: boolean;
      }[] = [];
      // A pass that moves the pair out of magnitude and phase leaves every pass
      // after it reading that domain, until one moves it back.
      let swapped = false;
      for (const effectItem of enabledEffectItems) {
        const effect = this.effects[effectItem.effect];
        if (!effect) continue;
        const effectState = createEffectStateView(state, stepIndex, effectItem);
        const activePasses = effect.getActivePasses?.(effectState) ?? effect.materials.map((_, index) => index);
        if (activePasses.length === 0) continue;
        for (let i = 0; i < brushIterations; i++) {
          for (const passIndex of activePasses) {
            plannedPasses.push({ effect, effectState, passIndex, iteration: i, inSwappedDomain: swapped });
            swapped = effect.domainAfter?.(effectState, swapped) ?? swapped;
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
            inSwappedDomain: false,
          });
        }
      }

      const iterationContexts = Array.from({ length: brushIterations }, (_, i) =>
        createModContext(stepState, { ...stepContext, iteration: brushIterations > 1 ? i / (brushIterations - 1) : 0 }),
      );
      let staticsIteration = -1;

      // Apply each planned pass in order
      for (let passOrdinal = 0; passOrdinal < plannedPasses.length; passOrdinal++) {
        const { effect, effectState, passIndex: p, iteration: i, inSwappedDomain } = plannedPasses[passOrdinal];
        const isFirstOfStep = passOrdinal === 0;
        const uniformsForThisIteration = isFirstOfStep ? { ...commonUniforms } : { ...iterativeUniforms };

        uniformsForThisIteration.inSwappedDomain = { value: inSwappedDomain };

        // The Iteration source moves between passes, so the static terms that
        // depend on it are refreshed when it changes. The brush-level uniforms
        // are shared across the pass copies, so writing them in place reaches
        // every pass.
        const iterationContext = iterationContexts[i];
        if (i !== staticsIteration) {
          writeBrushParamStatics(commonUniforms, stepState, iterationContext);
          staticsIteration = i;
        }

        const material = effect.materials[p];

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
          const currentMaskFbo = this.maskPingPong === 0 ? scratch.strokeMaskFbo : scratch.strokeMaskFbo2;
          (uniformsForThisIteration as any).useStrokeMask = { value: true };
          (uniformsForThisIteration as any).strokeMaskTex = { value: currentMaskFbo.texture };
        } else {
          (uniformsForThisIteration as any).useStrokeMask = { value: false };
          (uniformsForThisIteration as any).strokeMaskTex = { value: this.textures.placeholderTexture };
        }
        // The blend path reads this only for non-cumulative strokes, but an
        // effect undoing a domain swap needs the same snapshot either way.
        (uniformsForThisIteration as any).blendOriginalTex = { value: scratch.strokeStartFbo.texture };
        // Step 0 blends out of the stroke-start snapshot, so dabs over the same
        // area cannot accumulate. Every later step blends out of its own input,
        // which holds the previous step's output — blending those steps out of
        // the snapshot instead would discard everything the earlier steps wrote.
        uniformsForThisIteration.blendBaseTex = {
          value: stepIndex === 0 ? scratch.strokeStartFbo.texture : stepInputFbo.texture,
        };

        effect.updateEffectUniforms({
          commonUniforms: uniformsForThisIteration,
          passIndex: p,
          file: sourceFile,
          state: effectState,
          modContext: iterationContext,
        });

        this.drawRanges(material, currentWriteFbo, isFinalPass ? finalRanges : passRanges);

        currentReadFbo = currentWriteFbo;

        if (!isFinalPass) {
          [tempFboA, tempFboB] = [tempFboB, tempFboA];
        }
      }

      // The output of this step becomes the input for the next step
      stepInputFbo = currentReadFbo;
    }

    // A committed stroke folds its footprint back into the canonical buffer,
    // which keeps currentReadFBO canonical; a preview leaves it in the partner
    // for the display to composite. On the legacy full-texture path the
    // partner holds the whole result, so the buffers swap instead.
    if (!preview && copyBack) {
      rangeCopyMaterial.uniforms.inputTex.value = destinationFbo.texture;
      this.drawRanges(rangeCopyMaterial, currentReadFBO, footprint);
      rangeCopyMaterial.uniforms.inputTex.value = null;
    }
    this.gl.setRenderTarget(null);

    this.previewActive = preview;
    if (preview) {
      if (!footprint) this.markWholeTexturePreview();
      this.previewRangeTex.needsUpdate = true;
    }

    this.verifyScratchAllocation();

    // If the stroke is not a preview, commit the changes
    if (!preview) {
      if (!copyBack) {
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
        const dabRowStart = scissorRows ? scissorRows.rowStart : 0;
        const dabRowEnd = scissorRows
          ? scissorRows.rowStart + scissorRows.rowCount
          : this.spectrogramData.textureHeight;
        this.maskRows = this.maskRows
          ? {
              rowStart: Math.min(this.maskRows.rowStart, dabRowStart),
              rowEnd: Math.max(this.maskRows.rowEnd, dabRowEnd),
            }
          : { rowStart: dabRowStart, rowEnd: dabRowEnd };
        this.updateStrokeMask(scratch, state, cursorPos, bpm, totalDuration, strokeRandom, pressure, tiltX, tiltY);
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

      this.invalidateFboData();
    }
  }

  /**
   * Update the stroke mask for non-cumulative mode.
   * Iterates every non-accumulate step so each step's envelope/intensity
   * contribution is composited into the mask (via max in the shader). A pure
   * no-op when every step is set to accumulate.
   */
  private updateStrokeMask(
    scratch: StrokeScratch,
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

    const rows = this.maskRows;
    const maskRanges =
      rows !== null && !this.disableScissorCopyBack && rows.rowEnd - rows.rowStart < this.spectrogramData.textureHeight
        ? rowRange(this.spectrogramData.textureWidth, rows.rowStart, rows.rowEnd - rows.rowStart)
        : this.fullRange();

    let renderedAny = false;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const stepState = createStepStateView(state, stepIndex);
      if (stepState.accumulate) continue;

      const footprint = this.resolveBrushFootprint(stepState, bpm, totalDuration, cursorPos.x);
      const brushSizeUv = footprint.sizeUv;
      const brushAnchor = resolveBrushAnchor(cursorPos, footprint.fullTime, footprint.fullPitch);

      // The mask is the envelope of the whole stroke, so it reads the last iteration.
      const maskContext = createModContext(stepState, {
        iteration: 1,
        time: footprint.fullTime ? cursorPos.x : brushAnchor.x + brushSizeUv.x / 2,
        pitch: footprint.fullPitch ? cursorPos.y : brushAnchor.y + brushSizeUv.y / 2,
        random: strokeRandom,
        step: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
        pressure,
        tiltX: (tiltX + 90) / 180,
        tiltY: (tiltY + 90) / 180,
      });

      // Modulator params are per-step; rebuild for each step.
      const modulatorUniforms = buildModulatorUniforms(
        bpm,
        totalDuration,
        this.spectrogramData.bandsPerOctave,
        this.spectrogramData.numBands,
        stepState,
        maskContext,
      );
      uniforms.modulators.value = modulatorUniforms;
      uniforms.modulator1SeqDataTex.value = modulatorUniforms[0]?.seqDataTex || placeholderTexture;
      uniforms.modulator2SeqDataTex.value = modulatorUniforms[1]?.seqDataTex || placeholderTexture;
      uniforms.modulator3SeqDataTex.value = modulatorUniforms[2]?.seqDataTex || placeholderTexture;

      (uniforms.brushBottomLeftUv.value as Vector2).copy(brushAnchor);
      (uniforms.brushSizeUv.value as Vector2).copy(brushSizeUv);

      writeParameterUniform(
        uniforms.brushIntensity.value as ParameterUniform,
        stepState,
        "brushIntensity",
        maskContext,
        BRUSH_SHADER_RANGES.brushIntensity(stepState),
      );
      writeParameterUniform(
        uniforms.brushCurveTime.value as ParameterUniform,
        stepState,
        "brushCurveTime",
        maskContext,
        BRUSH_SHADER_RANGES.brushCurveTime(stepState),
      );
      writeParameterUniform(
        uniforms.brushSkewTime.value as ParameterUniform,
        stepState,
        "brushSkewTime",
        maskContext,
        BRUSH_SHADER_RANGES.brushSkewTime(stepState),
      );
      writeParameterUniform(
        uniforms.brushCurvePitch.value as ParameterUniform,
        stepState,
        "brushCurvePitch",
        maskContext,
        BRUSH_SHADER_RANGES.brushCurvePitch(stepState),
      );
      writeParameterUniform(
        uniforms.brushSkewPitch.value as ParameterUniform,
        stepState,
        "brushSkewPitch",
        maskContext,
        BRUSH_SHADER_RANGES.brushSkewPitch(stepState),
      );

      // The mask shader samples the precomputed modulator textures (via
      // getBrushWeight / applyModulation), so render them for this step first,
      // then restore the mask material as the active program. Skip the pass when
      // nothing routes to a modulator (zero placeholder yields the same result).
      if (hasActiveModulatorRouting(stepState)) {
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        const modulatorFbo = this.renderModulatorTextures(uniforms as unknown as CommonUniforms, maskRanges);
        uniforms.modulatorTex0.value = modulatorFbo.textures[0];
        uniforms.modulatorTex1.value = modulatorFbo.textures[1];
      } else {
        uniforms.modulatorTex0.value = this.textures.placeholderTexture;
        uniforms.modulatorTex1.value = this.textures.placeholderTexture;
      }
      const currentMaskFbo = this.maskPingPong === 0 ? scratch.strokeMaskFbo : scratch.strokeMaskFbo2;
      const nextMaskFbo = this.maskPingPong === 0 ? scratch.strokeMaskFbo2 : scratch.strokeMaskFbo;
      uniforms.currentMaskTex.value = currentMaskFbo.texture;

      this.drawRanges(this.maskMaterial, nextMaskFbo, maskRanges);

      this.maskPingPong = 1 - this.maskPingPong;
      renderedAny = true;
    }

    if (renderedAny) this.gl.setRenderTarget(null);
  }

  /** Marks the cached packed state stale, so the next read goes to the GPU. */
  private invalidateFboData(): void {
    this.fboDataDirty = true;
    this.fboDataEpoch++;
  }

  /**
   * Get the current FBO data asynchronously. The readback is issued against the
   * FBO as it stands at the call, so the resolved array is that caller's
   * snapshot even when later paint lands before it resolves.
   */
  async getFBOData(): Promise<Float32Array> {
    if (this.fboDataCache && !this.fboDataDirty) {
      return this.fboDataCache;
    }

    const { packedTextureSize } = this.spectrogramData;
    const fboToRead = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const epoch = this.fboDataEpoch;
    const data = await readRenderTargetPixelsAsync(this.gl, fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y);

    // Paint that landed while the read was in flight is absent from `data`, so
    // it stands in for nothing later: leave the cache stale for the next read.
    if (epoch === this.fboDataEpoch) {
      this.fboDataCache = data;
      this.fboDataDirty = false;
    }

    return data;
  }

  /**
   * Reads just the pixels of `pixelRanges` (a flat [pixelStart, pixelCount, ...]
   * list) from the committed FBO as it stands at the call, as one block in
   * range order. The ranges are gathered on the GPU into a compact target and
   * only that is read back, so the cost follows the footprint, not the file.
   */
  async readPixelRanges(pixelRanges: Uint32Array): Promise<Float32Array> {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;

    let patchPixels = 0;
    let numRanges = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      if (pixelRanges[i + 1] === 0) continue;
      patchPixels += pixelRanges[i + 1];
      numRanges++;
    }
    if (patchPixels === 0) return new Float32Array(0);

    const instances = new Uint32Array(numRanges * 3);
    let dstPixel = 0;
    let inst = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      const count = pixelRanges[i + 1];
      if (count === 0) continue;
      instances[inst * 3] = pixelRanges[i];
      instances[inst * 3 + 1] = count;
      instances[inst * 3 + 2] = dstPixel;
      dstPixel += count;
      inst++;
    }

    const blockWidth = Math.min(width, patchPixels);
    const blockHeight = Math.ceil(patchPixels / blockWidth);
    const block = new WebGLRenderTarget(blockWidth, blockHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
    geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
    geometry.setAttribute("aRange", new InstancedBufferAttribute(instances, 3));
    geometry.instanceCount = numRanges;

    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    gatherMaterial.uniforms.sourceTex.value = committed.texture;
    gatherMaterial.uniforms.sourceWidth.value = width;
    gatherMaterial.uniforms.destWidth.value = blockWidth;
    gatherMaterial.uniforms.destHeight.value = blockHeight;

    const mesh = new Mesh(geometry, gatherMaterial);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);

    this.gl.setRenderTarget(block);
    this.gl.render(scene, this.camera);
    this.gl.setRenderTarget(null);
    gatherMaterial.uniforms.sourceTex.value = null;
    geometry.dispose();

    try {
      const padded = await readRenderTargetPixelsAsync(this.gl, block, 0, 0, blockWidth, blockHeight);
      return padded.length === patchPixels * 4 ? padded : padded.slice(0, patchPixels * 4);
    } finally {
      block.dispose();
    }
  }

  /**
   * Adds a phase offset per channel to the pixels of each range in the
   * committed FBO (and the stroke-start snapshot), as a projection's whole-turn
   * re-branch of a band's tail. `turns` is a flat list of
   * [pixelStart, pixelCount, offsetLeft, offsetRight, ...] with the offsets
   * already signed for the direction wanted. The turned pixels go through the
   * other ping-pong buffer and are copied back, so nothing is uploaded.
   */
  applyPhaseTurns(turns: ArrayLike<number>): void {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;
    const height = packedTextureSize.y;

    let numRanges = 0;
    for (let i = 0; i + 3 < turns.length; i += 4) if (turns[i + 1] > 0) numRanges++;
    if (numRanges === 0) return;

    const ranges = new Uint32Array(numRanges * 2);
    const offsets = new Float32Array(numRanges * 2);
    const zeros = new Float32Array(numRanges * 2);
    let inst = 0;
    for (let i = 0; i + 3 < turns.length; i += 4) {
      if (turns[i + 1] <= 0) continue;
      ranges[inst * 2] = turns[i];
      ranges[inst * 2 + 1] = turns[i + 1];
      offsets[inst * 2] = turns[i + 2];
      offsets[inst * 2 + 1] = turns[i + 3];
      inst++;
    }

    const draw = (source: WebGLRenderTarget, targets: WebGLRenderTarget[], offs: Float32Array): void => {
      const geometry = new InstancedBufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
      geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
      geometry.setAttribute("aRange", new InstancedBufferAttribute(ranges, 2));
      geometry.setAttribute("aOffset", new InstancedBufferAttribute(offs, 2));
      geometry.instanceCount = numRanges;
      phaseTurnMaterial.uniforms.sourceTex.value = source.texture;
      phaseTurnMaterial.uniforms.width.value = width;
      phaseTurnMaterial.uniforms.height.value = height;
      const mesh = new Mesh(geometry, phaseTurnMaterial);
      mesh.frustumCulled = false;
      const scene = new Scene();
      scene.add(mesh);
      for (const target of targets) {
        this.gl.setRenderTarget(target);
        this.gl.render(scene, this.camera);
      }
      this.gl.setRenderTarget(null);
      phaseTurnMaterial.uniforms.sourceTex.value = null;
      geometry.dispose();
    };

    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const other = this.pingPong === 0 ? this.fbo2 : this.fbo1;
    draw(committed, [other], offsets);
    const back = [committed];
    if (this.pool.ownedBy(this) && this.scratch) back.push(this.scratch.strokeStartFbo);
    draw(other, back, zeros);
    this.gl.autoClear = prevAutoClear;

    this.invalidateFboData();
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

    // The stroke-start snapshot only exists while this renderer holds the
    // scratch pool; when it does not, the next acquireScratch rebuilds it
    // from fbo1 anyway.
    if (this.pool.ownedBy(this) && this.scratch) {
      this.snapshotToStrokeStart(this.scratch, this.fbo1.texture);
    }

    dataTex.dispose();

    this.invalidateFboData();
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
    const targets = [committed];
    // The stroke-start snapshot must receive the same rows, but only while
    // this renderer holds it; otherwise the next acquireScratch rebuilds it
    // from the patched committed buffer.
    if (this.pool.ownedBy(this) && this.scratch) {
      targets.push(this.scratch.strokeStartFbo);
    }
    for (const target of targets) {
      this.gl.setRenderTarget(target);
      this.gl.render(scene, this.camera);
    }
    this.gl.setRenderTarget(null);
    this.gl.autoClear = prevAutoClear;

    geometry.dispose();
    patchTex.dispose();
    this.invalidateFboData();
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

  /** The committed spectrogram texture. */
  getDisplayTexture(): Texture {
    return (this.pingPong === 0 ? this.fbo1 : this.fbo2).texture;
  }

  /**
   * The textures the display composites when a preview is up: the committed
   * spectrogram, the preview, and the per-band bin ranges [start, end) the
   * preview is valid in, as a numBands×1 texture. `active` is false when there
   * is no preview to show.
   */
  getPreviewDisplay(): { committed: Texture; preview: Texture; binRanges: Texture; active: boolean } {
    const currentFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const nextFBO = this.pingPong === 0 ? this.fbo2 : this.fbo1;
    return {
      committed: currentFBO.texture,
      preview: nextFBO.texture,
      binRanges: this.previewRangeTex,
      active: this.previewActive,
    };
  }

  // Blocks until all GPU work submitted so far has finished. Lets opt-in paint
  // timing attribute true GPU cost to a stroke instead of just the JS dispatch.
  finishGpu(): void {
    this.gl.getContext().finish();
  }

  /**
   * Saves the current spectrogram so a run of committed strokes can be taken
   * back without touching history — what a grid fill paints onto.
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
    this.invalidateFboData();
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
    this.invalidateFboData();
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
    // Without the scratch pool there is nothing to reset; the next
    // acquireScratch establishes the same state.
    if (!this.pool.ownedBy(this) || !this.scratch) return;

    // Snapshot the result of the stroke to strokeStartFbo
    const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    this.snapshotToStrokeStart(this.scratch, currentReadFBO.texture);

    // Clear both Mask FBOs and reset ping-pong
    this.clearMasks(this.scratch);
    this.maskPingPong = 0;
  }

  /**
   * Restore to original state.
   */
  restoreOriginal(): void {
    this.isInitialized = false;
    this.invalidateFboData();
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
   * Take the dirty region and clear it in one step. The commit that owns the
   * returned region is the only one that synthesizes it; dabs painted after
   * this call accumulate into a fresh region for the next commit.
   */
  consumeDirtyRegion(): { startX: number; endX: number; startY: number; endY: number } | null {
    const region = this.dirtyRegion;
    this.dirtyRegion = null;
    return region;
  }

  /**
   * Dispose of all WebGL resources.
   */
  dispose(): void {
    this.releaseRollback();
    this.pool.release(this);
    this.scratch = null;
    this.fbo1.dispose();
    this.fbo2.dispose();
    this.maskMaterial.dispose();
    this.modulatorMaterial.dispose();
    this.fboMesh.geometry.dispose();
    this.fboScene.remove(this.fboMesh);
    this.rangeGeometry.dispose();
    this.rangeScene.remove(this.rangeMesh);
    this.previewRangeTex.dispose();
  }
}
