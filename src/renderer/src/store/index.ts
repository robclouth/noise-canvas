import { deepMerge } from "@mantine/core";
import { EffectItem, syncEffects } from "@renderer/effects/types";
import { CONTEXTUAL_MOD_SOURCES, NUM_MODULATORS } from "@renderer/lib/constants";
import { getParameterDef, isEffectParameter, isStepParameter, parameterDefs } from "@renderer/parameters";
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
  "randomizationAmounts",
  "excludedFromRandomization",
];

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...createBrushSlice(set, get),
        ...createEffectsSlice(),
        ...createModulatorsSlice(),
        ...createFilesSlice(set, get),
        ...createAudioSlice(set, get),
        ...createAppSlice(set, get),
        ...createPresetsSlice(set, get),
        ...createStepsSlice(set, get),
        setParameter: (key: ParameterKey, value: any, effectId?: string) => {
          const state = get();
          const slotLinkedParams = state.slotLinkedParams[state.activeSlotIndex] ?? [];
          const isLinked = slotLinkedParams.includes(key as string);

          // If this is an effect parameter and effectId is provided, update the effect's params
          if (effectId && isEffectParameter(key)) {
            set(
              produce((draft: State) => {
                draft.slotDirty[draft.activeSlotIndex] = true;
                const steps = draft.slots[draft.activeSlotIndex];
                if (!steps) return;

                const updateEffectParams = (step: typeof steps[0]) => {
                  const effects = (step.effects ?? []) as EffectItem[];
                  const effectIndex = effects.findIndex((e) => e.id === effectId);
                  if (effectIndex >= 0) {
                    if (!effects[effectIndex].params) {
                      effects[effectIndex].params = {};
                    }
                    effects[effectIndex].params[key] = value;
                  }
                };

                if (isLinked) {
                  steps.forEach(updateEffectParams);
                } else if (steps[draft.activeStepIndex]) {
                  updateEffectParams(steps[draft.activeStepIndex]);
                }
              }),
            );
          } else if (isStepParameter(key)) {
            // If this is a step parameter, update the active step (or all steps if linked)
            set(
              produce((draft: State) => {
                draft.slotDirty[draft.activeSlotIndex] = true;
                const steps = draft.slots[draft.activeSlotIndex];
                if (!steps) return;
                if (isLinked) {
                  // Propagate to all steps when linked
                  steps.forEach((step) => {
                    step[key] = value;
                  });
                } else {
                  // Only update active step
                  if (steps[draft.activeStepIndex]) {
                    steps[draft.activeStepIndex][key] = value;
                  }
                }
              }),
            );
          } else {
            set(
              produce((draft: State) => {
                draft[key] = value;
                draft.slotDirty[draft.activeSlotIndex] = true;
              }),
            );
          }
        },
        randomizationAmounts: {},
        setRandomizationAmount: (key: string, amount: number) => {
          set(
            produce((draft: State) => {
              if (amount === 0) {
                delete draft.randomizationAmounts[key];
              } else {
                draft.randomizationAmounts[key] = amount;
              }
            }),
          );
        },
        excludedFromRandomization: [],
        setParamExcluded: (key: ParameterKey, excluded: boolean) => {
          set(
            produce((draft: State) => {
              const keyStr = key as string;
              const index = draft.excludedFromRandomization.indexOf(keyStr);
              if (excluded && index === -1) {
                draft.excludedFromRandomization.push(keyStr);
              } else if (!excluded && index !== -1) {
                draft.excludedFromRandomization.splice(index, 1);
              }
            }),
          );
        },
        setParamLinked: (key: ParameterKey, linked: boolean) => {
          set(
            produce((draft: State) => {
              const keyStr = key as string;
              const slotIndex = draft.activeSlotIndex;
              if (!draft.slotLinkedParams[slotIndex]) {
                draft.slotLinkedParams[slotIndex] = [];
              }
              const linkedParams = draft.slotLinkedParams[slotIndex];
              const index = linkedParams.indexOf(keyStr);
              if (linked && index === -1) {
                linkedParams.push(keyStr);
                draft.slotDirty[slotIndex] = true;
                // When enabling linking, sync current value to all steps
                if (isStepParameter(key)) {
                  const steps = draft.slots[slotIndex];
                  if (steps) {
                    const currentValue = steps[draft.activeStepIndex]?.[key];
                    steps.forEach((step) => {
                      step[key] = currentValue;
                    });
                  }
                }
              } else if (!linked && index !== -1) {
                linkedParams.splice(index, 1);
                draft.slotDirty[slotIndex] = true;
              }
            }),
          );
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
        merge: (persistedState, currentState) => {
          const merged = deepMerge(currentState, persistedState) as State;

          // Sync effects in all slots/steps to handle added/removed effects
          // Also handle migration from effectOrder to effects
          if (merged.slots && Array.isArray(merged.slots)) {
            merged.slots = merged.slots.map((slot) => {
              if (!slot || !Array.isArray(slot)) return slot;
              return slot.map((step: Record<string, unknown>) => {
                if (!step) return step;
                // Handle migration from effectOrder to effects
                const effectsData = step.effects ?? step.effectOrder;
                const newStep = { ...step };
                delete newStep.effectOrder;
                return {
                  ...newStep,
                  effects: syncEffects(effectsData as Parameters<typeof syncEffects>[0]),
                };
              });
            });
          }

          return merged;
        },
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
    modulatorPhaseX: state[`modulator${index}PhaseX` as ParameterKey],
    modulatorPhaseY: state[`modulator${index}PhaseY` as ParameterKey],
  };
}

/**
 * Get a parameter value, respecting step parameters.
 * For step parameters, returns the value from the active step in the active slot.
 * For non-step parameters, returns the value from state directly.
 * Falls back to parameter defaults if the step doesn't have a value.
 */
export function getParameterValue(state: State, key: ParameterKey): any {
  if (isStepParameter(key)) {
    const steps = state.slots[state.activeSlotIndex] ?? [];
    const activeStep = steps[state.activeStepIndex];
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
 * Get modulation amount parameter keys for a given parameter
 * Returns keys like: brushIntensityMod1Amount, brushIntensityMod2Amount, etc.
 */
export function getModulationParamKeys(paramKey: ParameterKey): ParameterKey[] {
  const keys: ParameterKey[] = [];

  // Modulator amounts (Mod1Amount, Mod2Amount, Mod3Amount)
  for (let i = 1; i <= NUM_MODULATORS; i++) {
    keys.push(`${paramKey}Mod${i}Amount` as ParameterKey);
  }

  // Contextual mod amounts (ModIteration, ModTime, ModPitch, ModRandom, ModStep)
  for (const source of CONTEXTUAL_MOD_SOURCES) {
    keys.push(`${paramKey}Mod${source.key}` as ParameterKey);
  }

  return keys;
}

/**
 * Get a parameter value from a specific step in the active slot.
 * For step parameters, returns the value from the specified step.
 * For non-step parameters, returns the value from state directly.
 */
export function getStepParameterValue(state: State, stepIndex: number, key: ParameterKey): any {
  if (isStepParameter(key)) {
    const steps = state.slots[state.activeSlotIndex] ?? [];
    const step = steps[stepIndex];
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
 * Creates a view state object that returns step parameter values from a specific step in the active slot.
 * This allows existing code that reads from state to work with step-aware values.
 * Falls back to parameter defaults if the step doesn't have a value.
 */
export function createStepStateView(state: State, stepIndex: number): State {
  // Create a shallow copy to avoid proxy-on-proxy issues
  const view = { ...state } as Record<string, unknown>;

  // Override step parameters with values from the specific step in the active slot
  const steps = state.slots[state.activeSlotIndex] ?? [];
  const step = steps[stepIndex];
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

/**
 * Get an effect parameter value from a specific effect instance.
 * Returns the value from the effect's params, or the parameter default if not set.
 */
export function getEffectParameterValue(state: State, effectId: string, key: ParameterKey): unknown {
  const steps = state.slots[state.activeSlotIndex] ?? [];
  const activeStep = steps[state.activeStepIndex];
  if (!activeStep) return getParameterDef(key).default;

  const effects = (activeStep.effects ?? []) as EffectItem[];
  const effect = effects.find((e) => e.id === effectId);
  if (effect?.params && key in effect.params) {
    return effect.params[key];
  }

  // Fall back to parameter default
  return getParameterDef(key).default;
}

/**
 * Selector for use with useStore to get an effect parameter value
 */
export function selectEffectParameter(effectId: string, key: ParameterKey) {
  return (state: State) => getEffectParameterValue(state, effectId, key);
}

/**
 * Creates a view state object that includes effect-specific parameter values.
 * Used by the renderer to get parameters for a specific effect instance.
 */
export function createEffectStateView(state: State, stepIndex: number, effectItem: EffectItem): State {
  const stepView = createStepStateView(state, stepIndex);
  if (!effectItem.params) return stepView;

  // Merge effect params into the view
  return { ...stepView, ...effectItem.params } as State;
}

