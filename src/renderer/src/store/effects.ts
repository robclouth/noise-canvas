import { DEFAULT_EFFECTS, EffectItem } from "@renderer/effects/types";
import { getParameterDef } from "@renderer/parameters";
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
  blurBleed: boolean;
  blurOrigin: number;
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
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    blurBleed: getParameterDef("blurBleed").default,
    blurOrigin: getParameterDef("blurOrigin").default,

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
  };
};
