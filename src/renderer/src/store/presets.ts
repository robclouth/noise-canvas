import { notifications } from "@mantine/notifications";
import { pickNextBrushColor, pickNextStepColor } from "@renderer/lib/colors";
import { getFolders } from "@renderer/lib/folders";
import {
  CURRENT_PRESET_VERSION,
  DEFAULT_MACRO_NAMES,
  DEFAULT_MACRO_VALUES,
  PresetType,
  sanitizeStepParams,
  validatePreset,
} from "@renderer/lib/preset-schema";
import { host } from "@renderer/lib/host";
import { BrushStep, createDefaultStep } from "@renderer/parameters";
import { produce } from "immer";
import { factoryPresets } from "../lib/factory-presets";
import { makeBrushFromPreset, makeEmptyBrush } from "./brush-factory";
import { DEFAULT_PALETTE_ID } from "./palette-id";
import { flatInsertIndex, selectTargetPaletteId } from "./palettes";
import { collectBrushReferencedPaths, openReferencedPaths } from "./files";
import type { Brush, State, ZustandGet, ZustandSet } from "./types";

export interface PresetsState {
  isInitialized: boolean;
  init: () => Promise<void>;
  presetsDir: string | null;
  availablePresets: PresetType[];
  brushes: Brush[];
  activeBrushIndex: number;
  captureState: () => BrushStep[];
  isBrushDirty: (index: number) => boolean;
  setActiveBrush: (index: number) => void;
  addBrushFromPreset: (presetId: string, paletteId?: string) => void;
  addEmptyBrush: (paletteId?: string) => void;
  duplicateBrush: (index: number) => void;
  closeBrush: (index: number) => void;
  renameBrush: (index: number, name: string) => void;
  renameMacro: (macroIndex: number, newName: string) => void;
  setMacroValue: (macroIndex: number, value: number) => void;
  setBrushHotkey: (index: number, hotkey: string | null) => void;
  reorderBrushes: (fromIndex: number, toIndex: number) => void;
  saveBrushToLibrary: (index: number) => Promise<void>;
  saveBrushAsNewPreset: (index: number, name: string) => Promise<void>;
  loadReferencedFiles: (brushIndex: number) => void;
  deletePreset: (presetId: string) => Promise<void>;
  renamePreset: (presetId: string, newName: string) => Promise<void>;
}

function generateFilenameId(name: string, existingIds: Set<string> = new Set()): string {
  let safeName = name
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  if (!safeName) {
    safeName = "preset";
  }

  const timestamp = Date.now();
  let id = `${safeName}-${timestamp}`;

  let counter = 1;
  while (existingIds.has(id)) {
    id = `${safeName}-${timestamp}-${counter}`;
    counter++;
  }

  return id;
}

function openReferencedFiles(brush: Brush, get: ZustandGet) {
  openReferencedPaths(collectBrushReferencedPaths(brush), get);
}

export const PRESETS_PERSISTED_KEYS = ["brushes", "activeBrushIndex"] as const;

export const createPresetsSlice = (set: ZustandSet, get: ZustandGet): PresetsState => ({
  presetsDir: null,
  isInitialized: false,
  init: async () => {
    if (get().isInitialized) {
      return;
    }
    try {
      const { presetsDir } = await getFolders();

      const files = await host.fs.readdir(presetsDir!);
      const userPresets: PresetType[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const filePath = host.path.join(presetsDir!, file);
            const fileContent = await host.fs.readFile(filePath, "utf-8");
            const rawPreset = JSON.parse(fileContent);

            const validationResult = validatePreset(rawPreset, file.replace(/\.json$/, ""));
            if (validationResult.success) {
              userPresets.push(validationResult.data);
            } else {
              console.error(`Invalid preset file ${file}:`, validationResult.errors);
              notifications.show({
                title: "Invalid preset",
                message: `Invalid preset ${file}`,
                color: "red",
                autoClose: 5000,
              });
            }
          } catch (error) {
            console.error(`Failed to load preset file ${file}:`, error);
          }
        }
      }

      set({ availablePresets: [...factoryPresets, ...userPresets], presetsDir, isInitialized: true });

      for (const brush of get().brushes) {
        openReferencedFiles(brush, get);
      }
    } catch (error: any) {
      console.error("Error loading presets:", error);
      notifications.show({
        title: "Error loading presets",
        message: error.message || "Unknown error",
        color: "red",
      });
    }
  },
  availablePresets: [...factoryPresets],

  brushes: [makeEmptyBrush(DEFAULT_PALETTE_ID)],
  activeBrushIndex: 0,

  captureState: (): BrushStep[] => {
    const state = get();
    const steps = state.brushes[state.activeBrushIndex]?.steps;
    return steps && steps.length > 0 ? steps : [createDefaultStep("Step 1", pickNextStepColor([]))];
  },

  isBrushDirty: (index: number): boolean => {
    const state = get();
    const brush = state.brushes[index];
    if (!brush || brush.libraryId === null) return false;

    const preset = state.availablePresets.find((p) => p.id === brush.libraryId);
    if (!preset) return true;

    const presetSnapshot = {
      steps: preset.steps ?? [],
      linkedParams: preset.linkedParams ?? [],
      macroNames: preset.macroNames ?? [...DEFAULT_MACRO_NAMES],
      macroValues: preset.macroValues ?? [...DEFAULT_MACRO_VALUES],
    };
    const brushSnapshot = {
      steps: brush.steps.map(sanitizeStepParams),
      linkedParams: brush.linkedParams,
      macroNames: brush.macroNames,
      macroValues: brush.macroValues,
    };
    return JSON.stringify(presetSnapshot) !== JSON.stringify(brushSnapshot);
  },

  setActiveBrush: (index: number) => {
    const state = get();
    if (index < 0 || index >= state.brushes.length) return;
    set({ activeBrushIndex: index, activeStepIndex: 0 });
  },

  addBrushFromPreset: (presetId: string, targetPaletteId?: string) => {
    const state = get();
    const preset = state.availablePresets.find((p) => p.id === presetId);
    if (!preset) {
      notifications.show({
        title: "Preset not found",
        message: `Preset ${presetId} not found`,
        color: "red",
      });
      return;
    }

    const paletteId = targetPaletteId ?? selectTargetPaletteId(state);
    if (paletteId === null) return;
    const newBrush = makeBrushFromPreset(
      preset,
      state.brushes.map((b) => b.color),
      undefined,
      paletteId,
    );

    set(
      produce((draft: State) => {
        const at = flatInsertIndex(draft.brushes, draft.openPalettes, paletteId, Infinity);
        draft.brushes.splice(at, 0, newBrush);
        draft.activeBrushIndex = at;
        draft.activeStepIndex = 0;
      }),
    );

    openReferencedFiles(newBrush, get);
  },

  addEmptyBrush: (targetPaletteId?: string) => {
    const state = get();
    const paletteId = targetPaletteId ?? selectTargetPaletteId(state);
    if (paletteId === null) return;
    const newBrush = makeEmptyBrush(
      paletteId,
      state.brushes.map((b) => b.color),
    );

    set(
      produce((draft: State) => {
        const at = flatInsertIndex(draft.brushes, draft.openPalettes, paletteId, Infinity);
        draft.brushes.splice(at, 0, newBrush);
        draft.activeBrushIndex = at;
        draft.activeStepIndex = 0;
      }),
    );
  },

  duplicateBrush: (index: number) => {
    const state = get();
    const source = state.brushes[index];
    if (!source) return;

    const existingColors = state.brushes.map((b) => b.color);
    const copy: Brush = {
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
      paletteId: source.paletteId,
      color: pickNextBrushColor(existingColors),
      hotkey: null,
      steps: source.steps.map((step) => ({ ...step, id: crypto.randomUUID() })),
      linkedParams: [...source.linkedParams],
      libraryId: source.libraryId,
      macroNames: [...source.macroNames],
      macroValues: [...source.macroValues],
    };

    set(
      produce((draft: State) => {
        draft.brushes.splice(index + 1, 0, copy);
        draft.activeBrushIndex = index + 1;
        draft.activeStepIndex = 0;
      }),
    );
  },

  closeBrush: (index: number) => {
    const state = get();
    // A palette may empty, but the app may not: every active-brush consumer
    // reads brushes[activeBrushIndex].
    if (state.brushes.length <= 1) return;
    if (index < 0 || index >= state.brushes.length) return;

    set(
      produce((draft: State) => {
        draft.brushes.splice(index, 1);
        if (draft.activeBrushIndex >= draft.brushes.length) {
          draft.activeBrushIndex = draft.brushes.length - 1;
        } else if (draft.activeBrushIndex > index) {
          draft.activeBrushIndex--;
        }
        draft.activeStepIndex = 0;
      }),
    );
  },

  renameBrush: (index: number, name: string) => {
    set(
      produce((draft: State) => {
        const brush = draft.brushes[index];
        if (brush) brush.name = name;
      }),
    );
  },

  renameMacro: (macroIndex: number, newName: string) => {
    set(
      produce((draft: State) => {
        const brush = draft.brushes[draft.activeBrushIndex];
        if (brush && macroIndex >= 0 && macroIndex < brush.macroNames.length) {
          brush.macroNames[macroIndex] = newName;
        }
      }),
    );
  },

  setMacroValue: (macroIndex: number, value: number) => {
    set(
      produce((draft: State) => {
        const brush = draft.brushes[draft.activeBrushIndex];
        if (brush && macroIndex >= 0 && macroIndex < brush.macroValues.length) {
          brush.macroValues[macroIndex] = value;
        }
      }),
    );
  },

  setBrushHotkey: (index: number, hotkey: string | null) => {
    set(
      produce((draft: State) => {
        if (hotkey !== null) {
          for (const brush of draft.brushes) {
            if (brush.hotkey === hotkey) brush.hotkey = null;
          }
        }
        const brush = draft.brushes[index];
        if (brush) brush.hotkey = hotkey;
      }),
    );
  },

  reorderBrushes: (fromIndex: number, toIndex: number) => {
    set(
      produce((draft: State) => {
        const active = draft.brushes[draft.activeBrushIndex];
        const [moved] = draft.brushes.splice(fromIndex, 1);
        draft.brushes.splice(toIndex, 0, moved);
        if (active) {
          const newIndex = draft.brushes.indexOf(active);
          if (newIndex >= 0) draft.activeBrushIndex = newIndex;
        }
      }),
    );
  },

  saveBrushToLibrary: async (index: number) => {
    const state = get();
    const brush = state.brushes[index];
    if (!brush || brush.libraryId === null) return;

    const existing = state.availablePresets.find((p) => p.id === brush.libraryId);
    if (!existing) {
      notifications.show({
        title: "Library preset missing",
        message: `The library preset for "${brush.name}" no longer exists.`,
        color: "red",
      });
      return;
    }
    if (existing.isFactory) {
      notifications.show({
        title: "Cannot overwrite factory preset",
        message: "Use Save as… to save a user copy.",
        color: "red",
      });
      return;
    }

    const updated: PresetType = {
      ...existing,
      version: CURRENT_PRESET_VERSION,
      color: brush.color,
      steps: brush.steps.map(sanitizeStepParams),
      linkedParams: brush.linkedParams,
      macroNames: [...brush.macroNames],
      macroValues: [...brush.macroValues],
    };

    try {
      const validationResult = validatePreset(JSON.parse(JSON.stringify(updated)));
      if (!validationResult.success) {
        throw new Error(`Invalid preset: ${validationResult.errors.join(", ")}`);
      }

      // The repaired preset is what goes to disk, so the file and the library
      // hold what a fresh load would give back.
      const saved = validationResult.data;
      const fileName = `${saved.id}.json`;
      const filePath = host.path.join(state.presetsDir!, fileName);
      await host.fs.writeFile(filePath, JSON.stringify(saved, null, 2), "utf-8");

      set(
        produce((draft: State) => {
          draft.availablePresets = draft.availablePresets.map((p) => (p.id === saved.id ? saved : p));
        }),
      );

      notifications.show({
        title: "Brush saved",
        message: `Saved over "${updated.name}"`,
      });
    } catch (error) {
      console.error("Failed to save brush:", error);
      notifications.show({
        title: "Save failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },

  saveBrushAsNewPreset: async (index: number, name: string) => {
    const state = get();
    const brush = state.brushes[index];
    if (!brush) return;

    const existingIds = new Set(state.availablePresets.map((p) => p.id));
    const id = generateFilenameId(name, existingIds);

    const preset: PresetType = {
      id,
      name,
      isFactory: false,
      version: CURRENT_PRESET_VERSION,
      color: brush.color,
      steps: brush.steps.map(sanitizeStepParams),
      linkedParams: brush.linkedParams,
      macroNames: [...brush.macroNames],
      macroValues: [...brush.macroValues],
    };

    try {
      const validationResult = validatePreset(JSON.parse(JSON.stringify(preset)));
      if (!validationResult.success) {
        throw new Error(`Invalid preset: ${validationResult.errors.join(", ")}`);
      }

      const saved = validationResult.data;
      const fileName = `${id}.json`;
      const filePath = host.path.join(state.presetsDir!, fileName);
      await host.fs.writeFile(filePath, JSON.stringify(saved, null, 2), "utf-8");

      set(
        produce((draft: State) => {
          draft.availablePresets = [...draft.availablePresets, saved];
          const b = draft.brushes[index];
          if (b) {
            b.libraryId = id;
            b.name = name;
          }
        }),
      );

      notifications.show({
        title: "Brush saved",
        message: `Saved as "${name}"`,
      });
    } catch (error) {
      console.error("Failed to save brush:", error);
      notifications.show({
        title: "Save failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },

  loadReferencedFiles: (brushIndex: number) => {
    const brush = get().brushes[brushIndex];
    if (!brush) return;
    openReferencedFiles(brush, get);
  },

  deletePreset: async (presetId: string) => {
    try {
      const { presetsDir } = get();

      const factoryPreset = factoryPresets.find((p) => p.id === presetId);
      if (factoryPreset) {
        throw new Error("Cannot delete default presets");
      }

      const fileName = `${presetId}.json`;
      const filePath = host.path.join(presetsDir!, fileName);
      await host.fs.unlink(filePath);

      set(
        produce((draft: State) => {
          draft.availablePresets = draft.availablePresets.filter((p) => p.id !== presetId);
          for (const brush of draft.brushes) {
            if (brush.libraryId === presetId) brush.libraryId = null;
          }
        }),
      );

      notifications.show({
        title: "Preset deleted",
        message: `Preset deleted successfully`,
      });
    } catch (error) {
      console.error("Error deleting preset:", error);
      notifications.show({
        title: "Delete failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },

  renamePreset: async (presetId: string, newName: string) => {
    const state = get();
    const preset = state.availablePresets.find((p) => p.id === presetId);
    if (!preset || preset.isFactory) return;

    const updated: PresetType = { ...preset, name: newName };

    try {
      const fileName = `${preset.id}.json`;
      const filePath = host.path.join(state.presetsDir!, fileName);
      await host.fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");

      set(
        produce((draft: State) => {
          draft.availablePresets = draft.availablePresets.map((p) => (p.id === presetId ? updated : p));
        }),
      );

      notifications.show({
        title: "Preset renamed",
        message: `Renamed to "${newName}"`,
      });
    } catch (error) {
      console.error("Error renaming preset:", error);
      notifications.show({
        title: "Rename failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },
});
