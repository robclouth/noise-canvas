import { notifications } from "@mantine/notifications";
import { produce } from "immer";
import { isEqual } from "lodash-es";
import { getPresetManager } from "../lib/preset-manager";
import { defaultPresets, PRESET_KEYS } from "../lib/presets";
import type { PresetsState, State, ZustandGet, ZustandSet } from "./types";

export const createPresetsSlice = (set: ZustandSet, get: ZustandGet): PresetsState => ({
  currentPresetId: "default",
  availablePresets: [...defaultPresets],
  setCurrentPresetId: (presetId) => set({ currentPresetId: presetId }),
  loadPresets: async () => {
    const presetManager = getPresetManager();
    const presets = await presetManager.loadPresets();
    set({ availablePresets: presets });
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
      set({ currentPresetId: "default" });
      return;
    }

    // Dynamically build the update object from preset keys
    const updates: any = { currentPresetId: presetId };

    for (const key of PRESET_KEYS) {
      const stateValue = state[key];
      const presetValue = preset[key];

      // For parameters (objects with .value), compare the actual values
      if (stateValue && typeof stateValue === "object" && "value" in stateValue) {
        if (stateValue.value !== presetValue) {
          updates[key] = { ...stateValue, value: presetValue };
        }
      } else {
        // For non-parameter values, use deep comparison for objects
        if (!isEqual(stateValue, presetValue)) {
          updates[key] = presetValue;
        }
      }
    }

    set(updates);
  },
  savePreset: async (name: string, presetId?: string) => {
    try {
      const state = get();
      const presetManager = getPresetManager();

      // Save preset from state (preset manager handles all the logic)
      const id = await presetManager.savePresetFromState(state, name, presetId);

      // Reload presets
      await state.loadPresets();

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
      const state = get();
      const presetManager = getPresetManager();

      await presetManager.deletePreset(presetId);

      // Reload presets
      await state.loadPresets();

      // If we deleted the current preset, switch to default
      if (state.currentPresetId === presetId) {
        set({ currentPresetId: "default" });
      }
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
});
