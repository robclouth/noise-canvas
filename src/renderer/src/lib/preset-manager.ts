// Preset manager for loading and saving brush presets
// Uses direct access to fs and path utilities (similar to undo-manager)

import { State } from "@renderer/store";
import { getFolders } from "./folders";
import { BrushPreset, defaultPresets, PRESET_KEYS } from "./presets";

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
  private appDir: string | null = null;
  private presetsDir: string | null = null;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.initialized = true;
    const { appDir, presetsDir } = await getFolders();
    this.appDir = appDir;
    this.presetsDir = presetsDir;
  }

  /**
   * Load all presets (both default and user-created)
   */
  async loadPresets(): Promise<BrushPreset[]> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      return [...defaultPresets];
    }

    try {
      // Read all files from the presets directory
      const files = await window.nodeFs.readdir(this.presetsDir);
      const userPresets: BrushPreset[] = [];

      // Load each JSON file
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const filePath = window.nodePath.join(this.presetsDir, file);
            const fileContent = await window.nodeFs.readFile(filePath, "utf-8");
            const preset: BrushPreset = JSON.parse(fileContent);
            userPresets.push(preset);
          } catch (error) {
            console.error(`Failed to load preset file ${file}:`, error);
          }
        }
      }

      // Combine default presets with user presets
      return [...defaultPresets, ...userPresets];
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // Directory doesn't exist yet, return only default presets
        console.log("No user presets directory found, using defaults only");
        return [...defaultPresets];
      }
      console.error("Failed to load user presets:", error);
      return [...defaultPresets];
    }
  }

  /**
   * Build a preset from the current state
   */
  private buildPresetFromState(state: State, name: string, id: string): BrushPreset {
    const preset: any = {
      id,
      name,
      isDefault: false,
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

    return preset as BrushPreset;
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
  async savePreset(preset: BrushPreset): Promise<void> {
    await this.init();
    if (!this.presetsDir || !window.nodeFs || !window.nodePath) {
      console.error("Preset manager not properly initialized");
      return;
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
