// Preset manager for loading and saving brush presets
// Uses direct access to fs and path utilities (similar to undo-manager)

import { notifications } from "@mantine/notifications";
import { State } from "@renderer/store";
import { getFolders } from "./folders";
import { CURRENT_PRESET_VERSION, validatePreset, type BrushPresetType } from "./preset-schema";
import { defaultPresets, PRESET_KEYS } from "./presets";

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

class PresetManager {
  private presetsDir: string | null = null;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.initialized = true;
    const { presetsDir } = await getFolders();
    this.presetsDir = presetsDir;
  }

  /**
   * Load all presets (both default and user-created)
   */
  async loadPresets(): Promise<BrushPresetType[]> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      return [...defaultPresets];
    }

    try {
      // Read all files from the presets directory
      const files = await window.nodeFs.readdir(this.presetsDir);
      const userPresets: BrushPresetType[] = [];

      // Load each JSON file
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const filePath = window.nodePath.join(this.presetsDir, file);
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

      // Validate default presets as well
      const validatedDefaultPresets: BrushPresetType[] = [];
      for (const preset of defaultPresets) {
        const validationResult = validatePreset(preset);
        if (validationResult.success) {
          validatedDefaultPresets.push(validationResult.data);
        } else {
          console.error(`Invalid default preset ${preset.id}:`, validationResult.errors);
          // This should never happen with properly defined default presets
        }
      }

      // Combine validated default presets with user presets
      return [...validatedDefaultPresets, ...userPresets];
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // Directory doesn't exist yet, return only validated default presets
        console.log("No user presets directory found, using defaults only");
        const validatedDefaultPresets: BrushPresetType[] = [];
        for (const preset of defaultPresets) {
          const validationResult = validatePreset(preset);
          if (validationResult.success) {
            validatedDefaultPresets.push(validationResult.data);
          } else {
            console.error(`Invalid default preset ${preset.id}:`, validationResult.errors);
          }
        }
        return validatedDefaultPresets;
      }
      console.error("Failed to load user presets:", error);
      // Return validated default presets as fallback
      const validatedDefaultPresets: BrushPresetType[] = [];
      for (const preset of defaultPresets) {
        const validationResult = validatePreset(preset);
        if (validationResult.success) {
          validatedDefaultPresets.push(validationResult.data);
        } else {
          console.error(`Invalid default preset ${preset.id}:`, validationResult.errors);
        }
      }
      return validatedDefaultPresets;
    }
  }

  /**
   * Build a preset from the current state
   */
  private buildPresetFromState(state: State, name: string, id: string): BrushPresetType {
    const preset: any = {
      id,
      name,
      isDefault: false,
      version: CURRENT_PRESET_VERSION, // Always save with current version
    };

    for (const key of PRESET_KEYS) {
      const stateValue = state[key];
      // For parameters (objects with .value), extract the value
      if (stateValue && typeof stateValue === "object" && "value" in stateValue) {
        preset[key] = stateValue.value;
      } else {
        // For non-parameter values (effectOrder, effectsEnabled), copy directly
        preset[key] = stateValue;
      }
    }

    return preset as BrushPresetType;
  }

  /**
   * Save a preset from the current state
   */
  async savePresetFromState(state: State, name: string, presetId?: string): Promise<string> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      throw new Error("Preset manager not initialized");
    }

    // Generate ID if not provided
    let id = presetId;
    if (!id) {
      // Get existing IDs to avoid collisions
      const existingPresets = await this.loadPresets();
      const existingIds = new Set(existingPresets.map((p) => p.id));
      id = generateFilenameId(name, existingIds);
    }

    // Build preset from state
    const preset = this.buildPresetFromState(state, name, id);

    // Validate the preset before saving
    const validationResult = validatePreset(preset);
    if (!validationResult.success) {
      console.error("Invalid preset data:", validationResult.errors);
      throw new Error(`Invalid preset data: ${validationResult.errors.join(", ")}`);
    }

    // Don't allow saving over default presets
    if (preset.isDefault) {
      throw new Error("Cannot save over default presets");
    }

    try {
      // Save as individual JSON file
      const fileName = `${id}.json`;
      const filePath = window.nodePath.join(this.presetsDir, fileName);
      await window.nodeFs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");

      console.log("Preset saved:", preset.name, "at", filePath);
      return id;
    } catch (error) {
      console.error("Failed to save preset:", error);
      throw error;
    }
  }

  /**
   * Save a new preset or update an existing user preset (legacy method for direct preset objects)
   */
  async savePreset(preset: BrushPresetType): Promise<void> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      return;
    }

    // Validate the preset before saving
    const validationResult = validatePreset(preset);
    if (!validationResult.success) {
      console.error("Invalid preset data:", validationResult.errors);
      throw new Error(`Invalid preset data: ${validationResult.errors.join(", ")}`);
    }

    // Don't allow saving over default presets
    if (preset.isDefault) {
      throw new Error("Cannot save over default presets");
    }

    try {
      // Save as individual JSON file
      const fileName = `${preset.id}.json`;
      const filePath = window.nodePath.join(this.presetsDir, fileName);
      await window.nodeFs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");

      console.log("Preset saved:", preset.name, "at", filePath);
    } catch (error) {
      console.error("Failed to save preset:", error);
      throw error;
    }
  }

  /**
   * Delete a user preset
   */
  async deletePreset(presetId: string): Promise<void> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      return;
    }

    // Don't allow deleting default presets
    const defaultPreset = defaultPresets.find((p) => p.id === presetId);
    if (defaultPreset) {
      throw new Error("Cannot delete default presets");
    }

    try {
      // Delete the individual JSON file
      const fileName = `${presetId}.json`;
      const filePath = window.nodePath.join(this.presetsDir, fileName);
      await window.nodeFs.unlink(filePath);

      console.log("Preset deleted:", presetId);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // File doesn't exist, nothing to delete
        console.log("Preset file not found:", presetId);
        return;
      }
      console.error("Failed to delete preset:", error);
      throw error;
    }
  }
}

// Global preset manager instance
const presetManager = new PresetManager();

export function getPresetManager(): PresetManager {
  return presetManager;
}
