import { deepMerge } from "@mantine/core";
import { EffectItem, syncEffects } from "@renderer/effects/types";
import { CONTEXTUAL_MOD_SOURCES, NUM_MACROS, NUM_MODULATORS } from "@renderer/lib/constants";
import { pickNextStepColor } from "@renderer/lib/colors";
import { sanitizeEffectParams, sanitizeStepParams } from "@renderer/lib/preset-schema";
import {
  BrushStep,
  getParameterDef,
  getQuantizeParamKey,
  isEffectParameter,
  isStepParameter,
  isStorableOptionValue,
  parameterDefs,
} from "@renderer/parameters";
import { produce } from "immer";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { host } from "@renderer/lib/host";
import { gatherFileGroups } from "@renderer/lib/file-reorder";
import { readTruth } from "@renderer/lib/drive-truth";
import { APP_PERSISTED_KEYS, createAppSlice } from "./app";
import { AUDIO_PERSISTED_KEYS, createAudioSlice } from "./audio";
import { createBrushSlice } from "./brush";
import { createEffectsSlice } from "./effects";
import { createFilesSlice, FILES_PERSISTED_KEYS, openFiles } from "./files";
import { createFillSlice } from "./fill";
import { createSelectionAuditionSlice } from "./selection-audition";
import { createSelectionClipboardSlice } from "./selection-clipboard";
import { createSelectionRippleSlice } from "./selection-ripple";
import { createLinkSlice, LINK_PERSISTED_KEYS } from "./link";
import { createModulatorsSlice } from "./modulators";
import { createPalettesSlice, makeDefaultPalette, PALETTES_PERSISTED_KEYS } from "./palettes";
import { DEFAULT_PALETTE_ID } from "./palette-id";
import { createPresetsSlice, PRESETS_PERSISTED_KEYS } from "./presets";
import { createSectionPresetsSlice } from "./section-presets";
import { createLayerStacksSlice, LAYER_STACKS_PERSISTED_KEYS, selectStackLayerIds, migrateLayerStacks } from "./layers";
import { createStepsSlice, STEPS_PERSISTED_KEYS } from "./steps";
import { seedLinkedEffectParam, seedLinkedStepParam, writeEffectParam } from "./effect-param-linking";
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
  ...PALETTES_PERSISTED_KEYS,
  ...STEPS_PERSISTED_KEYS,
  ...LINK_PERSISTED_KEYS,
  ...LAYER_STACKS_PERSISTED_KEYS,
  ...APP_PERSISTED_KEYS,
  "randomizationAmounts",
  "excludedFromRandomization",
];

// Host-backed persistence that coalesces rapid writes. Each store change
// (e.g. one update per frame while dragging a parameter slider) would otherwise
// serialize the whole persisted slice and write it synchronously. This defers
// the serialize-and-write to a single trailing write, and flushes any pending
// write when the page is hidden or unloaded so the latest state is never lost.
//
// The persisted-slice projection (`partialize`) is applied here at flush time,
// not on every store change. zustand runs the persist `partialize` on every set;
// doing the real work there allocates a large object every dragged frame for a
// write that is about to be coalesced away. Keeping persist's partialize an
// identity and projecting only when we actually serialize removes that per-frame
// allocation (a meaningful source of GC pauses while dragging).
function createDebouncedStorage<S>(delayMs: number, project: (state: S) => unknown): PersistStorage<S> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let pending: { name: string; value: StorageValue<S> } | null = null;

  const write = () => {
    idle = null;
    if (!pending) return;
    const serializable = { ...pending.value, state: project(pending.value.state) };
    host.prefs.write(pending.name, JSON.stringify(serializable));
    pending = null;
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (idle !== null) {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle as unknown as ReturnType<typeof setTimeout>);
      idle = null;
    }
  };

  // The projection and the write together are the largest step of a dragged
  // frame, so they wait for the frame's spare time. The timeout bounds the
  // wait, and a hidden or unloading page still writes at once.
  const schedule = () => {
    timer = null;
    if (idle !== null) return;
    idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(write, { timeout: 1000 })
        : (setTimeout(write, 0) as unknown as number);
  };

  const flush = () => {
    cancel();
    write();
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
      const str = host.prefs.read(name);
      return str ? (JSON.parse(str) as StorageValue<S>) : null;
    },
    setItem: (name, value) => {
      pending = { name, value };
      cancel();
      timer = setTimeout(schedule, delayMs);
    },
    removeItem: (name) => {
      pending = null;
      cancel();
      host.prefs.remove(name);
    },
  };
}

// Projects the full state down to the persisted slice. Runs only when a write is
// actually serialized (at the debounced flush), not on every store change.
function persistProjection(state: State): Record<string, unknown> {
  const picked = Object.entries(state).reduce(
    (acc, [key, value]) => {
      if (key in parameterDefs || ALL_PERSISTED_KEYS.includes(key as keyof State)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, any>,
  );

  // Only persist file entries that have somewhere to be rehydrated from. That
  // covers real on-disk paths and the `managed://` sentinels of virtual files
  // (new/duplicate/stems), which reopenPersistedFiles restores from their
  // history dir; anything else is dropped.
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

  // Groups follow their members: drop any member that isn't coming back,
  // and drop the group itself once nothing is left in it.
  const groups = picked.layerStacks as Record<string, { layerIds: string[] }> | undefined;
  if (groups && typeof groups === "object") {
    const keptGroups: Record<string, unknown> = {};
    const keptOfFile: Record<string, string> = {};
    for (const [stackId, group] of Object.entries(groups)) {
      const layerIds = (group.layerIds ?? []).filter((id) => realIds.has(id));
      if (layerIds.length === 0) continue;
      keptGroups[stackId] = { ...group, layerIds };
      for (const id of layerIds) keptOfFile[id] = stackId;
    }
    picked.layerStacks = keptGroups;
    picked.stackOfLayer = keptOfFile;
  }

  return picked;
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
        ...createAppSlice(set),
        ...createPresetsSlice(set, get),
        ...createPalettesSlice(set, get),
        ...createSectionPresetsSlice(set, get),
        ...createStepsSlice(set, get),
        ...createLinkSlice(set, get),
        ...createLayerStacksSlice(set, get),
        ...createFillSlice(set, get),
        ...createSelectionAuditionSlice(set, get),
        ...createSelectionClipboardSlice(set, get),
        ...createSelectionRippleSlice(set, get),
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
                if (brush) writeEffectParam(brush, draft.activeStepIndex, effectId, key, value, isLinked);
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
        setParamLinked: (key: ParameterKey, linked: boolean, effectId?: string) => {
          set(
            produce((draft: State) => {
              const keyStr = key as string;
              const brush = draft.brushes[draft.activeBrushIndex];
              if (!brush) return;
              const linkedParams = brush.linkedParams;
              const index = linkedParams.indexOf(keyStr);
              if (linked && index === -1) {
                linkedParams.push(keyStr);
                // Linking is one brush-wide switch, so every step joins at once.
                if (effectId && isEffectParameter(key)) {
                  seedLinkedEffectParam(brush, draft.activeStepIndex, effectId, key);
                } else if (isStepParameter(key)) {
                  seedLinkedStepParam(brush, key);
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
        // The real persisted-slice projection runs at flush time inside the
        // storage (see persistProjection / createDebouncedStorage). Keeping this
        // an identity avoids allocating the projected object on every store change.
        storage: createDebouncedStorage(300, persistProjection),
        partialize: (state) => state,
        merge: (persistedState, currentState) => {
          // App-wide parameters persist beside the brushes. Dropping a stored
          // value for an option that has since been retired leaves the current
          // default in its place, rather than merging it over the top.
          const stored = (persistedState ?? {}) as Record<string, unknown>;
          for (const key of Object.keys(parameterDefs) as ParameterKey[]) {
            if (key in stored && !isStorableOptionValue(key, stored[key])) delete stored[key];
          }

          // Layer stacks were keyed as stems, then as file groups, before the
          // files in one became the layers of a stack.
          const priorStacks = stored.stemGroups ?? stored.fileGroups;
          const priorOf = stored.stemGroupOfFile ?? stored.fileGroupOfFile;
          if (priorStacks && !stored.layerStacks) {
            stored.layerStacks = priorStacks;
            stored.stackOfLayer = priorOf;
          }
          stored.layerStacks = migrateLayerStacks(stored.layerStacks);
          delete stored.stemGroups;
          delete stored.stemGroupOfFile;
          delete stored.fileGroups;
          delete stored.fileGroupOfFile;

          const merged = deepMerge(currentState, stored) as State;

          if (host.env.isExtension) {
            // The Ableton extension always runs at compact density, regardless
            // of any persisted value.
            merged.uiSize = "sm";
            // The clip opened from Ableton becomes the active file; don't restore
            // a stale active id from a previous session.
            merged.activeFileId = null;
          }

          // Brushes saved before palettes existed have no group, and so do any
          // whose group is gone. Both land in the default palette, which has to
          // be open for them to show up. A palette that holds nothing stays.
          if (Array.isArray(merged.brushes)) {
            const palettes = merged.openPalettes ?? [];
            const groupIds = new Set(palettes.map((palette) => palette.id));
            merged.brushes = merged.brushes.map((brush) =>
              brush.paletteId && groupIds.has(brush.paletteId) ? brush : { ...brush, paletteId: DEFAULT_PALETTE_ID },
            );
            const needsDefault = merged.brushes.some((brush) => brush.paletteId === DEFAULT_PALETTE_ID);
            merged.openPalettes =
              needsDefault && !groupIds.has(DEFAULT_PALETTE_ID) ? [makeDefaultPalette(), ...palettes] : palettes;
            if (merged.openPalettes.length === 0) merged.openPalettes = [makeDefaultPalette()];
          }

          // Sync effects in all steps to handle added/removed effects, and
          // assign palette colors to steps saved before step colors existed.
          if (Array.isArray(merged.brushes)) {
            merged.brushes = merged.brushes.map((brush) => {
              const steps = ((brush.steps ?? []) as unknown as Record<string, unknown>[]).map((step) => ({
                ...sanitizeStepParams(step),
                effects: syncEffects(step.effects as Parameters<typeof syncEffects>[0]).map((item) => ({
                  ...item,
                  params: sanitizeEffectParams(item.params),
                })),
              })) as unknown as BrushStep[];
              steps.forEach((step, index) => {
                if (!step.color) {
                  steps[index] = { ...step, color: pickNextStepColor(steps.map((s) => s.color)) };
                }
              });
              return { ...brush, steps };
            });
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

          // A group draws one bracket over one run of lanes, so a stored order
          // that leaves a group straddling another file closes back up.
          if (Array.isArray(merged.openFileIds)) {
            merged.openFileIds = gatherFileGroups(merged.openFileIds, merged.stackOfLayer ?? {});
          }

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

useStore.subscribe(
  (state) => ({
    activeFileId: state.activeFileId,
    ids: state.activeFileId ? selectStackLayerIds(state, state.activeFileId) : [],
  }),
  () => useStore.getState().reconcileLayerPlayback(),
  {
    equalityFn: (a, b) =>
      a.activeFileId === b.activeFileId &&
      a.ids.length === b.ids.length &&
      a.ids.every((id, index) => id === b.ids[index]),
  },
);

// Dev builds and debug-globals builds expose the store on window so a
// CDP-attached driver can read state and seed a brush.
if (import.meta.env.DEV || import.meta.env.VITE_DEBUG_GLOBALS === "1") {
  (globalThis as unknown as { __store?: typeof useStore }).__store = useStore;
  (globalThis as unknown as { __readTruth?: typeof readTruth }).__readTruth = readTruth;
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

  const quantizeKey = getQuantizeParamKey(paramKey);
  if (quantizeKey) keys.push(quantizeKey);

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
// A step view is built once per state object and step. A state is never
// changed in place, so the cached view answers every later reader of it.
const stepStateViews = new WeakMap<State, Map<number, State>>();
let stepParameterKeys: ParameterKey[] | null = null;

export function createStepStateView(state: State, stepIndex: number): State {
  let views = stepStateViews.get(state);
  if (!views) {
    views = new Map();
    stepStateViews.set(state, views);
  }
  const cached = views.get(stepIndex);
  if (cached) return cached;

  stepParameterKeys ??= (Object.keys(parameterDefs) as ParameterKey[]).filter((key) => isStepParameter(key));
  const view = { ...state } as Record<string, unknown>;
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const step = steps[stepIndex];
  if (step) {
    for (const key of stepParameterKeys) {
      view[key] = key in step ? step[key] : parameterDefs[key]?.default;
    }
  }
  const built = view as unknown as State;
  views.set(stepIndex, built);
  return built;
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
// Cached like the step view: neither the state nor an effect item is changed
// in place, so one view answers every later reader of the same pair.
const effectStateViews = new WeakMap<State, Map<number, WeakMap<EffectItem, State>>>();

export function createEffectStateView(state: State, stepIndex: number, effectItem: EffectItem): State {
  const stepView = createStepStateView(state, stepIndex);
  if (!effectItem.params) return stepView;

  let byStep = effectStateViews.get(state);
  if (!byStep) {
    byStep = new Map();
    effectStateViews.set(state, byStep);
  }
  let byItem = byStep.get(stepIndex);
  if (!byItem) {
    byItem = new WeakMap();
    byStep.set(stepIndex, byItem);
  }
  const cached = byItem.get(effectItem);
  if (cached) return cached;

  // Merge effect params into the view
  const built = { ...stepView, ...effectItem.params } as State;
  byItem.set(effectItem, built);
  return built;
}
