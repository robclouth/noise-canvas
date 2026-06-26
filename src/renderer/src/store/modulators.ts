import {
  getNumberParameterDef,
  getOptionsParameterDef,
  getStringParameterDef,
  parameterDefs,
} from "@renderer/parameters";
import { CONTEXTUAL_MOD_SOURCES, NUM_MACROS, NUM_MODULATORS } from "../lib/constants";
import type { ParameterKey } from "./types";

// Type for contextual mod source keys
export type ContextualModSourceKey = (typeof CONTEXTUAL_MOD_SOURCES)[number]["key"];

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

export type ModulatableParameterKey =
  | "brushIntensity"
  | "brushPan"
  | "brushCurveTime"
  | "brushSkewTime"
  | "brushCurvePitch"
  | "brushSkewPitch"
  | "dynamicsThresholdDb"
  | "dynamicsUpperRatio"
  | "dynamicsLowerRatio"
  | "dynamicsKnee"
  | "dynamicsGainDb"
  | "blurAmountTime"
  | "blurAmountPitch"
  | "blurNoiseTime"
  | "blurNoisePitch"
  | "harmonicsPower"
  | "harmonicsFalloff"
  | "transformShiftBeats"
  | "transformShiftSemis"
  | "transformScaleTime"
  | "transformScalePitch"
  | "transformRotation";

export type ModulatorAmountParameters = {
  [K in ModulatableParameterKey as `${K}Mod${Range<1, 4>}Amount`]: number;
};

// Contextual modulation amount parameters (iteration, time, pitch, random, step)
export type ContextualModAmountParameters = {
  [K in ModulatableParameterKey as `${K}Mod${ContextualModSourceKey}`]: number;
};

// Macro modulation amount parameters (Macro1..Macro4)
export type MacroModAmountParameters = {
  [K in ModulatableParameterKey as `${K}ModMacro${Range<1, 5>}Amount`]: number;
};

export type ModulatorParameters = {
  [K in Range<1, 4> as `modulator${K}Mode`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternShape`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateBeats`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateSemis`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}Strength`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}Rotation`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}StereoSpread`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PhaseMode`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeSmoothingBeats`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeSource`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMinDb`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMaxDb`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PhaseX`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PhaseY`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}TexturePath`]: string;
} & {
  [K in Range<1, 4> as `modulator${K}SeqStepsX`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}SeqStepsY`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}SeqLoopBeats`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}SeqLoopSemis`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}SeqSwing`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}SeqData`]: string;
};

export interface ModulatorsState
  extends ModulatorParameters,
    ModulatorAmountParameters,
    ContextualModAmountParameters,
    MacroModAmountParameters {}

function createModulatorParams(): ModulatorsState {
  const params: ModulatorsState = {
    ...Array.from({ length: NUM_MODULATORS }, (_, i) => i + 1).reduce((acc, idx) => {
      return {
        ...acc,
        [`modulator${idx}Mode`]: getOptionsParameterDef<number>(`modulator${idx}Mode` as keyof ModulatorsState).default,
        [`modulator${idx}PatternShape`]: getOptionsParameterDef<number>(
          `modulator${idx}PatternShape` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}PatternRateBeats`]: getNumberParameterDef(
          `modulator${idx}PatternRateBeats` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}PatternRateSemis`]: getNumberParameterDef(
          `modulator${idx}PatternRateSemis` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}Strength`]: getNumberParameterDef(`modulator${idx}Strength` as keyof ModulatorsState).default,
        [`modulator${idx}Rotation`]: getNumberParameterDef(`modulator${idx}Rotation` as keyof ModulatorsState).default,
        [`modulator${idx}StereoSpread`]: getNumberParameterDef(`modulator${idx}StereoSpread` as keyof ModulatorsState)
          .default,
        [`modulator${idx}TexturePath`]: getStringParameterDef(`modulator${idx}TexturePath` as keyof ModulatorsState)
          .default,
        [`modulator${idx}PhaseMode`]: getOptionsParameterDef<number>(
          `modulator${idx}PhaseMode` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}EnvelopeSmoothingBeats`]: getNumberParameterDef(
          `modulator${idx}EnvelopeSmoothingBeats` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}EnvelopeSource`]: getOptionsParameterDef<number>(
          `modulator${idx}EnvelopeSource` as keyof ModulatorsState,
        ).default,
        [`modulator${idx}EnvelopeMinDb`]: getNumberParameterDef(`modulator${idx}EnvelopeMinDb` as keyof ModulatorsState)
          .default,
        [`modulator${idx}EnvelopeMaxDb`]: getNumberParameterDef(`modulator${idx}EnvelopeMaxDb` as keyof ModulatorsState)
          .default,
        [`modulator${idx}PhaseX`]: getNumberParameterDef(`modulator${idx}PhaseX` as keyof ModulatorsState).default,
        [`modulator${idx}PhaseY`]: getNumberParameterDef(`modulator${idx}PhaseY` as keyof ModulatorsState).default,
        [`modulator${idx}SeqStepsX`]: getNumberParameterDef(`modulator${idx}SeqStepsX` as keyof ModulatorsState)
          .default,
        [`modulator${idx}SeqStepsY`]: getNumberParameterDef(`modulator${idx}SeqStepsY` as keyof ModulatorsState)
          .default,
        [`modulator${idx}SeqLoopBeats`]: getNumberParameterDef(`modulator${idx}SeqLoopBeats` as keyof ModulatorsState)
          .default,
        [`modulator${idx}SeqLoopSemis`]: getNumberParameterDef(`modulator${idx}SeqLoopSemis` as keyof ModulatorsState)
          .default,
        [`modulator${idx}SeqSwing`]: getNumberParameterDef(`modulator${idx}SeqSwing` as keyof ModulatorsState).default,
        [`modulator${idx}SeqData`]: getStringParameterDef(`modulator${idx}SeqData` as keyof ModulatorsState).default,
      };
    }, {} as ModulatorsState),
    ...Object.entries(parameterDefs).reduce((acc, [key, def]) => {
      if (def.kind === "number" && def.modulatable) {
        const contextualOnly = def.modulationSourcesAllowed === "contextualOnly";
        const modAmountEntries = contextualOnly
          ? {}
          : getModAmountParamKeys(key as ParameterKey).reduce((obj, k) => ({ ...obj, [k]: 0 }), {});
        const macroAmountEntries = contextualOnly
          ? {}
          : getMacroAmountParamKeys(key as ParameterKey).reduce((obj, k) => ({ ...obj, [k]: 0 }), {});
        return {
          ...acc,
          ...modAmountEntries,
          ...macroAmountEntries,
        };
      } else return acc;
    }, {} as ModulatorsState),
  };

  return params;
}

function isContextualOnly(paramKey: ParameterKey): boolean {
  const def = parameterDefs[paramKey];
  return def?.kind === "number" && def.modulationSourcesAllowed === "contextualOnly";
}

export function getModAmountParamKeys(paramKey: ParameterKey) {
  if (isContextualOnly(paramKey)) return [] as ParameterKey[];
  return Array.from({ length: NUM_MODULATORS }, (_, i) => i + 1).map(
    (modIdx) => `${paramKey}Mod${modIdx}Amount`,
  ) as ParameterKey[];
}

export function getModAmountValuesNormalized(state: ModulatorsState, paramKey: ParameterKey) {
  const keys = getModAmountParamKeys(paramKey);
  if (keys.length === 0) return Array.from({ length: NUM_MODULATORS }, () => 0);
  return keys.map((key) => (state[key] as number) / 100);
}

// True when any modulatable parameter routes to a modulator with a nonzero
// amount. When false, every modulator output is multiplied by zero at every
// consumer, so the precomputed modulator textures are never read and the
// precompute pass can be skipped. Macro and contextual modulation do not use
// those textures, so they are unaffected by this check.
export function hasActiveModulatorRouting(state: ModulatorsState): boolean {
  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.kind !== "number" || !def.modulatable) continue;
    const amounts = getModAmountValuesNormalized(state, key as ParameterKey);
    if (amounts.some((amount) => amount !== 0)) return true;
  }
  return false;
}

// True when a modulator's own parameter is modulated by a modulator or a macro
// (one level of nested modulation). When false the nested-source evaluation in
// the precompute pass is a no-op at every consumer and can be skipped. Macro
// routing is included because it modulates modulator parameters too, so skipping
// the nested block requires both to be absent.
export function hasNestedModulatorRouting(state: ModulatorsState): boolean {
  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.kind !== "number" || !def.modulatable) continue;
    if (!/^modulator\d/.test(key)) continue;
    const modAmounts = getModAmountValuesNormalized(state, key as ParameterKey);
    if (modAmounts.some((amount) => amount !== 0)) return true;
    const macroAmounts = getMacroAmountValuesNormalized(state, key as ParameterKey);
    if (macroAmounts.some((amount) => amount !== 0)) return true;
  }
  return false;
}

// Get contextual mod amount parameter keys for a given parameter
export function getContextualModAmountParamKeys(paramKey: ParameterKey) {
  return CONTEXTUAL_MOD_SOURCES.map((source) => `${paramKey}Mod${source.key}`) as ParameterKey[];
}

// Get normalized contextual mod amounts as an array [iteration, time, pitch, random, step]
export function getContextualModAmountsNormalized(state: ModulatorsState, paramKey: ParameterKey) {
  return getContextualModAmountParamKeys(paramKey).map((key) => (state[key] as number) / 100);
}

// Get macro mod amount parameter keys for a given parameter
export function getMacroAmountParamKeys(paramKey: ParameterKey) {
  if (isContextualOnly(paramKey)) return [] as ParameterKey[];
  return Array.from({ length: NUM_MACROS }, (_, i) => i + 1).map(
    (macroIdx) => `${paramKey}ModMacro${macroIdx}Amount`,
  ) as ParameterKey[];
}

// Get normalized macro mod amounts as an array [macro1, macro2, macro3, macro4]
export function getMacroAmountValuesNormalized(state: ModulatorsState, paramKey: ParameterKey) {
  const keys = getMacroAmountParamKeys(paramKey);
  if (keys.length === 0) return Array.from({ length: NUM_MACROS }, () => 0);
  return keys.map((key) => (state[key] as number) / 100);
}

export const createModulatorsSlice = (): ModulatorsState => ({
  ...createModulatorParams(),
});
