import { deepMerge } from "@mantine/core";
import { EffectItem, syncEffects } from "@renderer/effects/types";
import { CONTEXTUAL_MOD_SOURCES, NUM_MACROS, NUM_MODULATORS } from "@renderer/lib/constants";
import { BrushStep, getParameterDef, isEffectParameter, isStepParameter, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { host } from "@renderer/lib/host";
import { APP_PERSISTED_KEYS, createAppSlice } from "./app";
import { AUDIO_PERSISTED_KEYS, createAudioSlice } from "./audio";
import { createBrushSlice } from "./brush";
import { createEffectsSlice } from "./effects";
import { createFilesSlice, FILES_PERSISTED_KEYS, openFiles } from "./files";
import { createLinkSlice, LINK_PERSISTED_KEYS } from "./link";
import { createModulatorsSlice } from "./modulators";
import { createPresetsSlice, PRESETS_PERSISTED_KEYS } from "./presets";
import { createStepsSlice, STEPS_PERSISTED_KEYS } from "./steps";
import type { ParameterKey, State } from "./types";
import { isManagedFilePath } from "./utils";

/**
 * Returns the 0-based macro index if `key` is `macro{N}Value`, else null.
 * Used to route reads/writes of macro value params to the active brush.
 */
export function getMacroValueIndex(key: ParameterKey): number | null {
  const match = /^macro(\d+)Value$/.exec(key as string);
  if (!match) return null;
  const idx = parseInt(match[1], 10) - 1;
  return idx >= 0 && idx < NUM_MACROS ? idx : null;
}

export const ALL_PERSISTED_KEYS: (keyof State)[] = [
  ...FILES_PERSISTED_KEYS,
  ...AUDIO_PERSISTED_KEYS,
  ...PRESETS_PERSISTED_KEYS,
  ...STEPS_PERSISTED_KEYS,
  ...LINK_PERSISTED_KEYS,
  ...APP_PERSISTED_KEYS,
  "randomizationAmounts",
  "excludedFromRandomization",
];

// localStorage-backed persistence that coalesces rapid writes. Each store change
// (e.g. one update per frame while dragging a parameter slider) would otherwise
// serialize the whole persisted slice and write it synchronously. This defers
// the serialize-and-write to a single trailing write, and flushes any pending
// write when the page is hidden or unloaded so the latest state is never lost.
function createDebouncedStorage<S>(delayMs: number): PersistStorage<S> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: StorageValue<S> } | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      localStorage.setItem(pending.name, JSON.stringify(pending.value));
      pending = null;
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  return {
    getItem: (name) => {
      const str = localStorage.getItem(name);
      return str ? (JSON.parse(str) as StorageValue<S>) : null;
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      pending = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      localStorage.removeItem(name);
    },
  };
}

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
        ...createLinkSlice(set, get),
        setParameter: (key: ParameterKey, value: unknown, effectId?: string) => {
          const state = get();
          const activeBrush = state.brushes[state.activeBrushIndex];
          const brushLinkedParams = activeBrush?.linkedParams ?? [];
          const isLinked = brushLinkedParams.includes(key as string);

          // Macro values live on the brush, not on step state. Route accordingly.
          const macroIdx = getMacroValueIndex(key);
          if (macroIdx !== null) {
            set(
              produce((draft: State) => {
                const brush = draft.brushes[draft.activeBrushIndex];
                if (brush && macroIdx < brush.macroValues.length) {
                  brush.macroValues[macroIdx] = value as number;
                }
              }),
            );
            return;
          }

          // If this is an effect parameter and effectId is provided, update the effect's params
          if (effectId && isEffectParameter(key)) {
            set(
              produce((draft: State) => {
                const brush = draft.brushes[draft.activeBrushIndex];
                if (!brush) return;
                const steps = brush.steps;

                const updateEffectParams = (step: (typeof steps)[0]) => {
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
                const brush = draft.brushes[draft.activeBrushIndex];
                if (!brush) return;
                const steps = brush.steps;
                if (isLinked) {
                  // Propagate to all steps when linked
                  steps.forEach((step) => {
                    (step as Record<string, unknown>)[key] = value;
                  });
                } else {
                  // Only update active step
                  if (steps[draft.activeStepIndex]) {
                    (steps[draft.activeStepIndex] as Record<string, unknown>)[key] = value;
                  }
                }
              }),
            );
          } else {
            set(
              produce((draft: State) => {
                (draft as unknown as Record<string, unknown>)[key] = value;
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
              const brush = draft.brushes[draft.activeBrushIndex];
              if (!brush) return;
              const linkedParams = brush.linkedParams;
              const index = linkedParams.indexOf(keyStr);
              if (linked && index === -1) {
                linkedParams.push(keyStr);
                // When enabling linking, sync current value to all steps
                if (isStepParameter(key)) {
                  const currentValue = brush.steps[draft.activeStepIndex]?.[key];
                  brush.steps.forEach((step) => {
                    (step as Record<string, unknown>)[key] = currentValue;
                  });
                }
              } else if (!linked && index !== -1) {
                linkedParams.splice(index, 1);
              }
            }),
          );
        },
      }),
      {
        name: "noise-canvas-storage",
        storage: createDebouncedStorage(300),
        partialize: (state) => {
          const picked = Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (key in parameterDefs || ALL_PERSISTED_KEYS.includes(key as keyof State)) {
                acc[key] = value;
              }
              return acc;
            },
            {} as Record<string, any>,
          );

          // Only persist file entries backed by a real on-disk path. Virtual files
          // (new/duplicate/stems) appear in openFileIds at runtime but must not round-trip
          // across sessions — they have no reanalysable source.
          const realIds = new Set(Object.keys(state.persistedFilePaths ?? {}));
          if (Array.isArray(picked.openFileIds)) {
            picked.openFileIds = picked.openFileIds.filter((id: string) => realIds.has(id));
          }
          if (Array.isArray(picked.minimizedFileIds)) {
            picked.minimizedFileIds = picked.minimizedFileIds.filter((id: string) => realIds.has(id));
          }
          if (typeof picked.activeFileId === "string" && !realIds.has(picked.activeFileId)) {
            picked.activeFileId = null;
          }
          if (typeof picked.fullscreenFileId === "string" && !realIds.has(picked.fullscreenFileId)) {
            picked.fullscreenFileId = null;
          }
          for (const mapKey of [
            "filesBandsPerOctave",
            "filesZoom",
            "filesOffset",
            "filesZoomY",
            "filesOffsetY",
            "filesPlaybackStartTime",
            "filesDirty",
            "fileDisplayNames",
          ] as const) {
            const map = picked[mapKey];
            if (map && typeof map === "object") {
              picked[mapKey] = Object.fromEntries(Object.entries(map).filter(([id]) => realIds.has(id)));
            }
          }
          return picked;
        },
        merge: (persistedState, currentState) => {
          const merged = deepMerge(currentState, persistedState as object) as State;

          // The Ableton extension always runs at compact density, regardless of
          // any persisted value.
          if (host.env.isExtension) merged.uiSize = "sm";

          // Sync effects in all steps to handle added/removed effects
          if (Array.isArray(merged.brushes)) {
            merged.brushes = merged.brushes.map((brush) => ({
              ...brush,
              steps: ((brush.steps ?? []) as unknown as Record<string, unknown>[]).map((step) => ({
                ...step,
                effects: syncEffects(step.effects as Parameters<typeof syncEffects>[0]),
              })) as unknown as BrushStep[],
            }));
          }

          // Seed module-level openFiles with placeholders for persisted entries so
          // components rendering on first paint don't see undefined, and mark each as loading.
          // displayName is provisional here — reopenPersistedFiles will overwrite it
          // (with an "Untitled N" for managed files, basename for real files).
          const persistedPaths = merged.persistedFilePaths ?? {};
          const persistedNames = merged.fileDisplayNames ?? {};
          for (const [id, filePath] of Object.entries(persistedPaths)) {
            const provisionalDisplayName =
              persistedNames[id] ?? (isManagedFilePath(filePath) ? "Untitled" : filePath.split("/").pop() || filePath);
            openFiles[id] ??= { id, filePath, displayName: provisionalDisplayName };
          }
          merged.filesLoading = {
            ...(merged.filesLoading ?? {}),
            ...Object.fromEntries(Object.keys(persistedPaths).map((id) => [id, "Loading..."])),
          };

          return merged;
        },
        onRehydrateStorage: () => (state) => {
          if (!state) return;
          void state.reopenPersistedFiles();
        },
      },
    ),
  ),
);

// Dev-only: expose the store on window so a CDP-attached driver can read state
// and toggle parameters for controlled, reproducible performance measurements.
if (import.meta.env.DEV) {
  (globalThis as unknown as { __store?: typeof useStore }).__store = useStore;
}

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
  const macroIdx = getMacroValueIndex(key);
  if (macroIdx !== null) {
    const brush = state.brushes[state.activeBrushIndex];
    if (brush) return brush.macroValues[macroIdx] ?? parameterDefs[key]?.default;
    return parameterDefs[key]?.default;
  }
  if (isStepParameter(key)) {
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
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
  const def = parameterDefs[paramKey];
  const contextualOnly = def?.kind === "number" && def.modulationSourcesAllowed === "contextualOnly";

  if (!contextualOnly) {
    // Modulator amounts (Mod1Amount, Mod2Amount, Mod3Amount)
    for (let i = 1; i <= NUM_MODULATORS; i++) {
      keys.push(`${paramKey}Mod${i}Amount` as ParameterKey);
    }
  }

  // Contextual mod amounts (ModIteration, ModTime, ModPitch, ModRandom, ModStep)
  for (const source of CONTEXTUAL_MOD_SOURCES) {
    keys.push(`${paramKey}Mod${source.key}` as ParameterKey);
  }

  if (!contextualOnly) {
    // Macro amounts (ModMacro1Amount..ModMacro4Amount)
    for (let i = 1; i <= NUM_MACROS; i++) {
      keys.push(`${paramKey}ModMacro${i}Amount` as ParameterKey);
    }
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
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
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

  // Override step parameters with values from the specific step in the active brush
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
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
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
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
