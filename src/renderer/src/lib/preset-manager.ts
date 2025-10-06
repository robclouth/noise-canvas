// Preset manager for loading and saving brush presets
// Uses direct access to fs and path utilities (similar to undo-manager)

import { BrushPreset, defaultPresets } from "./presets";

const PRESETS_FOLDER_NAME = "Noise Canvas";
const PRESETS_FILE_NAME = "presets.json";

class PresetManager {
  private presetsDir: string | null = null;
  private presetsFilePath: string | null = null;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.initPresetsDir();
  }

  private async initPresetsDir() {
    if (!window.nodeOs || !window.nodePath || !window.nodeFs) {
      console.error("Node utilities not available");
      return;
    }

    try {
      const homeDir = window.nodeOs.homedir();
      const documentsDir = window.nodePath.join(homeDir, "Documents");
      this.presetsDir = window.nodePath.join(documentsDir, PRESETS_FOLDER_NAME);
      this.presetsFilePath = window.nodePath.join(this.presetsDir, PRESETS_FILE_NAME);

      // Create directory if it doesn't exist
      try {
        await window.nodeFs.mkdir(this.presetsDir, { recursive: true });
        console.log("Presets directory created/verified:", this.presetsDir);
      } catch (error: any) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    } catch (error) {
      console.error("Failed to initialize presets directory:", error);
    }
  }

  /**
   * Load all presets (both default and user-created)
   */
  async loadPresets(): Promise<BrushPreset[]> {
    await this.init();
    if (!this.presetsFilePath || !window.nodeFs) {
      console.error("Preset manager not properly initialized");
      return [...defaultPresets];
    }

    try {
      // Try to read user presets
      const fileContent = await window.nodeFs.readFile(this.presetsFilePath, "utf-8");
      const userPresets: BrushPreset[] = JSON.parse(fileContent);

      // Combine default presets with user presets
      return [...defaultPresets, ...userPresets];
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // File doesn't exist yet, return only default presets
        console.log("No user presets file found, using defaults only");
        return [...defaultPresets];
      }
      console.error("Failed to load user presets:", error);
      return [...defaultPresets];
    }
  }

  /**
   * Save a new preset or update an existing user preset
   */
  async savePreset(preset: BrushPreset): Promise<void> {
    await this.init();
    if (!this.presetsFilePath || !window.nodeFs) {
      console.error("Preset manager not properly initialized");
      return;
    }

    // Don't allow saving over default presets
    if (preset.isDefault) {
      throw new Error("Cannot save over default presets");
    }

    try {
      // Load existing user presets
      let userPresets: BrushPreset[] = [];
      try {
        const fileContent = await window.nodeFs.readFile(this.presetsFilePath, "utf-8");
        userPresets = JSON.parse(fileContent);
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      // Update or add preset
      const existingIndex = userPresets.findIndex((p) => p.id === preset.id);
      if (existingIndex >= 0) {
        userPresets[existingIndex] = preset;
      } else {
        userPresets.push(preset);
      }

      // Save to file
      await window.nodeFs.writeFile(this.presetsFilePath, JSON.stringify(userPresets, null, 2), "utf-8");

      console.log("Preset saved:", preset.name);
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
    if (!this.presetsFilePath || !window.nodeFs) {
      console.error("Preset manager not properly initialized");
      return;
    }

    // Don't allow deleting default presets
    const defaultPreset = defaultPresets.find((p) => p.id === presetId);
    if (defaultPreset) {
      throw new Error("Cannot delete default presets");
    }

    try {
      // Load existing user presets
      const fileContent = await window.nodeFs.readFile(this.presetsFilePath, "utf-8");
      let userPresets: BrushPreset[] = JSON.parse(fileContent);

      // Remove preset
      userPresets = userPresets.filter((p) => p.id !== presetId);

      // Save to file
      await window.nodeFs.writeFile(this.presetsFilePath, JSON.stringify(userPresets, null, 2), "utf-8");

      console.log("Preset deleted:", presetId);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // File doesn't exist, nothing to delete
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
