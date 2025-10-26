import { notifications } from "@mantine/notifications";
import { getFolders } from "@renderer/lib/folders";
import { CURRENT_PRESET_VERSION, PresetType, validatePreset } from "@renderer/lib/preset-schema";
import { parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { factoryPresets } from "../lib/factory-presets";
import type { State, ZustandGet, ZustandSet } from "./types";

export interface PresetsState {
  isInitialized: boolean;
  init: () => Promise<void>;
  presetsDir: string | null;
  currentPresetId: string | null;
  availablePresets: PresetType[];
  setCurrentPresetId: (presetId: string | null) => void;
  captureState: () => Partial<State>;
  recallState: (parameters: Partial<State>) => Partial<State>;
  loadPreset: (presetId: string) => void;
  savePreset: (name: string, presetId?: string) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  assignHotkeyToPreset: (presetId: string, hotkey: string) => void;
  presetHotkeys: Record<string, string>;
  quickSlots: Record<number, Partial<State>>;
  setQuickSlot: (slotIndex: number) => void;
  recallQuickSlot: (slotIndex: number) => void;
  clearQuickSlot: (slotIndex: number) => void;
}

/**
 * Generate a filename-safe ID from a preset name
 * Removes/replaces special characters and ensures uniqueness with timestamp
 */
function generateFilenameId(name: string, existingIds: Set<string> = new Set()): string {
  // Remove or replace unsafe characters
  // Keep only alphanumeric, spaces, hyphens, and underscores
  let safeName = name
    .replace(/[^a-zA-Z0-9\s\-_]/g, "") // Remove unsafe chars
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single
    .replace(/^-|-$/g, "") // Remove leading/trailing hyphens
    .toLowerCase();

  // Ensure it's not empty
  if (!safeName) {
    safeName = "preset";
  }

  // Make it unique with timestamp
  const timestamp = Date.now();
  let id = `${safeName}-${timestamp}`;

  // If somehow still collides, add a counter
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

      // Read all files from the presets directory
      const files = await window.nodeFs.readdir(presetsDir!);
      const userPresets: PresetType[] = [];

      // Load each JSON file
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const filePath = window.nodePath.join(presetsDir!, file);
            const fileContent = await window.nodeFs.readFile(filePath, "utf-8");
            const rawPreset = JSON.parse(fileContent);

            // Validate the preset against the schema (includes migration)
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
  setCurrentPresetId: (presetId) => set({ currentPresetId: presetId }),
  recallState: (parameters: Partial<State>) => {
    const state = get();
    const updates: Partial<State> = {};

    for (const [key, parameterDef] of Object.entries(parameterDefs)) {
      if (!parameterDef.includeInPresets) continue;

      const value = state[key as keyof State];
      const presetValue = parameters[key];
      const newValue = presetValue === undefined ? parameterDef.default : presetValue;

      if (value !== newValue) {
        updates[key] = newValue;
      }
    }

    return updates;
  },
  captureState: () => {
    const state = get();
    const parameters: Partial<State> = {};
    for (const [key, parameterDef] of Object.entries(parameterDefs)) {
      if (!parameterDef.includeInPresets) continue;
      const value = state[key as keyof State];

      if (value === parameterDef.default) continue; // Skip default values
      parameters[key] = value;
    }
    return parameters;
  },
  loadPreset: (presetId: string) => {
    const state = get();

    if (presetId === state.currentPresetId) {
      return;
    }

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

    set({ currentPresetId: presetId, ...state.recallState(preset.parameters) });
  },
  savePreset: async (name: string, presetId?: string) => {
    try {
      const state = get();
      const { availablePresets, presetsDir } = state;

      // Generate ID if not provided
      let id = presetId;
      if (!id) {
        const existingIds = new Set(availablePresets.map((p) => p.id));
        id = generateFilenameId(name, existingIds);
      }

      // Build preset from state
      const preset: PresetType = {
        id,
        name,
        isFactory: false,
        version: CURRENT_PRESET_VERSION,
        parameters: state.captureState(),
      };

      // Don't allow saving over default presets
      if (preset.isFactory) {
        throw new Error("Cannot save over factory presets");
      }

      try {
        // Save as individual JSON file
        const fileName = `${id}.json`;
        const filePath = window.nodePath.join(presetsDir!, fileName);
        await window.nodeFs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");

        set({ currentPresetId: id, availablePresets: [...availablePresets.filter((p) => p.id !== id), preset] });

        console.log("Preset saved:", preset.name, "at", filePath);
        notifications.show({
          title: "Preset saved",
          message: `Preset ${preset.name} saved successfully`,
        });
      } catch (error) {
        console.error("Failed to save preset:", error);
        throw error;
      }

      // Set as current preset
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

      // Don't allow deleting factory presets
      const factoryPreset = factoryPresets.find((p) => p.id === presetId);
      if (factoryPreset) {
        throw new Error("Cannot delete default presets");
      }

      // Delete the individual JSON file
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
  setQuickSlot: (slotIndex: number) => {
    set(
      produce((state: State) => {
        state.quickSlots[slotIndex] = state.captureState();
      }),
    );
  },
  recallQuickSlot: (slotIndex: number) => {
    const state = get();
    const parameters = state.quickSlots[slotIndex];
    if (!parameters) return;
    set(state.recallState(parameters));
  },
  clearQuickSlot: (slotIndex: number) => {
    set(
      produce((state: State) => {
        delete state.quickSlots[slotIndex];
      }),
    );
  },
});
