import { createNoise2D } from "simplex-noise";
import {
  Camera,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
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
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { copyMaterial } from "../components/copy-material";
import { BaseEffect, CommonUniforms, defaultValues } from "../effects/base-effect";
import maskUpdateFrag from "../glsl/mask-update.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { createEffectStateView, createStepStateView } from "../store";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "../store/modulators";
import type { SpectrogramData, State } from "../store/types";
import { readRenderTargetPixelsAsync } from "./async-readpixels";
import { buildModulatorUniforms } from "./modulator-utils";
import { withPlatformDefines } from "./shader-utils";
import { unitsToUv } from "./utils";

// Define EffectType locally to avoid circular dependency
export type EffectType = "dynamics" | "transform" | "overtones" | "blur" | "synthesize" | "passthrough";

// Effects registry type
export type EffectsRegistry = Record<EffectType, BaseEffect>;

const noise2D = createNoise2D();

/**
 * Envelope boundaries calculated from D/A/S/R values
 */
export interface EnvelopeBoundaries {
  d: number;
  a: number;
  s: number;
  r: number;
  delayEnd: number;
  attackEnd: number;
  sustainEnd: number;
  releaseEnd: number;
}

/**
 * Helper function to calculate normalized envelope stage boundaries.
 * Returns absolute UV values for each stage.
 */
export function calculateEnvelopeBoundaries(
  delay: number,
  attack: number,
  sustain: number,
  release: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
  isTime: boolean,
): EnvelopeBoundaries {
  let d: number, a: number, s: number, r: number;

  // Convert from beats/semitones to absolute UV using unitsToUv
  if (isTime) {
    d = unitsToUv(delay, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    a = unitsToUv(attack, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    s = unitsToUv(sustain, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    r = unitsToUv(release, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
  } else {
    d = unitsToUv(0, delay, bpm, totalDuration, bandsPerOctave, numBands).y;
    a = unitsToUv(0, attack, bpm, totalDuration, bandsPerOctave, numBands).y;
    s = unitsToUv(0, sustain, bpm, totalDuration, bandsPerOctave, numBands).y;
    r = unitsToUv(0, release, bpm, totalDuration, bandsPerOctave, numBands).y;
  }

  // Calculate total brush size from envelope
  const brushSize = d + a + s + r;

  // Calculate cumulative positions as fractions of brush size (normalized 0-1)
  const safeSize = Math.max(brushSize, 0.0001);
  return {
    d,
    a,
    s,
    r,
    delayEnd: d / safeSize,
    attackEnd: (d + a) / safeSize,
    sustainEnd: (d + a + s) / safeSize,
    releaseEnd: (d + a + s + r) / safeSize,
  };
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
  spectrogramData: SpectrogramData;
  textures: {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  };
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

  // Scene objects
  private fboScene: Scene;
  private fboMesh: Mesh;
  private camera: Camera;

  // Materials
  private maskMaterial: RawShaderMaterial;

  // State
  private pingPong = 0;
  private maskPingPong = 0;
  private isInitialized = false;

  // FBO data cache
  private fboDataCache: Float32Array | null = null;
  private fboDataDirty = true;

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
        envelopeDelayEndX: { value: 0 },
        envelopeAttackEndX: { value: 0 },
        envelopeSustainEndX: { value: 0 },
        envelopeReleaseEndX: { value: 0 },
        envelopeDelayEndY: { value: 0 },
        envelopeAttackEndY: { value: 0 },
        envelopeSustainEndY: { value: 0 },
        envelopeReleaseEndY: { value: 0 },
      },
      vertexShader: passThroughVert,
      fragmentShader: withPlatformDefines(maskUpdateFrag),
      glslVersion: GLSL3,
    });
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
   * Calculate brush size in UV coordinates from state envelope parameters.
   */
  calculateBrushSizeUv(state: State, bpm: number, totalDuration: number): Vector2 {
    const envelopeTimeUv = unitsToUv(
      state.brushEnvelopeDelayTime +
        state.brushEnvelopeAttackTime +
        state.brushEnvelopeSustainTime +
        state.brushEnvelopeReleaseTime,
      0,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
    );
    const envelopePitchUv = unitsToUv(
      0,
      state.brushEnvelopeDelayPitch +
        state.brushEnvelopeAttackPitch +
        state.brushEnvelopeSustainPitch +
        state.brushEnvelopeReleasePitch,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
    );
    return new Vector2(envelopeTimeUv.x, envelopePitchUv.y);
  }

  /**
   * Calculate source offset based on position mode.
   */
  calculateSourceOffset(
    state: State,
    mousePos: Vector2 | null,
    sourceBpm: number,
    sourceTotalDuration: number,
    sourceSpectrogramData: SpectrogramData,
    bpm: number,
    totalDuration: number,
  ): Vector2 {
    const sourceOffsetUv = new Vector2(0, 0);

    if (!state.sourcePosition || !mousePos) {
      return sourceOffsetUv;
    }

    const mode = state.sourcePositionMode;

    // Calculate brush size from envelope in the CURRENT file's coordinate space
    const envelopeTimeUvCurrent = unitsToUv(
      state.brushEnvelopeDelayTime +
        state.brushEnvelopeAttackTime +
        state.brushEnvelopeSustainTime +
        state.brushEnvelopeReleaseTime,
      0,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
    );
    const envelopePitchUvCurrent = unitsToUv(
      0,
      state.brushEnvelopeDelayPitch +
        state.brushEnvelopeAttackPitch +
        state.brushEnvelopeSustainPitch +
        state.brushEnvelopeReleasePitch,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
    );
    const brushSizeUvCurrent = new Vector2(envelopeTimeUvCurrent.x || 1, envelopePitchUvCurrent.y || 1);
    const halfBrushSizeUvCurrent = new Vector2(brushSizeUvCurrent.x / 2, brushSizeUvCurrent.y / 2);

    // Convert source position (bottom-left) to UV coordinates in the source file
    const sourcePositionBottomLeftUv = unitsToUv(
      state.sourcePosition.beats,
      state.sourcePosition.pitch,
      sourceBpm,
      sourceTotalDuration,
      sourceSpectrogramData.bandsPerOctave,
      sourceSpectrogramData.numBands,
    );
    const sourcePositionUv = sourcePositionBottomLeftUv.clone();
    const currentBrushUv = mousePos.clone();

    if (mode === "fixed") {
      return sourcePositionUv.clone().sub(currentBrushUv);
    } else if (mode === "anchored") {
      if (state.cursorPosition) {
        const brushStartBottomLeftUv = unitsToUv(
          state.cursorPosition.beats,
          state.cursorPosition.pitch,
          bpm,
          totalDuration,
          this.spectrogramData.bandsPerOctave,
          this.spectrogramData.numBands,
        );
        const brushStartUv = brushStartBottomLeftUv.clone();
        return sourcePositionUv.clone().sub(brushStartUv);
      } else {
        return sourcePositionUv.clone().sub(currentBrushUv);
      }
    } else if (mode === "offset") {
      if (state.lockedOffset) {
        return unitsToUv(
          state.lockedOffset.beats,
          state.lockedOffset.pitch,
          sourceBpm,
          sourceTotalDuration,
          sourceSpectrogramData.bandsPerOctave,
          sourceSpectrogramData.numBands,
        );
      } else if (state.cursorPosition) {
        const brushStartBottomLeftUv = unitsToUv(
          state.cursorPosition.beats,
          state.cursorPosition.pitch,
          bpm,
          totalDuration,
          this.spectrogramData.bandsPerOctave,
          this.spectrogramData.numBands,
        );
        const brushStartUv = brushStartBottomLeftUv.clone().add(halfBrushSizeUvCurrent);
        return sourcePositionUv.clone().sub(brushStartUv);
      } else {
        return sourcePositionUv.clone().sub(currentBrushUv);
      }
    }

    return sourceOffsetUv;
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
    viewZoomPower: number,
    viewOffset: number,
    magnitudeLimit: number,
  ): CommonUniforms {
    const { placeholderTexture, modulatorScaleLut, modulator1Texture, modulator2Texture, modulator3Texture } =
      this.textures;

    // Calculate envelope boundaries
    const envelopeX = calculateEnvelopeBoundaries(
      stepState.brushEnvelopeDelayTime,
      stepState.brushEnvelopeAttackTime,
      stepState.brushEnvelopeSustainTime,
      stepState.brushEnvelopeReleaseTime,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      true,
    );
    const envelopeY = calculateEnvelopeBoundaries(
      stepState.brushEnvelopeDelayPitch,
      stepState.brushEnvelopeAttackPitch,
      stepState.brushEnvelopeSustainPitch,
      stepState.brushEnvelopeReleasePitch,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      false,
    );

    const modulatorUniforms = buildModulatorUniforms(
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      stepState,
    );

    return {
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
      brushBottomLeftUv: { value: cursorPos },
      envelopeDelayEndX: { value: envelopeX.delayEnd },
      envelopeAttackEndX: { value: envelopeX.attackEnd },
      envelopeSustainEndX: { value: envelopeX.sustainEnd },
      envelopeReleaseEndX: { value: envelopeX.releaseEnd },
      envelopeDelayEndY: { value: envelopeY.delayEnd },
      envelopeAttackEndY: { value: envelopeY.attackEnd },
      envelopeSustainEndY: { value: envelopeY.sustainEnd },
      envelopeReleaseEndY: { value: envelopeY.releaseEnd },
      brushSizeUv: { value: brushSizeUv },
      brushIntensity: {
        value: {
          value: stepState.brushIntensity / 100,
          minValue: 0,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushIntensity"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushIntensity"),
        },
      },
      brushPan: {
        value: {
          value: stepState.brushPan / 100,
          minValue: -1,
          maxValue: 1,
          modulationAmounts: getModAmountValuesNormalized(stepState, "brushPan"),
          contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushPan"),
        },
      },
      bpm: { value: bpm },
      sourceOffsetX: { value: sourceOffsetUv.x },
      sourceOffsetY: { value: sourceOffsetUv.y },
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
   * Render a brush stroke.
   */
  renderStroke(params: StrokeParams, state: State, sourceFile: SourceFileInfo): void {
    if (!this.isInitialized) {
      this.initialize();
    }

    const { cursorPos, preview, bpm, totalDuration, viewZoomPower, viewOffset } = params;

    if (cursorPos.x < 0) return;

    const activeStepState = createStepStateView(state, state.activeStepIndex);

    // Calculate source offset
    const sourceOffsetUv = this.calculateSourceOffset(
      activeStepState,
      cursorPos,
      bpm,
      totalDuration,
      sourceFile.spectrogramData,
      bpm,
      totalDuration,
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

    // Non-cumulative strokes: use snapshot as source to prevent self-feedback
    if (!state.cumulativeStrokes && isSameFile && activeStepState.sourceDataMode !== "original") {
      stepInputFbo = this.strokeStartFbo;
      initialSourceFbo = this.strokeStartFbo;
    }

    const steps = state.slots[state.activeSlotIndex] ?? [];
    const numSteps = steps.length;

    // Generate random value seeded by position using Perlin noise
    const strokeRandom = (noise2D(cursorPos.x * 50, cursorPos.y * 50) + 1) / 2;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const stepState = createStepStateView(state, stepIndex);
      const stepBrushSizeUv = this.calculateBrushSizeUv(stepState, bpm, totalDuration);

      // Determine the blend destination for this step
      const blendDestFbo = stepIndex === 0 ? currentReadFBO : stepInputFbo;

      // Build common uniforms for this step
      const commonUniforms = this.buildStepUniforms(
        stepState,
        stepBrushSizeUv,
        sourceOffsetUv,
        blendDestFbo,
        cursorPos,
        sourceFile,
        bpm,
        totalDuration,
        viewZoomPower,
        viewOffset,
        state.magnitudeLimit,
      );

      // Determine source texture based on this step's sourceDataMode
      const stepSourceDataMode = stepState.sourceDataMode;
      const stepSourceFbo =
        stepSourceDataMode === "original" ? { texture: sourceFile.textures.original } : stepInputFbo;

      // Override the source texture to use the correct input for this step
      commonUniforms.sourceSpectrogramTex.value = stepSourceFbo.texture;

      // Get enabled effects in order for this step
      const stepEffects = stepState.effects as { id: string; effect: EffectType; enabled: boolean; params: Record<string, unknown> }[];
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
        sourceOffsetX: { value: 0 },
        sourceOffsetY: { value: 0 },
      };

      // Reset currentReadFbo to the step's input for effect processing
      let currentReadFbo: WebGLRenderTarget | { texture: DataTexture } = stepInputFbo;

      const isLastStep = stepIndex === numSteps - 1;

      // Apply each enabled effect in order, with iterations
      for (let effectIndex = 0; effectIndex < enabledEffectItems.length; effectIndex++) {
        const effectItem = enabledEffectItems[effectIndex];
        const effect = this.effects[effectItem.effect];
        const numPasses = effect.materials.length;
        const brushIterations = stepState.brushIterations as number;

        for (let i = 0; i < brushIterations; i++) {
          for (let p = 0; p < numPasses; p++) {
            const isFirstEffect = effectIndex === 0;
            const isFirstIteration = i === 0;
            const isFirstPass = p === 0;
            const uniformsForThisIteration =
              isFirstEffect && isFirstIteration && isFirstPass ? { ...commonUniforms } : { ...iterativeUniforms };

            // Add contextual modulation uniforms for this iteration/step
            const brushSizeUv = commonUniforms.brushSizeUv.value as Vector2;
            const brushCenterTime = cursorPos.x + brushSizeUv.x / 2;
            const brushCenterPitch = cursorPos.y + brushSizeUv.y / 2;
            uniformsForThisIteration.strokeIterationNormalized = {
              value: brushIterations > 1 ? i / (brushIterations - 1) : 0,
            };
            uniformsForThisIteration.strokeTimePosition = { value: brushCenterTime };
            uniformsForThisIteration.strokePitchPosition = { value: brushCenterPitch };
            uniformsForThisIteration.strokeRandom = { value: strokeRandom };
            uniformsForThisIteration.strokeStepNormalized = {
              value: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
            };

            const material = effect.materials[p];
            this.fboMesh.material = material;

            const isLastEffect = effectIndex === enabledEffectItems.length - 1;
            const isLastIteration = i === brushIterations - 1;
            const isLastPass = p === numPasses - 1;
            const isFinalPassOfStep = isLastEffect && isLastIteration && isLastPass;
            const isFinalPass = isFinalPassOfStep && isLastStep;
            const currentWriteFbo = isFinalPass ? destinationFbo : tempFboA;

            const inputTexture = currentReadFbo.texture;

            // The "source" on the first effect/iteration/pass is already set correctly in commonUniforms
            if (!(isFirstEffect && isFirstIteration && isFirstPass)) {
              uniformsForThisIteration.sourceSpectrogramTex = { value: inputTexture };
            }

            // The "destination" (for blending) is the original target on the first pass
            uniformsForThisIteration.destSpectrogramTex = {
              value: isFirstEffect && isFirstIteration ? commonUniforms.destSpectrogramTex.value : inputTexture,
            };

            // Pass the mask if enabled (non-cumulative mode)
            if (!state.cumulativeStrokes) {
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

            // Create effect-specific state view with per-instance params merged in
            const effectState = createEffectStateView(state, stepIndex, effectItem);

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
        }
      }

      // The output of this step becomes the input for the next step
      stepInputFbo = currentReadFbo;
    }

    this.gl.setRenderTarget(null);

    // If the stroke is not a preview, commit the changes
    if (!preview) {
      this.pingPong = 1 - this.pingPong;

      // Update stroke mask for non-cumulative mode
      if (!state.cumulativeStrokes) {
        this.updateStrokeMask(state, cursorPos, bpm, totalDuration);
      }

      this.fboDataDirty = true;
    }
  }

  /**
   * Update the stroke mask for non-cumulative mode.
   */
  private updateStrokeMask(state: State, cursorPos: Vector2, bpm: number, totalDuration: number): void {
    const currentMaskFbo = this.maskPingPong === 0 ? this.strokeMaskFbo : this.strokeMaskFbo2;
    const nextMaskFbo = this.maskPingPong === 0 ? this.strokeMaskFbo2 : this.strokeMaskFbo;

    const activeStep = createStepStateView(state, state.activeStepIndex);
    const brushSizeUv = this.calculateBrushSizeUv(activeStep, bpm, totalDuration);

    this.maskMaterial.uniforms.currentMaskTex.value = currentMaskFbo.texture;
    this.maskMaterial.uniforms.destMetadataTex.value = this.textures.metadataTex;
    this.maskMaterial.uniforms.destInverseMapTex.value = this.textures.inverseMapTex;
    this.maskMaterial.uniforms.destSpectrogramTextureSize.value = this.spectrogramData.packedTextureSize;
    this.maskMaterial.uniforms.destFrameCount.value = this.spectrogramData.numFrames;
    this.maskMaterial.uniforms.destBandCount.value = this.spectrogramData.numBands;
    this.maskMaterial.uniforms.brushSizeUv.value = brushSizeUv;
    this.maskMaterial.uniforms.brushIntensity.value = {
      value: activeStep.brushIntensity / 100,
      minValue: 0,
      maxValue: 1,
      modulationAmounts: [0, 0, 0],
      contextualModAmounts: [0, 0, 0, 0, 0],
    };

    const envelopeX = calculateEnvelopeBoundaries(
      activeStep.brushEnvelopeDelayTime,
      activeStep.brushEnvelopeAttackTime,
      activeStep.brushEnvelopeSustainTime,
      activeStep.brushEnvelopeReleaseTime,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      true,
    );
    const envelopeY = calculateEnvelopeBoundaries(
      activeStep.brushEnvelopeDelayPitch,
      activeStep.brushEnvelopeAttackPitch,
      activeStep.brushEnvelopeSustainPitch,
      activeStep.brushEnvelopeReleasePitch,
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      false,
    );

    this.maskMaterial.uniforms.brushBottomLeftUv.value = cursorPos;
    this.maskMaterial.uniforms.envelopeDelayEndX.value = envelopeX.delayEnd;
    this.maskMaterial.uniforms.envelopeAttackEndX.value = envelopeX.attackEnd;
    this.maskMaterial.uniforms.envelopeSustainEndX.value = envelopeX.sustainEnd;
    this.maskMaterial.uniforms.envelopeReleaseEndX.value = envelopeX.releaseEnd;
    this.maskMaterial.uniforms.envelopeDelayEndY.value = envelopeY.delayEnd;
    this.maskMaterial.uniforms.envelopeAttackEndY.value = envelopeY.attackEnd;
    this.maskMaterial.uniforms.envelopeSustainEndY.value = envelopeY.sustainEnd;
    this.maskMaterial.uniforms.envelopeReleaseEndY.value = envelopeY.releaseEnd;

    this.fboMesh.material = this.maskMaterial;
    this.gl.setRenderTarget(nextMaskFbo);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    this.maskPingPong = 1 - this.maskPingPong;
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

  /**
   * Begin a new stroke (snapshot current state).
   */
  beginStroke(): void {
    // Logic moved to initialization and endStroke
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
  }

  /**
   * Check if the renderer is initialized.
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Dispose of all WebGL resources.
   */
  dispose(): void {
    this.fbo1.dispose();
    this.fbo2.dispose();
    this.passFbo1.dispose();
    this.passFbo2.dispose();
    this.strokeMaskFbo.dispose();
    this.strokeMaskFbo2.dispose();
    this.strokeStartFbo.dispose();
    this.maskMaterial.dispose();
  }
}
