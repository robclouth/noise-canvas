import { deepMerge } from "@mantine/core";
import { isStepParameter, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import { createAppSlice } from "./app";
import { AUDIO_PERSISTED_KEYS, createAudioSlice } from "./audio";
import { createBrushSlice } from "./brush";
import { createEffectsSlice } from "./effects";
import { createFilesSlice, FILES_PERSISTED_KEYS } from "./files";
import { createModulatorsSlice } from "./modulators";
import { createPresetsSlice, PRESETS_PERSISTED_KEYS } from "./presets";
import { createStepsSlice, STEPS_PERSISTED_KEYS } from "./steps";
import type { ParameterKey, State } from "./types";

export const ALL_PERSISTED_KEYS: (keyof State)[] = [
  ...FILES_PERSISTED_KEYS,
  ...AUDIO_PERSISTED_KEYS,
  ...PRESETS_PERSISTED_KEYS,
  ...STEPS_PERSISTED_KEYS,
];

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...createBrushSlice(set),
        ...createEffectsSlice(),
        ...createModulatorsSlice(),
        ...createFilesSlice(set, get),
        ...createAudioSlice(set, get),
        ...createAppSlice(set),
        ...createPresetsSlice(set, get),
        ...createStepsSlice(set, get),
        setParameter: (key: ParameterKey, value: any) => {
          // If this is a step parameter, update the active step
          if (isStepParameter(key)) {
            set(
              produce((draft: State) => {
                if (draft.steps[draft.activeStepIndex]) {
                  draft.steps[draft.activeStepIndex][key] = value;
                }
              }),
            );
          } else {
            set({ [key]: value });
          }
        },
      }),
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (key in parameterDefs || ALL_PERSISTED_KEYS.includes(key as keyof State)) {
                acc[key] = value;
              }
              return acc;
            },
            {} as Record<string, any>,
          );
        },
        merge: (persistedState, currentState) => deepMerge(currentState, persistedState),
      },
    ),
  ),
);

export function getModulator(index: number) {
  const state = useStore.getState();
  return {
    modulatorMode: state[`modulator${index}Mode` as ParameterKey],
    modulatorPatternShape: state[`modulator${index}PatternShape` as ParameterKey],
    modulatorPatternRateBeats: state[`modulator${index}PatternRateBeats` as ParameterKey],
    modulatorPatternRateSemis: state[`modulator${index}PatternRateSemis` as ParameterKey],
    modulatorStrength: state[`modulator${index}Strength` as ParameterKey],
    modulatorRotation: state[`modulator${index}Rotation` as ParameterKey],
    modulatorPhaseMode: state[`modulator${index}PhaseMode` as ParameterKey],
  };
}

/**
 * Get a parameter value, respecting step parameters.
 * For step parameters, returns the value from the active step.
 * For non-step parameters, returns the value from state directly.
 * Falls back to parameter defaults if the step doesn't have a value.
 */
export function getParameterValue(state: State, key: ParameterKey): any {
  if (isStepParameter(key)) {
    const activeStep = state.steps[state.activeStepIndex];
    if (activeStep && key in activeStep) {
      return activeStep[key];
    }
    // Fall back to parameter default
    const def = parameterDefs[key];
    if (def) {
      return def.default;
    }
  }
  return state[key];
}

/**
 * Get a parameter value from a specific step.
 * For step parameters, returns the value from the specified step.
 * For non-step parameters, returns the value from state directly.
 */
export function getStepParameterValue(state: State, stepIndex: number, key: ParameterKey): any {
  if (isStepParameter(key)) {
    const step = state.steps[stepIndex];
    return step?.[key];
  }
  return state[key];
}

/**
 * Selector for use with useStore to get a step-aware parameter value
 */
export function selectParameter(key: ParameterKey) {
  return (state: State) => getParameterValue(state, key);
}

/**
 * Creates a view state object that returns step parameter values from a specific step.
 * This allows existing code that reads from state to work with step-aware values.
 * Falls back to parameter defaults if the step doesn't have a value.
 */
export function createStepStateView(state: State, stepIndex: number): State {
  // Create a shallow copy to avoid proxy-on-proxy issues
  const view = { ...state } as Record<string, unknown>;

  // Override step parameters with values from the specific step
  const step = state.steps[stepIndex];
  if (step) {
    Object.keys(parameterDefs).forEach((key) => {
      if (isStepParameter(key as ParameterKey)) {
        if (key in step) {
          view[key] = step[key as ParameterKey];
        } else {
          // Fall back to parameter default if not in step
          const def = parameterDefs[key as ParameterKey];
          if (def) {
            view[key] = def.default;
          }
        }
      }
    });
  }

  return view as unknown as State;
}
