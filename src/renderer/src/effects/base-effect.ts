import { defaultParameterUniform } from "@renderer/lib/static-modulation";
import { OpenFile, State } from "@renderer/store/types";
import { ModulatorParameterUniform, ParameterUniform } from "@renderer/types";
import type { ModContext } from "@renderer/lib/static-modulation";
import * as THREE from "three";
import { Texture, Vector2 } from "three";

export type Modulator = {
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPhaseMode: number;
  modulatorPhaseX: ModulatorParameterUniform;
  modulatorPhaseY: ModulatorParameterUniform;
  modulatorPatternRateX: ModulatorParameterUniform;
  modulatorPatternRateY: ModulatorParameterUniform;
  modulatorStrength: ModulatorParameterUniform;
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
  sourceMinFreq: { value: number };
  sourceBandsPerOctave: { value: number };
  sourceOnsetTex: { value: Texture | null };
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
  originalSpectrogramTex: { value: Texture | null };
  brushBottomLeftUv: { value: Vector2 };
  brushSizeUv: { value: Vector2 };
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

  brushPan: {
    value: ParameterUniform;
  };

  bpm: { value: number };
  blendMode: { value: number };
  wrapMode: { value: number };
  algorithm: { value: number };
  useLinearBlend?: { value: boolean };
  bypassBrushWeight?: { value: boolean };
  inSwappedDomain?: { value: boolean };
  magnitudeLimit: { value: number };
  gainLut: { value: Texture | null };
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
};

/**
 * Fresh common uniform wrappers for one material. Every material must call this
 * rather than share one object: effects such as Sort and Transmute assign to
 * `uniforms.useLinearBlend.value` in place, and a shared wrapper would carry
 * that write into every other effect's material.
 */
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
    sourceMinFreq: { value: 20.0 },
    sourceOnsetTex: { value: null },
    sourceBandsPerOctave: { value: 24.0 },
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
    originalSpectrogramTex: { value: null },
    brushBottomLeftUv: { value: new Vector2(0.0, 0.0) },
    brushSizeUv: { value: new Vector2(0.1, 0.1) },
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
    brushPan: { value: defaultParameterUniform(0.0, 0.0, 1.0) },
    bpm: { value: 120.0 },
    blendMode: { value: 0 },
    magnitudeLimit: { value: 0.0 },
    wrapMode: { value: 0 },
    algorithm: { value: 0 },
    useLinearBlend: { value: false },
    bypassBrushWeight: { value: false },
    inSwappedDomain: { value: false },
    modulators: { value: [] },
    gainLut: { value: null },
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

export type UpdateEffectUniformsProps = {
  commonUniforms: CommonUniforms;
  passIndex: number;
  file: OpenFile;
  state?: State;
  modContext: ModContext;
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
