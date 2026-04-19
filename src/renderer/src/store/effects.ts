import { DEFAULT_EFFECTS, EffectItem } from "@renderer/effects/types";
import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { shapes } from "../effects/overtones-shapes";

export interface EffectsState {
  // Note: effects is stored per-step, but defined here for ParameterKey type compatibility
  effects: EffectItem[];
  dynamicsThresholdDb: number;
  dynamicsUpperRatio: number;
  dynamicsLowerRatio: number;
  dynamicsKnee: number;
  dynamicsGainDb: number;
  transformShiftBeats: number;
  transformShiftSemis: number;
  transformScaleTime: number;
  transformScalePitch: number;
  transformRotation: number;
  transformEdgeMode: number;
  synthesizeBrushType: number;
  blurAmountTime: number;
  blurAmountPitch: number;
  blurNoiseTime: number;
  blurNoisePitch: number;
  blurSamplesX: number;
  blurSamplesY: number;
  blurEdgeMode: number;
  blurOrigin: number;
  cloneSpaceBeats: number;
  cloneSpaceSemis: number;
  cloneCountX: number;
  cloneCountY: number;
  cloneDecay: number;
  cloneDirectionX: number;
  cloneDirectionY: number;
  cloneEdgeMode: number;
  overtonesCount: number;
  overtonesScale: number;
  overtonesDecay: number;
  overtonesShape: keyof typeof shapes;
  evolveFlow: number;
  evolveSpread: number;
  evolveGrow: number;
  evolveSwirl: number;
  evolveDriftX: number;
  evolveDriftY: number;
  evolveDecay: number;
  evolveScaleX: number;
  evolveScaleY: number;
  evolveEdgeMode: number;
  binauralAzimuth: number;
  binauralDistance: number;
  binauralStereoAngle: number;
  sortDirection: number;
  sortOrder: number;
  sortBy: number;
  sortStereoMode: number;
  transmuteMode: number;
  transmuteAmount: number;
  transmuteCurve: number;
  waveshapeMode: number;
  waveshapeDrive: number;
  waveshapeTilt: number;
  convolveIrFile: FileParameterValue;
  convolveIrTimeOffset: number;
  convolveIrPitchOffset: number;
  convolveIrSize: number;
  convolveGainDb: number;
  convolveOrigin: number;
}

export const createEffectsSlice = (): EffectsState => {
  return {
    // Note: effects is stored per-step, this is just for type compatibility
    effects: DEFAULT_EFFECTS,
    // ---------------- Dynamics ----------------
    dynamicsThresholdDb: getParameterDef("dynamicsThresholdDb").default,
    dynamicsUpperRatio: getParameterDef("dynamicsUpperRatio").default,
    dynamicsLowerRatio: getParameterDef("dynamicsLowerRatio").default,
    dynamicsKnee: getParameterDef("dynamicsKnee").default,
    dynamicsGainDb: getParameterDef("dynamicsGainDb").default,

    // ---------------- Transform ----------------
    transformShiftBeats: getParameterDef("transformShiftBeats").default,
    transformShiftSemis: getParameterDef("transformShiftSemis").default,
    transformScaleTime: getParameterDef("transformScaleTime").default,
    transformScalePitch: getParameterDef("transformScalePitch").default,
    transformRotation: getParameterDef("transformRotation").default,
    transformEdgeMode: getParameterDef("transformEdgeMode").default,

    // ---------------- Blur ----------------
    blurAmountTime: getParameterDef("blurAmountTime").default,
    blurAmountPitch: getParameterDef("blurAmountPitch").default,
    blurNoiseTime: getParameterDef("blurNoiseTime").default,
    blurNoisePitch: getParameterDef("blurNoisePitch").default,
    blurSamplesX: getParameterDef("blurSamplesX").default,
    blurSamplesY: getParameterDef("blurSamplesY").default,
    blurEdgeMode: getParameterDef("blurEdgeMode").default,
    blurOrigin: getParameterDef("blurOrigin").default,

    // ---------------- Clone ----------------
    cloneSpaceBeats: getParameterDef("cloneSpaceBeats").default,
    cloneSpaceSemis: getParameterDef("cloneSpaceSemis").default,
    cloneCountX: getParameterDef("cloneCountX").default,
    cloneCountY: getParameterDef("cloneCountY").default,
    cloneDecay: getParameterDef("cloneDecay").default,
    cloneDirectionX: getParameterDef("cloneDirectionX").default,
    cloneDirectionY: getParameterDef("cloneDirectionY").default,
    cloneEdgeMode: getParameterDef("cloneEdgeMode").default,

    // ---------------- Overtones ----------------
    overtonesCount: getParameterDef("overtonesCount").default,
    overtonesScale: getParameterDef("overtonesScale").default,
    overtonesDecay: getParameterDef("overtonesDecay").default,
    overtonesShape: getParameterDef("overtonesShape").default,

    // ---------------- Synthesize ----------------
    synthesizeBrushType: getParameterDef("synthesizeBrushType").default,

    // ---------------- Evolve ----------------
    evolveFlow: getParameterDef("evolveFlow").default,
    evolveSpread: getParameterDef("evolveSpread").default,
    evolveGrow: getParameterDef("evolveGrow").default,
    evolveSwirl: getParameterDef("evolveSwirl").default,
    evolveDriftX: getParameterDef("evolveDriftX").default,
    evolveDriftY: getParameterDef("evolveDriftY").default,
    evolveDecay: getParameterDef("evolveDecay").default,
    evolveScaleX: getParameterDef("evolveScaleX").default,
    evolveScaleY: getParameterDef("evolveScaleY").default,
    evolveEdgeMode: getParameterDef("evolveEdgeMode").default,

    // ---------------- Binaural ----------------
    binauralAzimuth: getParameterDef("binauralAzimuth").default,
    binauralDistance: getParameterDef("binauralDistance").default,
    binauralStereoAngle: getParameterDef("binauralStereoAngle").default,

    // ---------------- Sort ----------------
    sortDirection: getParameterDef("sortDirection").default,
    sortOrder: getParameterDef("sortOrder").default,
    sortBy: getParameterDef("sortBy").default,
    sortStereoMode: getParameterDef("sortStereoMode").default,

    // ---------------- Transmute ----------------
    transmuteMode: getParameterDef("transmuteMode").default,
    transmuteAmount: getParameterDef("transmuteAmount").default,
    transmuteCurve: getParameterDef("transmuteCurve").default,

    // ---------------- Waveshape ----------------
    waveshapeMode: getParameterDef("waveshapeMode").default,
    waveshapeDrive: getParameterDef("waveshapeDrive").default,
    waveshapeTilt: getParameterDef("waveshapeTilt").default,

    // ---------------- Convolve ----------------
    convolveIrFile: null,
    convolveIrTimeOffset: getParameterDef("convolveIrTimeOffset").default,
    convolveIrPitchOffset: getParameterDef("convolveIrPitchOffset").default,
    convolveIrSize: getParameterDef("convolveIrSize").default,
    convolveGainDb: getParameterDef("convolveGainDb").default,
    convolveOrigin: getParameterDef("convolveOrigin").default,
  };
};
