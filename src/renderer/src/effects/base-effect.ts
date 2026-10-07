import { defaultParameterUniform } from "@renderer/lib/static-modulation";
import { OpenFile, State } from "@renderer/store/types";
import { ModulatorParameterUniform, ParameterUniform } from "@renderer/types";
import type { ModContext } from "@renderer/lib/static-modulation";
import type { ImpulseFileInfo } from "@renderer/lib/stroke-renderer";
import * as THREE from "three";
import { Texture, Vector2, Vector4 } from "three";

export type Modulator = {
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPhaseMode: number;
  modulatorPhaseX: ModulatorParameterUniform;
  modulatorPhaseY: ModulatorParameterUniform;
  modulatorPatternRateX: ModulatorParameterUniform;
  modulatorPatternRateY: ModulatorParameterUniform;
  modulatorStrength: ModulatorParameterUniform;
  modulatorSteps: number;
  modulatorRotation: ModulatorParameterUniform;
  modulatorStereoSpread: ModulatorParameterUniform;
  modulatorEnvelopeMinDb: number;
  modulatorEnvelopeMaxDb: number;
  // Sequencer fields
  seqStepsX: number;
  seqStepsY: number;
  seqLoopX: ModulatorParameterUniform;
  seqLoopY: ModulatorParameterUniform;
  seqSwing: ModulatorParameterUniform;
  seqDataTex: THREE.DataTexture | null;
};

export type CommonUniforms = {
  sourceSpectrogramTex: { value: Texture | null };
  sourceInverseMapTex: { value: Texture | null };
  sourceMetadataTex: { value: Texture | null };
  sourceFrameCount: { value: number };
  sourceBandCount: { value: number };
  sourceSpectrogramTextureSize: { value: Vector2 };
  sourceChannelCount: { value: number };
  sourceSampleRate: { value: number };
  destPerSourceFrame: { value: Vector2 };
  sourceTempoRatio: { value: Vector2 };
  sourceMinFreq: { value: number };
  sourceBandsPerOctave: { value: number };
  sourceOnsetTex: { value: Texture | null };
  sourceViewStartFrame: { value: number };
  sourceFileFrameCount: { value: number };
  destSpectrogramTex: { value: Texture | null };
  destInverseMapTex: { value: Texture | null };
  destMetadataTex: { value: Texture | null };
  destFrameCount: { value: number };
  destBandCount: { value: number };
  destSpectrogramTextureSize: { value: Vector2 };
  destChannelCount: { value: number };
  destSampleRate: { value: number };
  destMinFreq: { value: number };
  destBandsPerOctave: { value: number };
  destViewStartFrame: { value: number };
  destFileFrameCount: { value: number };
  originalSpectrogramTex: { value: Texture | null };
  brushBottomLeftUv: { value: Vector2 };
  brushSizeUv: { value: Vector2 };
  // Selection clip: 0 when no selection is set, and the brush writes everywhere
  // it would otherwise. The frames are (startFrame, endFrame) and the bands are
  // the inclusive (lowBand, highBand) pair the selection covers.
  selectionActive: { value: number };
  selectionFrames: { value: Vector2 };
  selectionBands: { value: Vector2 };
  // Shape mask over the selection's bounding rectangle; 0 when the selection
  // is a plain rectangle.
  selectionMaskActive: { value: number };
  selectionStartFrame: { value: number };
  selectionMaskRowsTex: { value: Texture | null };
  selectionMaskRunsTex: { value: Texture | null };
  viewZoomPower: { value: number };
  viewOffset: { value: number };
  viewZoomPowerY: { value: number };
  viewOffsetY: { value: number };
  brushCurveTime: { value: ParameterUniform };
  brushSkewTime: { value: ParameterUniform };
  brushCurvePitch: { value: ParameterUniform };
  brushSkewPitch: { value: ParameterUniform };
  modulators: { value: Modulator[] };
  brushIntensity: {
    value: ParameterUniform;
  };
  sourceOffsetX: {
    value: number;
  };

  sourceOffsetY: {
    value: number;
  };

  sourceTimeScale: { value: number };
  sourceBandScale: { value: number };
  sourceTimeOffset: { value: ParameterUniform };
  sourcePitchOffset: { value: ParameterUniform };
  // A pass drawn once per part of its input: on, the part's core as input-view
  // frames [x, y) and bands [z, w], and the channel pair the draw writes.
  sourcePartOn: { value: boolean };
  sourcePartCore: { value: Vector4 };
  sourcePartChannel: { value: number };
  // A pass whose copies are read a group at a time: the copies [x, y] a draw
  // reads, and whether it adds to the totals (1) or finishes them (2).
  sourcePartTaps: { value: Vector2 };
  sourcePartAccum: { value: number };
  sourcePartSlot: { value: number };
  sourcePartTotals1: { value: Texture | null };
  // Set while the step's input is read through a view of its own: the input
  // laid out as the dest canvas, which holds every pixel the pass writes.
  sourceUnderOn: { value: boolean };
  sourceUnderTex: { value: Texture | null };

  brushPan: {
    value: ParameterUniform;
  };

  bpm: { value: number };
  blendMode: { value: number };
  wrapMode: { value: number };
  brushWrapSpanX: { value: number };
  algorithm: { value: number };
  useLinearBlend?: { value: boolean };
  bypassBrushWeight?: { value: boolean };
  inSwappedDomain?: { value: boolean };
  magnitudeLimit: { value: number };
  gainLut: { value: Texture | null };
  quantizeLutTex: { value: Texture | null };
  modulator1ImageTex: { value: Texture | null };
  modulator2ImageTex: { value: Texture | null };
  modulator3ImageTex: { value: Texture | null };
  modulator1SeqDataTex: { value: Texture | null };
  modulator2SeqDataTex: { value: Texture | null };
  modulator3SeqDataTex: { value: Texture | null };
  // Precomputed per-pixel modulator outputs (filled by the modulator pass each
  // step). tex0 packs modulators 0 and 1 (xy/zw), tex1 packs modulator 2 (xy).
  modulatorTex0: { value: Texture | null };
  modulatorTex1: { value: Texture | null };
  // Non-cumulative stroke uniforms for preventing accumulation
  useStrokeMask?: { value: boolean };
  strokeMaskTex?: { value: Texture | null };
  blendOriginalTex?: { value: Texture | null };
  blendBaseTex?: { value: Texture | null };
};

/**
 * Fresh common uniform wrappers for one material. Every material must call this
 * rather than share one object: effects such as Sort and Transmute assign to
 * `uniforms.useLinearBlend.value` in place, and a shared wrapper would carry
 * that write into every other effect's material.
 */
/** numerator / denominator as a float and the float remainder, so their sum carries the double. */
export function splitRatio(numerator: number, denominator: number): Vector2 {
  const ratio = numerator / denominator;
  const high = Math.fround(ratio);
  return new Vector2(high, ratio - high);
}

export function createDefaultUniforms(): CommonUniforms {
  return {
    sourceSpectrogramTex: { value: null },
    sourceInverseMapTex: { value: null },
    sourceMetadataTex: { value: null },
    sourceFrameCount: { value: 0 },
    sourceBandCount: { value: 0 },
    sourceSpectrogramTextureSize: { value: new Vector2(0, 0) },
    sourceChannelCount: { value: 1 },
    sourceSampleRate: { value: 44100.0 },
    destPerSourceFrame: { value: new Vector2(1, 0) },
    sourceTempoRatio: { value: new Vector2(1, 0) },
    sourceMinFreq: { value: 20.0 },
    sourceOnsetTex: { value: null },
    sourceBandsPerOctave: { value: 24.0 },
    sourceViewStartFrame: { value: 0 },
    sourceFileFrameCount: { value: 0 },
    destSpectrogramTex: { value: null },
    destInverseMapTex: { value: null },
    destMetadataTex: { value: null },
    destFrameCount: { value: 0 },
    destBandCount: { value: 0 },
    destSpectrogramTextureSize: { value: new Vector2(0, 0) },
    destChannelCount: { value: 1 },
    destSampleRate: { value: 44100.0 },
    destMinFreq: { value: 20.0 },
    destBandsPerOctave: { value: 24.0 },
    destViewStartFrame: { value: 0 },
    destFileFrameCount: { value: 0 },
    originalSpectrogramTex: { value: null },
    brushBottomLeftUv: { value: new Vector2(0.0, 0.0) },
    brushSizeUv: { value: new Vector2(0.1, 0.1) },
    selectionActive: { value: 0 },
    selectionFrames: { value: new Vector2(0.0, 0.0) },
    selectionBands: { value: new Vector2(0.0, 0.0) },
    selectionMaskActive: { value: 0 },
    selectionStartFrame: { value: 0 },
    selectionMaskRowsTex: { value: null },
    selectionMaskRunsTex: { value: null },
    viewZoomPower: { value: 0.0 },
    viewOffset: { value: 0.0 },
    viewZoomPowerY: { value: 0.0 },
    viewOffsetY: { value: 0.0 },
    brushCurveTime: { value: defaultParameterUniform(0.0, -1.0, 1.0) },
    brushSkewTime: { value: defaultParameterUniform(0.5, 0.0, 1.0) },
    brushCurvePitch: { value: defaultParameterUniform(0.0, -1.0, 1.0) },
    brushSkewPitch: { value: defaultParameterUniform(0.5, 0.0, 1.0) },
    brushIntensity: { value: defaultParameterUniform(1.0, 0.0, 1.0) },
    sourceOffsetX: {
      value: 0,
    },
    sourceOffsetY: {
      value: 0,
    },
    sourceTimeScale: { value: 1 },
    sourceBandScale: { value: 1 },
    sourceTimeOffset: { value: defaultParameterUniform(0, -1, 1) },
    sourcePitchOffset: { value: defaultParameterUniform(0, -1, 1) },
    sourcePartOn: { value: false },
    sourcePartCore: { value: new Vector4() },
    sourcePartChannel: { value: 0 },
    sourcePartTaps: { value: new Vector2() },
    sourcePartAccum: { value: 0 },
    sourcePartSlot: { value: 0 },
    sourcePartTotals1: { value: null },
    sourceUnderOn: { value: false },
    sourceUnderTex: { value: null },
    brushPan: { value: defaultParameterUniform(0.0, 0.0, 1.0) },
    bpm: { value: 120.0 },
    blendMode: { value: 0 },
    magnitudeLimit: { value: 0.0 },
    wrapMode: { value: 0 },
    brushWrapSpanX: { value: 1 },
    algorithm: { value: 0 },
    useLinearBlend: { value: false },
    bypassBrushWeight: { value: false },
    inSwappedDomain: { value: false },
    modulators: { value: [] },
    gainLut: { value: null },
    quantizeLutTex: { value: null },
    modulator1ImageTex: { value: null },
    modulator2ImageTex: { value: null },
    modulator3ImageTex: { value: null },
    modulator1SeqDataTex: { value: null },
    modulator2SeqDataTex: { value: null },
    modulator3SeqDataTex: { value: null },
    modulatorTex0: { value: null },
    modulatorTex1: { value: null },
    // Non-cumulative stroke uniforms
    useStrokeMask: { value: false },
    strokeMaskTex: { value: null },
    blendOriginalTex: { value: null },
    blendBaseTex: { value: null },
  };
}

/**
 * The layout of the file being painted. Effects that transform in destination
 * UV space have to convert beats and semitones with this, not with `props.file`
 * — that is the source, and it differs whenever a stroke paints across files.
 */
export function destinationLayout(commonUniforms: CommonUniforms): {
  bpm: number;
  totalDuration: number;
  bandsPerOctave: number;
  numBands: number;
  minFreq: number;
} {
  const sampleRate = commonUniforms.destSampleRate.value;
  return {
    bpm: commonUniforms.bpm.value,
    totalDuration: sampleRate > 0 ? commonUniforms.destFrameCount.value / sampleRate : 0,
    bandsPerOctave: commonUniforms.destBandsPerOctave.value,
    numBands: commonUniforms.destBandCount.value,
    minFreq: commonUniforms.destMinFreq.value,
  };
}

/**
 * The source side's own layout, for effects that offset a source UV. The frame
 * count is the span the source textures hold, which is a window of the source
 * file when the canvas holds one.
 */
export function sourceLayout(commonUniforms: CommonUniforms): {
  totalDuration: number;
  bandsPerOctave: number;
  numBands: number;
} {
  const sampleRate = commonUniforms.sourceSampleRate.value;
  return {
    totalDuration: sampleRate > 0 ? commonUniforms.sourceFrameCount.value / sampleRate : 0,
    bandsPerOctave: commonUniforms.sourceBandsPerOctave.value,
    numBands: commonUniforms.sourceBandCount.value,
  };
}

export type UpdateEffectUniformsProps = {
  commonUniforms: CommonUniforms;
  passIndex: number;
  file: OpenFile;
  state?: State;
  modContext: ModContext;
  /** The impulse response each convolve step reads, keyed by `impulseKey`. */
  impulses?: ReadonlyMap<string, ImpulseFileInfo>;
};

export abstract class BaseEffect {
  materials: THREE.RawShaderMaterial[] = [];

  abstract updateEffectUniforms(props: UpdateEffectUniformsProps): void;

  /**
   * Pass indices that do real work at the given settings. Returning fewer
   * indices skips those passes for the stroke, and an empty array skips the
   * effect. Left undefined, every pass runs.
   */
  getActivePasses?(state: State): number[];

  /**
   * The domain the pass hands on, given the one it receives: true once a pass
   * has moved the pair out of magnitude and phase, false again once one has
   * moved it back. The renderer runs this along the chain and tells each pass,
   * through `inSwappedDomain`, which domain reaches it.
   */
  domainAfter?(state: State, inSwappedDomain: boolean): boolean;

  updateCommonUniforms({ commonUniforms, passIndex }: { commonUniforms: CommonUniforms; passIndex: number }): void {
    const material = this.materials[passIndex];
    if (!material) return;

    for (const key in commonUniforms) {
      const newValue = (commonUniforms as Record<string, { value: unknown }>)[key].value;
      if (key in material.uniforms) {
        // Only update if value actually changed
        if (material.uniforms[key].value !== newValue) {
          material.uniforms[key].value = newValue;
        }
      } else {
        // Add uniform if it doesn't exist (needed for dynamically added uniforms like useStrokeMask)
        material.uniforms[key] = { value: newValue };
      }
    }
  }
}
