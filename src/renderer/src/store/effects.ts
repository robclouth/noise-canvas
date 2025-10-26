import { parameterDefs } from "@renderer/parameters";
import { effects, EffectType } from "../effects";
import { shapes } from "../effects/overtones-shapes";
import type { ZustandGet, ZustandSet } from "./types";

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

const DEFAULT_EFFECT_ORDER = Object.keys(effects)
  .filter((key) => key !== "passthrough")
  .map((k) => ({ effect: k as EffectType, enabled: false }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createEffectsSlice = (set: ZustandSet, get: ZustandGet): EffectsState => {
  return {
    // ---------------- Dynamics ----------------
    dynamicsThresholdDb: parameterDefs.dynamicsThresholdDb.default,
    dynamicsUpperRatio: parameterDefs.dynamicsUpperRatio.default,
    dynamicsLowerRatio: parameterDefs.dynamicsLowerRatio.default,
    dynamicsKnee: parameterDefs.dynamicsKnee.default,
    dynamicsGainDb: parameterDefs.dynamicsGainDb.default,

    // ---------------- Transform ----------------
    transformShiftBeats: parameterDefs.transformShiftBeats.default,
    transformShiftSemis: parameterDefs.transformShiftSemis.default,
    transformScaleTime: parameterDefs.transformScaleTime.default,
    transformScalePitch: parameterDefs.transformScalePitch.default,
    transformRotation: parameterDefs.transformRotation.default,
    transformEdgeMode: parameterDefs.transformEdgeMode.default,

    // ---------------- Blur ----------------
    blurAmountTime: parameterDefs.blurAmountTime.default,
    blurAmountPitch: parameterDefs.blurAmountPitch.default,
    blurNoiseTime: parameterDefs.blurNoiseTime.default,
    blurNoisePitch: parameterDefs.blurNoisePitch.default,
    blurBleed: parameterDefs.blurBleed.default,
    blurOrigin: parameterDefs.blurOrigin.default,

    // ---------------- Overtones ----------------
    overtonesCount: parameterDefs.overtonesCount.default,
    overtonesScale: parameterDefs.overtonesScale.default,
    overtonesDecay: parameterDefs.overtonesDecay.default,
    overtonesShape: parameterDefs.overtonesShape.default,

    // ---------------- Synthesize ----------------
    synthesizeBrushType: parameterDefs.synthesizeBrushType.default,

    // ---------------- Effect order ----------------
    effectOrder: DEFAULT_EFFECT_ORDER,
  };
};
