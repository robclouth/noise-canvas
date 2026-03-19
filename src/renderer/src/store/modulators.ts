import {
  getNumberParameterDef,
  getOptionsParameterDef,
  getStringParameterDef,
  parameterDefs,
} from "@renderer/parameters";
import { CONTEXTUAL_MOD_SOURCES, NUM_MODULATORS } from "../lib/constants";
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

export type ModulatorParameters = {
  [K in Range<1, 4> as `modulator${K}Mode`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternShape`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateBeats`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateSemis`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRadial`]: boolean;
} & {
  [K in Range<1, 4> as `modulator${K}Strength`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}Rotation`]: number;
} & {
  [K in Range<1, 4> as `modulator${K}ImagePath`]: string | null;
} & {
  [K in Range<1, 4> as `setModulator${K}ImagePath`]: (path: string | null) => void;
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
};

export interface ModulatorsState
  extends ModulatorParameters,
    ModulatorAmountParameters,
    ContextualModAmountParameters {}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      };
    }, {} as ModulatorsState),
    ...Object.entries(parameterDefs).reduce((acc, [key, def]) => {
      if (def.kind === "number" && def.modulatable) {
        return {
          ...acc,
          ...getModAmountParamKeys(key as ParameterKey).reduce((obj, key) => {
            return {
              ...obj,
              [key]: 0,
            };
          }, {} as ModulatorAmountParameters),
        };
      } else return acc;
    }, {} as ModulatorsState),
  };

  return params;
}

export function getModAmountParamKeys(paramKey: ParameterKey) {
  return Array.from({ length: NUM_MODULATORS }, (_, i) => i + 1).map(
    (modIdx) => `${paramKey}Mod${modIdx}Amount`,
  ) as ParameterKey[];
}

export function getModAmountValuesNormalized(state: ModulatorsState, paramKey: ParameterKey) {
  return getModAmountParamKeys(paramKey).map((key) => (state[key] as number) / 100);
}

// Get contextual mod amount parameter keys for a given parameter
export function getContextualModAmountParamKeys(paramKey: ParameterKey) {
  return CONTEXTUAL_MOD_SOURCES.map((source) => `${paramKey}Mod${source.key}`) as ParameterKey[];
}

// Get normalized contextual mod amounts as an array [iteration, time, pitch, random, step]
export function getContextualModAmountsNormalized(state: ModulatorsState, paramKey: ParameterKey) {
  return getContextualModAmountParamKeys(paramKey).map((key) => (state[key] as number) / 100);
}

export const createModulatorsSlice = (): ModulatorsState => ({
  ...createModulatorParams(),
});
