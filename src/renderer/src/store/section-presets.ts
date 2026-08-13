import { notifications } from "@mantine/notifications";
import { factorySectionPresets } from "@renderer/lib/factory-section-presets";
import { getFolders } from "@renderer/lib/folders";
import { host } from "@renderer/lib/host";
import {
  captureSectionValues,
  folderFor,
  makeSectionPresetId,
  pickSectionPresetColor,
  referencedFilePaths,
  resolveSectionPreset,
  SectionFolder,
  SectionPreset,
  SectionScope,
  SectionTarget,
  serializeSectionPreset,
  validateSectionPreset,
} from "@renderer/lib/section-presets";
import { produce } from "immer";
import { getEffectParameterValue, getParameterValue } from ".";
import { openReferencedPaths } from "./files";
import type { ParameterKey, State, ZustandGet, ZustandSet } from "./types";

export interface SectionPresetsState {
  sectionPresets: SectionPreset[];
  sectionPresetDirs: Record<SectionFolder, string> | null;
  initSectionPresets: () => Promise<void>;
  sectionPresetsFor: (scope: SectionScope) => SectionPreset[];
  applySectionPreset: (presetId: string, target: SectionTarget, keys: ParameterKey[]) => void;
  saveSectionPreset: (name: string, target: SectionTarget, keys: ParameterKey[]) => Promise<void>;
  duplicateSectionPreset: (presetId: string, name: string) => Promise<void>;
  renameSectionPreset: (presetId: string, name: string) => Promise<void>;
  deleteSectionPreset: (presetId: string) => Promise<void>;
}

async function readPresetsIn(dir: string): Promise<SectionPreset[]> {
  const presets: SectionPreset[] = [];
  const files = await host.fs.readdir(dir);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const contents = await host.fs.readFile(host.path.join(dir, file), "utf-8");
      const result = validateSectionPreset(JSON.parse(contents));
      if (result.success) presets.push(result.data);
    } catch (error) {
      console.error(`Failed to load section preset ${file}:`, error);
    }
  }

  return presets;
}

async function writeNewPreset(
  get: ZustandGet,
  set: ZustandSet,
  scope: SectionScope,
  name: string,
  values: Record<string, unknown>,
) {
  const state = get();
  const preset: SectionPreset = {
    id: makeSectionPresetId(scope, name, new Set(state.sectionPresets.map((candidate) => candidate.id))),
    scope,
    name,
    description: "",
    isFactory: false,
    color: pickSectionPresetColor(state.sectionPresets, scope),
    values,
  };

  try {
    let dirs = state.sectionPresetDirs;
    if (!dirs) {
      const { effectPresetsDir, modulatorPresetsDir } = await getFolders();
      dirs = { effects: effectPresetsDir, modulators: modulatorPresetsDir };
    }

    const dir = dirs[folderFor(scope)];
    await host.fs.writeFile(host.path.join(dir, `${preset.id}.json`), serializeSectionPreset(preset), "utf-8");

    const resolvedDirs = dirs;
    set(
      produce((draft: State) => {
        draft.sectionPresets.push(preset);
        draft.sectionPresetDirs = resolvedDirs;
      }),
    );

    notifications.show({ title: "Preset saved", message: `Saved as "${name}"` });
  } catch (error) {
    console.error("Failed to save section preset:", error);
    notifications.show({
      title: "Save failed",
      message: error instanceof Error ? error.message : "Unknown error",
      color: "red",
    });
  }
}

export const createSectionPresetsSlice = (set: ZustandSet, get: ZustandGet): SectionPresetsState => ({
  sectionPresets: [...factorySectionPresets],
  sectionPresetDirs: null,

  initSectionPresets: async () => {
    try {
      const { effectPresetsDir, modulatorPresetsDir } = await getFolders();
      const dirs: Record<SectionFolder, string> = { effects: effectPresetsDir, modulators: modulatorPresetsDir };
      const loaded = await Promise.all([readPresetsIn(effectPresetsDir), readPresetsIn(modulatorPresetsDir)]);

      set({ sectionPresets: [...factorySectionPresets, ...loaded.flat()], sectionPresetDirs: dirs });
    } catch (error) {
      console.error("Error loading section presets:", error);
    }
  },

  sectionPresetsFor: (scope: SectionScope) => get().sectionPresets.filter((preset) => preset.scope === scope),

  applySectionPreset: (presetId: string, target: SectionTarget, keys: ParameterKey[]) => {
    const preset = get().sectionPresets.find((candidate) => candidate.id === presetId);
    if (!preset) return;

    const resolved = resolveSectionPreset(preset, target, keys);
    const setParameter = get().setParameter;
    for (const { key, value } of resolved) {
      setParameter(key, value, target.effectId);
    }

    openReferencedPaths(referencedFilePaths(resolved), get);
  },

  saveSectionPreset: async (name: string, target: SectionTarget, keys: ParameterKey[]) => {
    const state = get();
    const values = captureSectionValues(target.scope, keys, (key) =>
      target.effectId ? getEffectParameterValue(state, target.effectId, key) : getParameterValue(state, key),
    );

    await writeNewPreset(get, set, target.scope, name, values);
  },

  duplicateSectionPreset: async (presetId: string, name: string) => {
    const source = get().sectionPresets.find((candidate) => candidate.id === presetId);
    if (!source) return;

    await writeNewPreset(get, set, source.scope, name, { ...source.values });
  },

  renameSectionPreset: async (presetId: string, name: string) => {
    const state = get();
    const preset = state.sectionPresets.find((candidate) => candidate.id === presetId);
    if (!preset || preset.isFactory || !state.sectionPresetDirs) return;

    const renamed: SectionPreset = { ...preset, name };

    try {
      const dir = state.sectionPresetDirs[folderFor(preset.scope)];
      await host.fs.writeFile(host.path.join(dir, `${presetId}.json`), serializeSectionPreset(renamed), "utf-8");

      set(
        produce((draft: State) => {
          draft.sectionPresets = draft.sectionPresets.map((candidate) =>
            candidate.id === presetId ? renamed : candidate,
          );
        }),
      );
    } catch (error) {
      console.error("Failed to rename section preset:", error);
      notifications.show({
        title: "Rename failed",
        message: error instanceof Error ? error.message : "Unknown error",
        color: "red",
      });
    }
  },

  deleteSectionPreset: async (presetId: string) => {
    const state = get();
    const preset = state.sectionPresets.find((candidate) => candidate.id === presetId);
    if (!preset || preset.isFactory || !state.sectionPresetDirs) return;

    try {
      const dir = state.sectionPresetDirs[folderFor(preset.scope)];
      await host.fs.unlink(host.path.join(dir, `${presetId}.json`));

      set(
        produce((draft: State) => {
          draft.sectionPresets = draft.sectionPresets.filter((candidate) => candidate.id !== presetId);
        }),
      );

      notifications.show({ title: "Preset deleted", message: `Deleted "${preset.name}"` });
    } catch (error) {
      console.error("Failed to delete section preset:", error);
      notifications.show({
        title: "Delete failed",
        message: error instanceof Error ? error.message : "Unknown error",
        color: "red",
      });
    }
  },
});
