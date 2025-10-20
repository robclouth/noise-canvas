import { NUM_MODULATORS } from "../lib/constants";
import type { BaseParameterType, ModulatorAmountParameters, ParameterKey, State, ZustandSet } from "./types";

export const persistedKeys: (keyof State)[] = [
  "fileSettings",
  "effectOrder",
  "effectsEnabled",
  "sectionCollapsed",
  "presetHotkeys",
  "loop",
  "autoPlaybackPaintedRegion",
];

// Helper to generate unique file IDs
export function generateFileId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Internal helper for creating parameters without type constraints (used for dynamic modulator params)
export function createParameterInternal<T extends { value: unknown }>(
  set: ZustandSet,
  key: string,
  parameter: T,
  modulatable: boolean,
) {
  let params = {
    [key]: {
      ...parameter,
      setValue: (value: T["value"]) => set((state) => ({ [key]: { ...state[key], value } })),
      resetValue: () => set((state) => ({ [key]: { ...state[key], value: parameter.value } })),
      modulatorParamKeys: modulatable
        ? Array.from({ length: NUM_MODULATORS }).map(
            (_, i) => `${key}Mod${i + 1}Amount` as keyof ModulatorAmountParameters,
          )
        : undefined,
    },
  };

  if (modulatable) {
    params = {
      ...params,
      ...createModulatorParamsForParameter(set, key),
    };
  }

  return params;
}

// Type-safe createParameter that enforces the parameter structure matches the State type
export function createParameter<K extends ParameterKey>(
  set: ZustandSet,
  key: K,
  parameter: BaseParameterType<K>,
  modulatable: boolean,
) {
  return createParameterInternal(set, key as string, parameter as any, modulatable) as any;
}

export function createModulatorParamsForParameter(set: ZustandSet, key: string) {
  let params = {} as any;
  for (let i = 0; i < NUM_MODULATORS; i++) {
    const paramKey = `${key}Mod${i + 1}Amount`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Mod ${i + 1} Amount`,
          label: `Mod ${i + 1}`,
          value: 0,
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
          description:
            "The amount of modulation to apply. 0% is no modulation and only the value of the parameter is used, 100% is full modulation and the current value of the modulated parameter is ignored.",
        },
        false,
      ),
    };
  }
  return params;
}
