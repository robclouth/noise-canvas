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
  // Per-slot preset tracking
  slotPresetIds: Record<number, string | null>;
  slotDirty: Record<number, boolean>;
  slotLinkedParams: Record<number, string[]>;
  availablePresets: PresetType[];
  captureState: () => BrushStep[];
  loadPreset: (presetId: string) => void;
  savePreset: (name: string, presetId?: string) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  assignHotkeyToPreset: (presetId: string, hotkey: string) => void;
  presetHotkeys: Record<string, string>;
  slots: Record<number, BrushStep[]>;
  activeSlotIndex: number;
  setActiveSlot: (slotIndex: number) => void;
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

export const PRESETS_PERSISTED_KEYS = [
  "slots",
  "activeSlotIndex",
  "slotPresetIds",
  "slotDirty",
  "slotLinkedParams",
  "presetHotkeys",
] as const;

export const createPresetsSlice = (set: ZustandSet, get: ZustandGet): PresetsState => ({
  presetsDir: null,
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

  captureState: (): BrushStep[] => {
    const state = get();
    return state.slots[state.activeSlotIndex] ?? [createDefaultStep("Step 1")];
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
      return;
    }

    // Load preset steps into the active slot
    const presetSteps = preset.steps ?? [];
    const mergedSteps =
      presetSteps.length > 0
        ? presetSteps.map((presetStep, index) => {
            const defaultStep = createDefaultStep(presetStep.name || `Step ${index + 1}`);
            return {
              ...defaultStep,
              ...presetStep,
              id: presetStep.id || defaultStep.id,
            } as BrushStep;
          })
        : [createDefaultStep("Step 1")];

    set(
      produce((draft: State) => {
        draft.slots[draft.activeSlotIndex] = mergedSteps;
        draft.activeStepIndex = 0;
        draft.slotPresetIds[draft.activeSlotIndex] = presetId;
        draft.slotDirty[draft.activeSlotIndex] = false;
        draft.slotLinkedParams[draft.activeSlotIndex] = preset.linkedParams ?? [];
      }),
    );

    // Open referenced source files minimized
    for (const step of mergedSteps) {
      const sourceFile = step.sourceFile;
      if (sourceFile?.path) {
        get()
          .openFileMinimized(sourceFile.path)
          .catch(() => {
            // File not found — reset to null
            notifications.show({
              title: "Source file not found",
              message: `${sourceFile.path.split("/").pop()} not found on disk`,
              color: "yellow",
            });
          });
      }
    }
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
        linkedParams: state.slotLinkedParams[state.activeSlotIndex] ?? [],
      };

      if (preset.isFactory) {
        throw new Error("Cannot save over factory presets");
      }

      const validationResult = validatePreset(JSON.parse(JSON.stringify(preset)));
      if (!validationResult.success) {
        throw new Error(`Invalid preset: ${validationResult.errors.join(", ")}`);
      }

      try {
        const fileName = `${id}.json`;
        const filePath = window.nodePath.join(presetsDir!, fileName);
        await window.nodeFs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");

        set(
          produce((draft: State) => {
            draft.slotPresetIds[draft.activeSlotIndex] = id;
            draft.slotDirty[draft.activeSlotIndex] = false;
            draft.availablePresets = [...availablePresets.filter((p) => p.id !== id), preset];
          }),
        );

        console.log("Preset saved:", preset.name, "at", filePath);
        notifications.show({
          title: "Preset saved",
          message: `Preset ${preset.name} saved successfully`,
        });
      } catch (error) {
        console.error("Failed to save preset:", error);
        throw error;
      }
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
      const { presetsDir } = get();

      const factoryPreset = factoryPresets.find((p) => p.id === presetId);
      if (factoryPreset) {
        throw new Error("Cannot delete default presets");
      }

      const fileName = `${presetId}.json`;
      const filePath = window.nodePath.join(presetsDir!, fileName);
      await window.nodeFs.unlink(filePath);

      set(
        produce((draft: State) => {
          draft.availablePresets = draft.availablePresets.filter((p) => p.id !== presetId);
          // Clear preset ID from any slots that had this preset
          Object.keys(draft.slotPresetIds).forEach((key) => {
            const slotIndex = Number(key);
            if (draft.slotPresetIds[slotIndex] === presetId) {
              draft.slotPresetIds[slotIndex] = null;
            }
          });
        }),
      );

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

  // Slots - source of truth for brush parameters (all 10 always exist)
  slots: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, [createDefaultStep("Step 1")]])) as Record<
    number,
    BrushStep[]
  >,
  activeSlotIndex: 0,

  // Per-slot preset tracking
  slotPresetIds: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, null])) as Record<number, string | null>,
  slotDirty: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, false])) as Record<number, boolean>,
  slotLinkedParams: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, []])) as Record<number, string[]>,

  setActiveSlot: (slotIndex: number) => {
    set({ activeSlotIndex: slotIndex });
  },
});
