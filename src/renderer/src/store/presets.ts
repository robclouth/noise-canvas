import { notifications } from "@mantine/notifications";
import { getFolders } from "@renderer/lib/folders";
import { CURRENT_PRESET_VERSION, PresetType, validatePreset } from "@renderer/lib/preset-schema";
import { BrushStep, createDefaultStep } from "@renderer/parameters";
import { produce } from "immer";
import { factoryPresets } from "../lib/factory-presets";
import type { State, ZustandGet, ZustandSet } from "./types";

export interface PresetsState {
  isInitialized: boolean;
  init: () => Promise<void>;
  presetsDir: string | null;
  currentPresetId: string | null;
  isPresetDirty: boolean;
  setPresetDirty: (dirty: boolean) => void;
  availablePresets: PresetType[];
  setCurrentPresetId: (presetId: string | null) => void;
  captureState: () => BrushStep[];
  recallState: (steps: BrushStep[]) => Partial<State>;
  loadPreset: (presetId: string) => void;
  savePreset: (name: string, presetId?: string) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  assignHotkeyToPreset: (presetId: string, hotkey: string) => void;
  presetHotkeys: Record<string, string>;
  activeQuickSlot: number | null;
  setActiveQuickSlot: (slotIndex: number | null) => void;
  quickSlotModifierMode: boolean;
  setQuickSlotModifierMode: (isHeld: boolean) => void;
  quickSlots: Record<number, BrushStep[]>;
  setQuickSlot: (slotIndex: number) => void;
  recallQuickSlot: (slotIndex: number) => void;
  clearQuickSlot: (slotIndex: number) => void;
}

/**
 * Generate a filename-safe ID from a preset name
 */
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

export const PRESETS_PERSISTED_KEYS = ["quickSlots", "presetHotkeys"] as const;

export const createPresetsSlice = (set: ZustandSet, get: ZustandGet): PresetsState => ({
  presetsDir: null,
  currentPresetId: "init",
  isInitialized: false,
  init: async () => {
    if (get().isInitialized) {
      return;
    }
    try {
      const { presetsDir } = await getFolders();

      const files = await window.nodeFs.readdir(presetsDir!);
      const userPresets: PresetType[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const filePath = window.nodePath.join(presetsDir!, file);
            const fileContent = await window.nodeFs.readFile(filePath, "utf-8");
            const rawPreset = JSON.parse(fileContent);

            const validationResult = validatePreset(rawPreset);
            if (validationResult.success) {
              userPresets.push(validationResult.data);
            } else {
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
  isPresetDirty: false,
  setPresetDirty: (dirty: boolean) => set({ isPresetDirty: dirty }),
  setCurrentPresetId: (presetId) => set({ currentPresetId: presetId }),

  recallState: (steps: BrushStep[]): Partial<State> => {
    const updates: Partial<State> = {};

    if (steps && Array.isArray(steps) && steps.length > 0) {
      updates.steps = steps.map((presetStep: any, index: number) => {
        const defaultStep = createDefaultStep(presetStep.name || `Step ${index + 1}`);
        return {
          ...defaultStep,
          ...presetStep,
          id: presetStep.id || defaultStep.id,
        } as BrushStep;
      });
    } else {
      updates.steps = [createDefaultStep("Step 1")];
    }
    updates.activeStepIndex = 0;

    return updates;
  },

  captureState: (): BrushStep[] => {
    return get().steps;
  },

  loadPreset: (presetId: string) => {
    const state = get();

    const preset = state.availablePresets.find((p) => p.id === presetId);
    if (!preset) {
      notifications.show({
        title: "Preset not found",
        message: `Preset ${presetId} not found`,
        color: "red",
      });
      set({ currentPresetId: "init" });
      return;
    }

    set({
      currentPresetId: presetId,
      isPresetDirty: false,
      ...state.recallState(preset.steps ?? []),
    });
  },

  savePreset: async (name: string, presetId?: string) => {
    try {
      const state = get();
      const { availablePresets, presetsDir } = state;

      let id = presetId;
      if (!id) {
        const existingIds = new Set(availablePresets.map((p) => p.id));
        id = generateFilenameId(name, existingIds);
      }

      const preset: PresetType = {
        id,
        name,
        isFactory: false,
        version: CURRENT_PRESET_VERSION,
        steps: state.captureState(),
      };

      if (preset.isFactory) {
        throw new Error("Cannot save over factory presets");
      }

      try {
        const fileName = `${id}.json`;
        const filePath = window.nodePath.join(presetsDir!, fileName);
        await window.nodeFs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");

        set({
          currentPresetId: id,
          isPresetDirty: false,
          availablePresets: [...availablePresets.filter((p) => p.id !== id), preset],
        });

        console.log("Preset saved:", preset.name, "at", filePath);
        notifications.show({
          title: "Preset saved",
          message: `Preset ${preset.name} saved successfully`,
        });
      } catch (error) {
        console.error("Failed to save preset:", error);
        throw error;
      }

      set({ currentPresetId: id });
    } catch (error) {
      console.error("Error saving preset:", error);
      notifications.show({
        title: "Save failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },

  deletePreset: async (presetId: string) => {
    try {
      const { presetsDir, currentPresetId } = get();

      const factoryPreset = factoryPresets.find((p) => p.id === presetId);
      if (factoryPreset) {
        throw new Error("Cannot delete default presets");
      }

      const fileName = `${presetId}.json`;
      const filePath = window.nodePath.join(presetsDir!, fileName);
      await window.nodeFs.unlink(filePath);

      let newCurrentPresetId = currentPresetId;
      if (currentPresetId === presetId) {
        newCurrentPresetId = "init";
      }
      set({
        availablePresets: get().availablePresets.filter((p) => p.id !== presetId),
        currentPresetId: newCurrentPresetId,
      });

      console.log("Preset deleted:", presetId);
      notifications.show({
        title: "Preset deleted",
        message: `Preset ${presetId} deleted successfully`,
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

  presetHotkeys: {},
  assignHotkeyToPreset: async (presetId: string, hotkey: string) => {
    const preset = get().availablePresets.find((p) => p.id === presetId);
    if (!preset) return;

    set(
      produce((state: State) => {
        Object.entries(state.presetHotkeys).forEach(([key, id]) => {
          if (id === presetId) {
            delete state.presetHotkeys[key];
          }
        });
        state.presetHotkeys[hotkey] = presetId;
      }),
    );

    notifications.show({
      title: "Hotkey assigned",
      message: `Hotkey ${hotkey} assigned to ${preset.name}`,
    });
  },

  quickSlots: {},
  activeQuickSlot: null,
  setActiveQuickSlot: (slotIndex) => set({ activeQuickSlot: slotIndex }),
  quickSlotModifierMode: false,
  setQuickSlotModifierMode: (isHeld) => set({ quickSlotModifierMode: isHeld }),

  setQuickSlot: (slotIndex: number) => {
    set(
      produce((state: State) => {
        state.quickSlots[slotIndex] = state.captureState();
        state.activeQuickSlot = slotIndex;
      }),
    );
  },

  recallQuickSlot: (slotIndex: number) => {
    const state = get();
    const steps = state.quickSlots[slotIndex];
    if (!steps) return;
    set({ ...state.recallState(steps), currentPresetId: null, activeQuickSlot: slotIndex });
  },

  clearQuickSlot: (slotIndex: number) => {
    set(
      produce((state: State) => {
        delete state.quickSlots[slotIndex];
        if (state.activeQuickSlot === slotIndex) {
          state.activeQuickSlot = null;
        }
      }),
    );
  },
});
