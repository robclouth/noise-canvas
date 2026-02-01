import { getParameterDef } from "@renderer/parameters";
// Import from types module to avoid circular dependency with effects/index
import { DEFAULT_EFFECT_ORDER } from "../effects/types";
import type { EffectType } from "../effects/types";
import { shapes } from "../effects/overtones-shapes";

export interface EffectsState {
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
  blurBleed: boolean;
  blurOrigin: number;
  overtonesCount: number;
  overtonesScale: number;
  overtonesDecay: number;
  overtonesShape: keyof typeof shapes;
  effectOrder: { effect: EffectType; enabled: boolean }[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createEffectsSlice = (): EffectsState => {
  return {
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
    blurBleed: getParameterDef("blurBleed").default,
    blurOrigin: getParameterDef("blurOrigin").default,

    // ---------------- Overtones ----------------
    overtonesCount: getParameterDef("overtonesCount").default,
    overtonesScale: getParameterDef("overtonesScale").default,
    overtonesDecay: getParameterDef("overtonesDecay").default,
    overtonesShape: getParameterDef("overtonesShape").default,

    // ---------------- Synthesize ----------------
    synthesizeBrushType: getParameterDef("synthesizeBrushType").default,

    // ---------------- Effect order ----------------
    effectOrder: DEFAULT_EFFECT_ORDER,
  };
};
