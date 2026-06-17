import { openConfirm, openNewFilePrompt, openReanalyzePrompt } from "../lib/modals";
import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { EffectItem } from "@renderer/effects/types";
import { FileParameterValue, getFileParameterKeys, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { host } from "../lib/host";
import type { HostRender } from "../lib/host/types";
import { destroyHistoryManager, getHistoryManager } from "../lib/history-manager";
import { buildChildIndexPaths, chainFromRootTo, runHistoryExport } from "../lib/history-export";
import type { Brush, OpenFile, ParameterKey, State, ZustandGet, ZustandSet } from "./types";
import { generateFileId, isManagedFilePath, makeManagedFilePath } from "./utils";

export interface FilesState {
  newFile: () => Promise<void>;
  openFileIds: string[];
  openFilePath: (filePath: string) => Promise<void>;
  duplicateFile: (fileId: string) => Promise<void>;
  hpssFile: (fileId: string) => Promise<void>;
  aiSeparateFile: (fileId: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
  saveActiveFileAs: () => Promise<void>;
  saveActiveFileVersion: () => Promise<void>;
  tryCloseFile: (fileId: string) => Promise<void>;
  closeFile: (fileId: string) => void;
  reanalyzeActiveFile: () => Promise<void>;
  resizeActiveFileLength: (factor: 2 | 0.5) => Promise<void>;
  synthesizeFile: (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
    prefetchedFboData?: Float32Array,
  ) => Promise<void>;
  loadCachedAudio: (fileId: string, audioPath: string, peak: number) => Promise<boolean>;
  exportHistory: () => Promise<void>;
  exportHistoryBranch: (nodeId: string) => Promise<void>;
  exportHistoryBranchToLive: (nodeId: string) => Promise<void>;
  exportHistoryFavorites: () => Promise<void>;
  mostRecentBpm: number | null;
  setMostRecentBpm: (bpm: number) => void;
  filepathsBpm: Record<string, number>;
  setFilepathBpm: (fileId: string, bpm: number) => void;
  filesBandsPerOctave: Record<string, number>;
  setFileBandsPerOctave: (fileId: string, bandsPerOctave: number) => void;
  filesZoom: Record<string, number>;
  setFileZoom: (fileId: string, zoom: number) => void;
  filesOffset: Record<string, number>;
  setFileOffset: (fileId: string, offset: number) => void;
  filesZoomY: Record<string, number>;
  setFileZoomY: (fileId: string, zoom: number) => void;
  filesOffsetY: Record<string, number>;
  setFileOffsetY: (fileId: string, offset: number) => void;
  // Maps persistable fileId → filePath (real on-disk path or `managed://<id>`
  // sentinel for files whose only on-disk backing is their history dir).
  // Serialised so the open-file list — including managed files — survives
  // app restart; reopenPersistedFiles rehydrates each entry from history.
  persistedFilePaths: Record<string, string>;
  // Persisted human-readable label per fileId. Lets a managed file's
  // "Untitled N" name (and any future user-assigned labels) survive restart
  // instead of being re-derived from iteration order.
  fileDisplayNames: Record<string, string>;
  reopenPersistedFiles: () => Promise<void>;
  recentFilePaths: string[];
  addRecentFilePath: (filePath: string) => void;
  clearRecentFilePaths: () => void;
  filesPlaybackStartTime: Record<string, number>;
  setFilePlaybackStartTime: (fileId: string, playbackStartTime: number) => void;
  filesDirty: Record<string, boolean>;
  setFileDirty: (fileId: string, dirty: boolean) => void;
  filesSynthesizing: Record<string, boolean>;
  setFileSynthesizing: (fileId: string, synthesizing: boolean) => void;
  filesLoading: Record<string, string>;
  setFileLoading: (fileId: string, message: string | undefined) => void;
  activeFileId: string | null;
  setActiveFileId: (activeFileId: string | null) => Promise<void>;
  fullscreenFileId: string | null;
  setFullscreenFileId: (fileId: string | null) => void;
  minimizedFileIds: string[];
  setFileMinimized: (fileId: string, minimized: boolean) => void;
  openFileMinimized: (filePath: string) => Promise<void>;
  switchToNextFile: () => void;
  switchToPreviousFile: () => void;
}

// Open files keyed by file ID
export const openFiles: Record<string, OpenFile> = {};

// Walks a single sequence of brush steps and rewrites file-param entries
// whose path matches `oldPath` to `newPath`. Returns true if anything
// changed. The steps-array is the common shape of both an in-session Brush
// (Brush.steps) and an on-disk preset (PresetType.steps), so this helper
// drives both `migrateBrushRefs` (in-session) and `migrateRefsInPresetFiles`
// (preset JSONs on disk).
export function migrateRefsInSteps(
  steps: Array<{ effects?: EffectItem[] } & Record<string, unknown>>,
  oldPath: string,
  newPath: string,
): boolean {
  const fileKeys = getFileParameterKeys();
  let changed = false;
  for (const step of steps) {
    for (const key of fileKeys) {
      const def = parameterDefs[key];
      if (!def || def.kind !== "file") continue;
      if (def.effectType) {
        const effects = (step.effects ?? []) as EffectItem[];
        for (const effect of effects) {
          if (effect.effect !== def.effectType) continue;
          const val = effect.params?.[key] as FileParameterValue | undefined;
          if (val?.path === oldPath) {
            (effect.params as Record<string, FileParameterValue>)[key] = { path: newPath };
            changed = true;
          }
        }
      } else {
        const val = (step as Record<string, unknown>)[key] as FileParameterValue | undefined;
        if (val?.path === oldPath) {
          (step as Record<string, unknown>)[key] = { path: newPath };
          changed = true;
        }
      }
    }
  }
  return changed;
}

// In-session migration: walks every brush's steps. Used after Save As so
// brush references in the open editor follow a renamed file (notably the
// managed→real promotion path, where refs that pointed at `managed://<fileId>`
// get rewritten to the user-chosen filesystem path).
export function migrateBrushRefs(brushes: Brush[], oldPath: string, newPath: string): void {
  for (const brush of brushes) {
    migrateRefsInSteps(brush.steps as Array<{ effects?: EffectItem[] } & Record<string, unknown>>, oldPath, newPath);
  }
}

// On-disk migration: walks every preset .json under presetsDir. A preset's
// steps array has the same shape as a brush's, so the same per-step walker
// applies. Best-effort — a single bad file doesn't block the others, and a
// total failure (no presetsDir, permission error) just no-ops.
export async function migrateRefsInPresetFiles(presetsDir: string, oldPath: string, newPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await host.fs.readdir(presetsDir)) as unknown as string[];
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (file) => {
        const filePath = host.path.join(presetsDir, file);
        try {
          const raw = (await host.fs.readFile(filePath, "utf-8")) as unknown as string;
          const preset = JSON.parse(raw) as { steps?: Array<{ effects?: EffectItem[] } & Record<string, unknown>> };
          if (!Array.isArray(preset.steps)) return;
          const changed = migrateRefsInSteps(preset.steps, oldPath, newPath);
          if (changed) {
            await host.fs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");
          }
        } catch (err) {
          console.error(`migrateRefsInPresetFiles: failed to process ${filePath}`, err);
        }
      }),
  );
}

// Counter for "Untitled N" labels assigned to managed files (newFile).
// Persisted indirectly: at module load it starts at 0 and reopenPersistedFiles
// pulls forward to max(N) + 1 over any rehydrated "Untitled N" names so a
// freshly-created managed file in the new session never collides with one
// from the previous session.
let untitledCounter = 0;
function nextUntitledName(): string {
  untitledCounter++;
  return `Untitled ${untitledCounter}`;
}
function bumpUntitledCounterTo(n: number): void {
  if (n > untitledCounter) untitledCounter = n;
}

// Strip a file extension from a display label so derivatives compose cleanly
// ("foo.wav" + " copy" reads as "foo copy" rather than "foo.wav copy"). Names
// without an extension (managed-file labels like "Untitled 1") pass through
// unchanged.
function stripExtensionForLabel(name: string): string {
  const ext = host.path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

// Run gaborator analysis on a real on-disk wav and stash the resulting
// SpectrogramData on the file. Used by first-time-open and as a recovery
// fallback in reopenPersistedFiles when a real file's history dir is missing.
async function loadRealFileViaGaborator(
  fileId: string,
  filePath: string,
  bandsPerOctave: number,
  minFreq: number,
): Promise<void> {
  const file = openFiles[fileId];
  if (!file) return;
  const result = await host.analysis.analyze(filePath, { bandsPerOctave, minFreq });
  const spectrogramData = {
    packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
    inverseMap: new Float32Array(
      result.inverseMap.buffer,
      result.inverseMap.byteOffset,
      result.inverseMap.byteLength / 4,
    ),
    metadata: new Float32Array(result.metadata.buffer, result.metadata.byteOffset, result.metadata.byteLength / 4),
    textureWidth: result.textureWidth,
    textureHeight: result.textureHeight,
    numFrames: result.numFrames,
    numBands: result.numBands,
    numChannels: result.numChannels,
    sampleRate: result.sampleRate,
    packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
    minFreq,
    bandsPerOctave,
    synthesisMetadata: {
      bandOffsets: result.bandOffsets,
      bandStepLog2s: result.bandStepLog2s,
      bandLengths: result.bandLengths,
    },
  };
  openFiles[fileId] = { ...openFiles[fileId], spectrogramData };
}

// In-flight AI separation guard — blocks a second concurrent stem split on the same file.
const aiSeparatingFileIds = new Set<string>();

/** Get a consistent colour for a file based on a hash of its file path. */
export function getFileColor(filePath: string): string {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = filePath.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 60%)`;
}

/** Look up an open file by its file path. Returns the first match or undefined. */
export function getOpenFileByPath(filePath: string): OpenFile | undefined {
  return Object.values(openFiles).find((f) => f.filePath === filePath);
}

/** A single reference from a brush step (or effect within a step) to an open file. */
export type FileReference = {
  brushIndex: number;
  brushName: string;
  paramKey: ParameterKey;
  paramLabel: string;
};

function forEachFileValue(
  brushes: Brush[],
  visit: (ref: { brushIndex: number; brushName: string; paramKey: ParameterKey; value: FileParameterValue }) => void,
) {
  const fileKeys = getFileParameterKeys();
  brushes.forEach((brush, brushIndex) => {
    for (const step of brush.steps) {
      for (const key of fileKeys) {
        const def = parameterDefs[key];
        if (!def || def.kind !== "file") continue;
        if (def.effectType) {
          const effects = (step.effects ?? []) as EffectItem[];
          for (const effect of effects) {
            if (effect.effect !== def.effectType) continue;
            const val = effect.params?.[key] as FileParameterValue | undefined;
            if (val) visit({ brushIndex, brushName: brush.name, paramKey: key, value: val });
          }
        } else {
          const val = (step as Record<string, unknown>)[key] as FileParameterValue | undefined;
          if (val) visit({ brushIndex, brushName: brush.name, paramKey: key, value: val });
        }
      }
    }
  });
}

/** Find every place a file path is referenced across all brushes (step sources + effect file params). */
export function findFileReferences(filePath: string, brushes: Brush[]): FileReference[] {
  const results: FileReference[] = [];
  forEachFileValue(brushes, ({ brushIndex, brushName, paramKey, value }) => {
    if (value?.path === filePath) {
      const def = parameterDefs[paramKey];
      if (def) results.push({ brushIndex, brushName, paramKey, paramLabel: def.label });
    }
  });
  return results;
}

/** Check if a file is referenced by any brush (as source or as an effect file param). */
export function isFileReferenced(filePath: string, brushes: Brush[]): boolean {
  return findFileReferences(filePath, brushes).length > 0;
}

/** Collect every distinct file path referenced by a single brush (for bulk load). */
export function collectBrushReferencedPaths(brush: Brush): string[] {
  const paths = new Set<string>();
  forEachFileValue([brush], ({ value }) => {
    if (value?.path) paths.add(value.path);
  });
  return [...paths];
}

// Tone.js player for audio playback
export const player = new Tone.Player().toDestination();

// Helper to get file by ID
export function getFileById(fileId: string): OpenFile | undefined {
  return openFiles[fileId];
}

// Helper to find file ID by path
export function getFileIdByPath(filePath: string): string | undefined {
  return Object.keys(openFiles).find((id) => openFiles[id].filePath === filePath);
}

export const FILES_PERSISTED_KEYS = [
  "filepathsBpm",
  "minimizedFileIds",
  "persistedFilePaths",
  "recentFilePaths",
  "openFileIds",
  "activeFileId",
  "fullscreenFileId",
  "filesBandsPerOctave",
  "filesZoom",
  "filesOffset",
  "filesZoomY",
  "filesOffsetY",
  "filesPlaybackStartTime",
  // Persisted so the italic "unsaved" tab marker survives restart — managed
  // files in particular are always dirty until promoted via Save As.
  "filesDirty",
  // Persisted so a managed file's "Untitled N" label is stable across
  // sessions (a file the user knew as "Untitled 5" yesterday stays as
  // "Untitled 5" today instead of being renumbered by iteration order).
  "fileDisplayNames",
] as const;

export const createFilesSlice = (set: ZustandSet, get: ZustandGet): FilesState => ({
  newFile: async () => {
    const values = await new Promise<{
      sampleRate: number;
      bpm: number;
      lengthBeats: number;
    } | null>((resolve) => {
      let confirmed = false;
      openNewFilePrompt({
        onConfirm: (v) => {
          confirmed = true;
          resolve(v);
        },
        onClose: () => {
          if (!confirmed) resolve(null);
        },
      });
    });
    if (!values) return;
    const { sampleRate, bpm, lengthBeats } = values;

    const state = get();

    try {
      const lengthSeconds = (60 / bpm) * lengthBeats;
      const audioBuffer = new AudioBuffer({
        length: lengthSeconds * sampleRate,
        sampleRate,
        numberOfChannels: 2,
      });
      const result = await host.analysis.analyseBuffer(audioBuffer, {
        bandsPerOctave: state.bandsPerOctave,
        minFreq: state.minFreq,
      });

      const spectrogramData = {
        packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
        inverseMap: new Float32Array(
          result.inverseMap.buffer,
          result.inverseMap.byteOffset,
          result.inverseMap.byteLength / 4,
        ),
        metadata: new Float32Array(result.metadata.buffer, result.metadata.byteOffset, result.metadata.byteLength / 4),
        textureWidth: result.textureWidth,
        textureHeight: result.textureHeight,
        numFrames: result.numFrames,
        numBands: result.numBands,
        numChannels: result.numChannels,
        sampleRate: result.sampleRate,
        packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
        minFreq: state.minFreq,
        bandsPerOctave: state.bandsPerOctave,
        synthesisMetadata: {
          bandOffsets: result.bandOffsets,
          bandStepLog2s: result.bandStepLog2s,
          bandLengths: result.bandLengths,
        },
      };

      const fileId = generateFileId();
      const filepath = makeManagedFilePath(fileId);
      const displayName = nextUntitledName();
      openFiles[fileId] = {
        id: fileId,
        filePath: filepath,
        displayName,
        spectrogramData,
      };

      return set(
        produce((state: State) => {
          state.openFileIds.push(fileId);
          state.filepathsBpm[filepath] = bpm;
          state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
          state.filesZoom[fileId] = 0;
          state.filesOffset[fileId] = 0;
          state.filesZoomY[fileId] = 0;
          state.filesOffsetY[fileId] = 0;
          state.filesPlaybackStartTime[fileId] = 0;
          state.filesDirty[fileId] = true;
          // Managed files persist across sessions; their history dir is the
          // sole on-disk backing and is rehydrated by reopenPersistedFiles.
          state.persistedFilePaths[fileId] = filepath;
          state.fileDisplayNames[fileId] = displayName;

          state.activeFileId = fileId;
        }),
      );
    } catch (error) {
      console.error("Error opening file:", error);
      notifications.show({
        title: `Failed to create file`,
        message: `Creating the new file failed. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }

    console.log("Creating new file with:", { sampleRate, bpm, length });
  },
  openFileIds: [],
  openFilePath: async (filepath: string) => {
    const state = get();

    get().addRecentFilePath(filepath);

    // If the file is already open, activate it (un-minimizing if needed) instead of opening again
    const existing = Object.values(openFiles).find((f) => f.filePath === filepath);
    if (existing) {
      if (state.minimizedFileIds.includes(existing.id)) {
        get().setFileMinimized(existing.id, false);
      } else {
        get().setActiveFileId(existing.id);
      }
      return;
    }

    const fileId = generateFileId();
    const displayName = host.path.basename(filepath);

    // Add a placeholder immediately so the file appears in the UI with a loading
    // state. Newly opened files go to the top of the list.
    openFiles[fileId] = { id: fileId, filePath: filepath, displayName };
    set(
      produce((state: State) => {
        state.openFileIds.unshift(fileId);
        state.filepathsBpm[filepath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesZoomY[fileId] = 0;
        state.filesOffsetY[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
        state.persistedFilePaths[fileId] = filepath;
        state.fileDisplayNames[fileId] = displayName;
      }),
    );

    try {
      await loadRealFileViaGaborator(fileId, filepath, state.bandsPerOctave, state.minFreq);
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
          state.activeFileId = fileId;
        }),
      );
    } catch (error) {
      // Remove the placeholder on failure
      delete openFiles[fileId];
      set(
        produce((state: State) => {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.filesLoading[fileId];
          delete state.filesBandsPerOctave[fileId];
          delete state.filesZoom[fileId];
          delete state.filesOffset[fileId];
          delete state.filesZoomY[fileId];
          delete state.filesOffsetY[fileId];
          delete state.filesPlaybackStartTime[fileId];
          delete state.persistedFilePaths[fileId];
          delete state.fileDisplayNames[fileId];
        }),
      );
      console.error("Error opening file:", error);
      notifications.show({
        title: `Failed to open file`,
        message: `Opening '${truncateMiddle(host.path.basename(filepath), 50)}' failed. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  duplicateFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    if (!originalFile?.spectrogramData) return;

    const fboData = await originalFile.rendererRef?.current?.getFBOData();
    if (!fboData) {
      console.error("Failed to duplicate file: could not get FBO data");
      return;
    }

    const newFileId = generateFileId();
    const newFilePath = makeManagedFilePath(newFileId);
    const displayName = `${stripExtensionForLabel(originalFile.displayName)} copy`;

    const newFile: OpenFile = {
      id: newFileId,
      filePath: newFilePath,
      displayName,
      spectrogramData: {
        ...originalFile.spectrogramData,
        packedData: fboData,
        inverseMap: originalFile.spectrogramData.inverseMap.slice(),
        metadata: originalFile.spectrogramData.metadata.slice(),
        synthesisMetadata: {
          bandLengths: originalFile.spectrogramData.synthesisMetadata.bandLengths.slice(),
          bandOffsets: originalFile.spectrogramData.synthesisMetadata.bandOffsets.slice(),
          bandStepLog2s: originalFile.spectrogramData.synthesisMetadata.bandStepLog2s.slice(),
        },
      },
    };

    openFiles[newFileId] = newFile;

    const sourceBpm = get().filepathsBpm[originalFile.filePath];

    set(
      produce((state: State) => {
        state.openFileIds.push(newFileId);
        state.activeFileId = newFileId;
        state.filesBandsPerOctave[newFileId] = state.filesBandsPerOctave[fileId];
        state.filesZoom[newFileId] = state.filesZoom[fileId];
        state.filesOffset[newFileId] = state.filesOffset[fileId];
        state.filesZoomY[newFileId] = state.filesZoomY[fileId] ?? 0;
        state.filesOffsetY[newFileId] = state.filesOffsetY[fileId] ?? 0;
        state.filesPlaybackStartTime[newFileId] = state.filesPlaybackStartTime[fileId];
        state.filesDirty[newFileId] = true;
        state.persistedFilePaths[newFileId] = newFilePath;
        state.fileDisplayNames[newFileId] = displayName;
        if (sourceBpm !== undefined) {
          state.filepathsBpm[newFilePath] = sourceBpm;
        }
      }),
    );
  },
  hpssFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;

    const fboData = await originalFile.rendererRef?.current?.getFBOData();
    if (!fboData) return;

    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    const harmonicId = generateFileId();
    const percussiveId = generateFileId();

    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    // Add placeholder files immediately so they appear in the UI with a loading state
    openFiles[harmonicId] = {
      id: harmonicId,
      filePath: makeManagedFilePath(harmonicId),
      displayName: `${baseLabel} harmonic`,
    };
    openFiles[percussiveId] = {
      id: percussiveId,
      filePath: makeManagedFilePath(percussiveId),
      displayName: `${baseLabel} percussive`,
    };

    const sourceBpm = get().filepathsBpm[originalFile.filePath];

    set(
      produce((state: State) => {
        const idx = state.openFileIds.indexOf(fileId);
        state.openFileIds.splice(idx + 1, 0, harmonicId, percussiveId);
        for (const id of [harmonicId, percussiveId]) {
          const newPath = openFiles[id].filePath;
          state.filesBandsPerOctave[id] = state.filesBandsPerOctave[fileId];
          state.filesZoom[id] = state.filesZoom[fileId];
          state.filesOffset[id] = state.filesOffset[fileId];
          state.filesZoomY[id] = state.filesZoomY[fileId] ?? 0;
          state.filesOffsetY[id] = state.filesOffsetY[fileId] ?? 0;
          state.filesPlaybackStartTime[id] = 0;
          state.filesDirty[id] = true;
          state.persistedFilePaths[id] = newPath;
          state.fileDisplayNames[id] = openFiles[id].displayName;
          state.filepathsBpm[newPath] = sourceBpm;
          state.filesLoading[id] = "Separating harmonic and percussive...";
        }
      }),
    );

    try {
      const { harmonic, percussive } = await host.analysis.hpss(fboData, {
        numBands: spectrogramData.numBands,
        numChannels: spectrogramData.numChannels,
        bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
        bandLengths: spectrogramData.synthesisMetadata.bandLengths,
      });

      const makeSpectrogramData = (data: Float32Array) => ({
        ...spectrogramData,
        packedData: data,
        inverseMap: spectrogramData.inverseMap.slice(),
        metadata: spectrogramData.metadata.slice(),
        synthesisMetadata: {
          bandLengths: spectrogramData.synthesisMetadata.bandLengths.slice(),
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets.slice(),
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s.slice(),
        },
      });

      openFiles[harmonicId] = { ...openFiles[harmonicId], spectrogramData: makeSpectrogramData(harmonic) };
      openFiles[percussiveId] = { ...openFiles[percussiveId], spectrogramData: makeSpectrogramData(percussive) };
    } finally {
      set(
        produce((state: State) => {
          delete state.filesLoading[harmonicId];
          delete state.filesLoading[percussiveId];
        }),
      );
    }
  },
  aiSeparateFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;
    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    // Guard against re-entry: a second click during an in-flight separation would
    // spawn a duplicate set of four stem files, leaving orphaned entries behind.
    if (aiSeparatingFileIds.has(fileId)) return;
    aiSeparatingFileIds.add(fileId);

    const modelFile = "htdemucs.onnx";
    if (!host.analysis.isModelDownloaded(modelFile)) {
      notifications.show({
        id: "ai-model-download",
        title: "Downloading AI model",
        message: "Starting download…",
        color: "blue",
        loading: true,
        autoClose: false,
      });
      try {
        await host.analysis.downloadModel(modelFile, (downloaded, total) => {
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          const message =
            total > 0
              ? `${Math.round((downloaded / total) * 100)}%  (${mb} / ${(total / 1024 / 1024).toFixed(1)} MB)`
              : `${mb} MB downloaded…`;
          notifications.update({
            id: "ai-model-download",
            title: "Downloading AI model",
            message,
            color: "blue",
            loading: true,
            autoClose: false,
          });
        });
        notifications.update({
          id: "ai-model-download",
          title: "AI model ready",
          message: "Model downloaded successfully.",
          color: "green",
          loading: false,
          autoClose: 3000,
        });
      } catch (error) {
        notifications.update({
          id: "ai-model-download",
          title: "Model download failed",
          message: `${error instanceof Error ? error.message : String(error)}`,
          color: "red",
          loading: false,
          autoClose: 5000,
        });
        aiSeparatingFileIds.delete(fileId);
        return;
      }
    }

    const state = get();
    const stemNames = ["drums", "bass", "other", "vocals"];
    const stemIds = stemNames.map(() => generateFileId());

    const sourceBpm = state.filepathsBpm[originalFile.filePath];

    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    for (let i = 0; i < stemNames.length; i++) {
      openFiles[stemIds[i]] = {
        id: stemIds[i],
        filePath: makeManagedFilePath(stemIds[i]),
        displayName: `${baseLabel} ${stemNames[i]}`,
      };
    }

    set(
      produce((state: State) => {
        const idx = state.openFileIds.indexOf(fileId);
        state.openFileIds.splice(idx + 1, 0, ...stemIds);
        for (let i = 0; i < stemIds.length; i++) {
          const id = stemIds[i];
          state.filesBandsPerOctave[id] = state.filesBandsPerOctave[fileId];
          state.filesZoom[id] = state.filesZoom[fileId];
          state.filesOffset[id] = state.filesOffset[fileId];
          state.filesZoomY[id] = state.filesZoomY[fileId] ?? 0;
          state.filesOffsetY[id] = state.filesOffsetY[fileId] ?? 0;
          state.filesPlaybackStartTime[id] = 0;
          state.filesDirty[id] = true;
          state.persistedFilePaths[id] = openFiles[id].filePath;
          state.fileDisplayNames[id] = openFiles[id].displayName;
          state.filepathsBpm[openFiles[id].filePath] = sourceBpm;
          state.filesLoading[id] = "Separating stems (AI)…";
        }
      }),
    );

    let audioContext: AudioContext | null = null;
    try {
      // Step 1: Synthesize the current painted state via Gaborator → get audio channels
      const fboData = await originalFile.rendererRef?.current?.getFBOData();
      if (!fboData) throw new Error("Could not read current spectrogram state");

      const synthesisResult = await host.analysis.synthesize(
        fboData,
        {
          numFrames: spectrogramData.numFrames,
          numChannels: spectrogramData.numChannels,
          numBands: spectrogramData.numBands,
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s,
          bandLengths: spectrogramData.synthesisMetadata.bandLengths,
        },
        spectrogramData.sampleRate,
        { bandsPerOctave: spectrogramData.bandsPerOctave, minFreq: spectrogramData.minFreq },
        false, // don't normalize — preserve relative levels for separation
      );

      // Step 2: AI-separate the synthesized audio into stems
      const stems = await host.analysis.aiSeparate(synthesisResult.channels, spectrogramData.sampleRate);

      // Step 3: Re-analyse each stem with Gaborator → SpectrogramData → new file entry
      const analysisParams = { bandsPerOctave: spectrogramData.bandsPerOctave, minFreq: spectrogramData.minFreq };
      audioContext = new AudioContext({ sampleRate: spectrogramData.sampleRate });

      for (let i = 0; i < stemNames.length; i++) {
        const stemChannels = stems[stemNames[i]];
        if (!stemChannels) continue;

        const numSamples = stemChannels[0].length;
        const audioBuffer = audioContext.createBuffer(stemChannels.length, numSamples, spectrogramData.sampleRate);
        for (let ch = 0; ch < stemChannels.length; ch++) {
          audioBuffer.copyToChannel(new Float32Array(stemChannels[ch]), ch);
        }

        const result = await host.analysis.analyseBuffer(audioBuffer, analysisParams);

        openFiles[stemIds[i]] = {
          ...openFiles[stemIds[i]],
          spectrogramData: {
            packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
            inverseMap: new Float32Array(
              result.inverseMap.buffer,
              result.inverseMap.byteOffset,
              result.inverseMap.byteLength / 4,
            ),
            metadata: new Float32Array(
              result.metadata.buffer,
              result.metadata.byteOffset,
              result.metadata.byteLength / 4,
            ),
            textureWidth: result.textureWidth,
            textureHeight: result.textureHeight,
            numFrames: result.numFrames,
            numBands: result.numBands,
            numChannels: result.numChannels,
            sampleRate: result.sampleRate,
            packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
            minFreq: state.minFreq,
            bandsPerOctave: state.bandsPerOctave,
            synthesisMetadata: {
              bandOffsets: result.bandOffsets,
              bandStepLog2s: result.bandStepLog2s,
              bandLengths: result.bandLengths,
            },
          },
        };
      }

      audioContext.close();
      audioContext = null;
    } catch (error) {
      audioContext?.close();
      console.error("AI separation failed:", error);
      notifications.show({
        title: "AI separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      const idsToRemove = [...stemIds];
      for (const id of idsToRemove) delete openFiles[id];
      set(
        produce((state: State) => {
          state.openFileIds = state.openFileIds.filter((id) => !idsToRemove.includes(id));
          for (const id of idsToRemove) {
            delete state.filesBandsPerOctave[id];
            delete state.filesZoom[id];
            delete state.filesOffset[id];
            delete state.filesZoomY[id];
            delete state.filesOffsetY[id];
            delete state.filesPlaybackStartTime[id];
            delete state.filesDirty[id];
            delete state.filesLoading[id];
            delete state.persistedFilePaths[id];
            delete state.fileDisplayNames[id];
          }
        }),
      );
      aiSeparatingFileIds.delete(fileId);
      return;
    }

    set(
      produce((state: State) => {
        for (const id of stemIds) delete state.filesLoading[id];
      }),
    );
    aiSeparatingFileIds.delete(fileId);
  },
  saveActiveFile: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file || !file.audioBuffer) return;

    // Managed files have no real on-disk path to overwrite — Save means
    // "promote to a real file at a chosen location," which is exactly Save As.
    if (isManagedFilePath(file.filePath)) {
      await get().saveActiveFileAs();
      return;
    }

    const filePath = file.filePath;
    const fileName = host.path.basename(filePath);

    // Show confirmation modal
    return new Promise<void>((resolve) => {
      openConfirm({
        title: "Overwrite File",
        message: `Do you want to overwrite "${truncateMiddle(fileName, 50)}"?`,
        confirmLabel: "Overwrite",
        danger: true,
        onConfirm: async () => {
          try {
            // Extract audio channels from AudioBuffer
            const numChannels = file.audioBuffer!.numberOfChannels;
            const normalize = get().normalize;
            const gain = normalize && file.audioPeak && file.audioPeak > 0 ? 1 / file.audioPeak : 1;
            const audioChannels: Float32Array[] = [];
            for (let i = 0; i < numChannels; i++) {
              const src = file.audioBuffer!.getChannelData(i);
              const dst = new Float32Array(src.length);
              for (let j = 0; j < src.length; j++) dst[j] = src[j] * gain;
              audioChannels.push(dst);
            }

            // Determine format from file extension
            const ext = host.path.extname(filePath).slice(1).toLowerCase();
            const format = ext || "wav";

            // Export the audio
            await host.analysis.exportAudio(audioChannels, filePath, file.audioBuffer!.sampleRate, format);

            // The current history node now matches what's on disk.
            await getHistoryManager(state.activeFileId!).markSaved();
            console.log("File saved successfully:", filePath);

            // Show success notification
            notifications.show({
              title: "File saved",
              message: `Successfully saved ${truncateMiddle(fileName, 50)}`,
            });
          } catch (error) {
            console.error("Error saving file:", error);
            // Show error notification
            notifications.show({
              title: "Save failed",
              message: `Failed to save file '${truncateMiddle(fileName, 50)}'. ${error instanceof Error ? error.message : ""}`,
              color: "red",
            });
          }
          resolve();
        },
        onCancel: () => resolve(),
      });
    });
  },
  saveActiveFileAs: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file || !file.audioBuffer) return;

    const currentFilePath = file.filePath;
    const isManaged = isManagedFilePath(currentFilePath);
    // For managed files there's no real directory to suggest — fall back to
    // userData equivalents the OS dialog already defaults to. Use just the
    // displayName as the filename suggestion.
    const defaultPath = isManaged
      ? `${file.displayName}.wav`
      : host.path.join(host.path.dirname(currentFilePath), host.path.basename(currentFilePath));

    const result = await host.dialogs.showSaveDialog({
      defaultPath,
      filters: [
        { name: "Audio Files", extensions: ["wav", "flac", "mp3"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) return;

    const outputPath = result.filePath;
    const savedFileName = host.path.basename(outputPath);
    const truncatedFileName = truncateMiddle(savedFileName, 50);

    try {
      // Extract audio channels from AudioBuffer, applying normalize gain to match the saveActiveFile path.
      const numChannels = file.audioBuffer.numberOfChannels;
      const normalize = get().normalize;
      const gain = normalize && file.audioPeak && file.audioPeak > 0 ? 1 / file.audioPeak : 1;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        const src = file.audioBuffer.getChannelData(i);
        const dst = new Float32Array(src.length);
        for (let j = 0; j < src.length; j++) dst[j] = src[j] * gain;
        audioChannels.push(dst);
      }

      // Determine format from file extension
      const ext = host.path.extname(outputPath).slice(1).toLowerCase();
      const format = ext || "wav";

      // Export the audio
      await host.analysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.displayName = savedFileName;
      set(
        produce((draft: State) => {
          const oldBpm = draft.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            draft.filepathsBpm[outputPath] = oldBpm;
            // For managed → real promotions the sentinel BPM key is now dead;
            // for real → real renames the old path's BPM is no longer attached
            // to any open file either (a fresh open of oldFilePath would seed
            // its own entry).
            delete draft.filepathsBpm[oldFilePath];
          }
          draft.persistedFilePaths[state.activeFileId!] = outputPath;
          draft.fileDisplayNames[state.activeFileId!] = savedFileName;
          // Walk in-session brushes so any sourceFile / effect file refs that
          // pointed at the old path follow the rename. On-disk presets are
          // also rewritten below (best-effort, fire-and-forget) so a preset
          // that referenced a managed file by its sentinel path follows the
          // promotion to a real path.
          migrateBrushRefs(draft.brushes, oldFilePath, outputPath);
        }),
      );

      const presetsDir = get().presetsDir;
      if (presetsDir) {
        void migrateRefsInPresetFiles(presetsDir, oldFilePath, outputPath);
      }

      // The active file is now a real file whose current node matches disk.
      await getHistoryManager(state.activeFileId!).markSaved();
      console.log("File saved as:", outputPath);

      // Show success notification

      notifications.show({
        title: "File saved",
        message: `Successfully saved as ${truncatedFileName}`,
      });
    } catch (error) {
      console.error("Error saving file as:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save file '${truncatedFileName}'. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  saveActiveFileVersion: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file || !file.audioBuffer) return;

    // Versioned saves derive a new name from the source path's directory and
    // extension. Managed files have no real path to derive from — fall back
    // to Save As.
    if (isManagedFilePath(file.filePath)) {
      await get().saveActiveFileAs();
      return;
    }

    const currentFilePath = file.filePath;
    const dir = host.path.dirname(currentFilePath);
    const ext = host.path.extname(currentFilePath);
    const baseName = host.path.basename(currentFilePath, ext);

    // Check if filename ends with _NUMBER
    const versionMatch = baseName.match(/^(.+)_(\d+)$/);
    let newFileName: string;

    if (versionMatch) {
      // Increment existing version number
      const nameWithoutVersion = versionMatch[1];
      const currentVersion = parseInt(versionMatch[2], 10);
      const newVersion = currentVersion + 1;
      newFileName = `${nameWithoutVersion}_${newVersion}${ext}`;
    } else {
      // Add _1 to the filename
      newFileName = `${baseName}_1${ext}`;
    }

    const outputPath = host.path.join(dir, newFileName);
    const truncatedFileName = truncateMiddle(newFileName, 50);

    try {
      // Extract audio channels from AudioBuffer, applying normalize gain to match the saveActiveFile path.
      const numChannels = file.audioBuffer.numberOfChannels;
      const normalize = get().normalize;
      const gain = normalize && file.audioPeak && file.audioPeak > 0 ? 1 / file.audioPeak : 1;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        const src = file.audioBuffer.getChannelData(i);
        const dst = new Float32Array(src.length);
        for (let j = 0; j < src.length; j++) dst[j] = src[j] * gain;
        audioChannels.push(dst);
      }

      // Determine format from file extension
      const format = ext.slice(1).toLowerCase() || "wav";

      // Export the audio
      await host.analysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.displayName = newFileName;
      set(
        produce((draft: State) => {
          const oldBpm = draft.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            draft.filepathsBpm[outputPath] = oldBpm;
          }
          draft.persistedFilePaths[state.activeFileId!] = outputPath;
          draft.fileDisplayNames[state.activeFileId!] = newFileName;
          // saveActiveFileVersion only runs for real files (the managed branch
          // bails out earlier), so oldFilePath is a normal filesystem path —
          // any in-session brush refs to it should follow the rename too.
          migrateBrushRefs(draft.brushes, oldFilePath, outputPath);
        }),
      );

      const presetsDir = get().presetsDir;
      if (presetsDir) {
        void migrateRefsInPresetFiles(presetsDir, oldFilePath, outputPath);
      }

      // The active file now points at the version on disk at the current node.
      await getHistoryManager(state.activeFileId!).markSaved();
      console.log("File version saved:", outputPath);

      // Show success notification
      notifications.show({
        title: "Version saved",
        message: `Successfully saved as ${truncatedFileName}`,
      });
    } catch (error) {
      console.error("Error saving file version:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save file '${truncatedFileName}'. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  tryCloseFile: async (fileId: string) => {
    const state = get();
    const file = openFiles[fileId];
    if (!file) return;

    const refs = findFileReferences(file.filePath, state.brushes);
    if (refs.length > 0) {
      const fileName = file.filePath.split("/").pop() || file.filePath;
      const refList = refs.map((r) => `${r.brushName} (${r.paramLabel})`).join(", ");
      const confirmed = await new Promise<boolean>((resolve) => {
        openConfirm({
          title: "File is referenced",
          message: `"${fileName}" is referenced by: ${refList}. Closing will remove these connections.`,
          confirmLabel: "Close",
          danger: true,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
          onClose: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    if (state.filesDirty[fileId]) {
      await new Promise<void>((resolve) => {
        openConfirm({
          title: "Unsaved Changes",
          message: `Are you sure you want to close this file without saving?`,
          confirmLabel: "Close",
          danger: true,
          onConfirm: async () => {
            state.closeFile(fileId);
            resolve();
          },
          onCancel: () => resolve(),
        });
      });
    } else state.closeFile(fileId);
  },
  closeFile: (fileId: string) => {
    const openFile = openFiles[fileId];
    const state = get();
    if (state.isPlaying && state.activeFileId === fileId) {
      state.stopAudio();
    }

    // Fire-and-forget: drops on-disk history directory and in-memory state.
    destroyHistoryManager(fileId).catch((err: unknown) => console.error("destroyHistoryManager failed", err));

    return set(
      produce((state: State) => {
        if (openFile) {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.filesBandsPerOctave[fileId];
          delete state.filesZoom[fileId];
          delete state.filesOffset[fileId];
          delete state.filesZoomY[fileId];
          delete state.filesOffsetY[fileId];
          delete state.filesPlaybackStartTime[fileId];
          delete state.filesDirty[fileId];
          delete state.persistedFilePaths[fileId];
          delete state.fileDisplayNames[fileId];
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          if (state.fullscreenFileId === fileId) state.fullscreenFileId = null;
          delete openFiles[fileId];

          const nextFileId = state.openFileIds[state.openFileIds.length - 1] || null;
          state.activeFileId = nextFileId || null;
        }
      }),
    );
  },
  synthesizeFile: async (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
    prefetchedFboData?: Float32Array,
  ) => {
    const synthesizeFileStart = performance.now();
    console.log("[timing] synthesizeFile started");

    const { activeFileId, getPlayer, setFileSynthesizing } = get();
    if (!activeFileId) return;

    try {
      const file = openFiles[fileId];
      if (!file || !file.rendererRef?.current || !file.spectrogramData) {
        return;
      }

      setFileSynthesizing(fileId, true);

      const originalAnalysis = file.spectrogramData;
      const renderer = file.rendererRef.current;

      // Use prefetched FBO data if provided, otherwise fetch it
      let fboData: Float32Array;
      if (prefetchedFboData) {
        console.log("[timing] using prefetched FBO data");
        fboData = prefetchedFboData;
      } else {
        const fboStart = performance.now();
        fboData = await renderer.getFBOData();
        console.log(`[timing] getFBOData (for synthesis): ${(performance.now() - fboStart).toFixed(2)}ms`);
      }

      const payload = {
        processedData: fboData.buffer,
        analysisMetadata: {
          numFrames: originalAnalysis.numFrames,
          numChannels: originalAnalysis.numChannels,
          numBands: originalAnalysis.numBands,
          bandOffsets: originalAnalysis.synthesisMetadata.bandOffsets,
          bandStepLog2s: originalAnalysis.synthesisMetadata.bandStepLog2s,
          bandLengths: originalAnalysis.synthesisMetadata.bandLengths,
        },
      };

      const analysisParams = {
        bandsPerOctave: originalAnalysis.bandsPerOctave,
        minFreq: originalAnalysis.minFreq,
      };

      const processedDataArray = new Float32Array(
        payload.processedData,
        0,
        payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      // Check for dirty region to enable partial synthesis optimization
      const dirtyRegionStart = performance.now();
      const dirtyRegion = renderer.getDirtyRegion();
      console.log(`[timing] getDirtyRegion: ${(performance.now() - dirtyRegionStart).toFixed(2)}ms`);

      const existingBuffer = file.audioBuffer;
      const canDoPartialSynthesis = dirtyRegion && existingBuffer;
      console.log("[timing] canDoPartialSynthesis:", canDoPartialSynthesis);

      let startFrame: number | undefined;
      let endFrame: number | undefined;
      let startBand: number | undefined;
      let endBand: number | undefined;
      let existingAudio: Float32Array[] | undefined;

      if (canDoPartialSynthesis) {
        // Convert UV coordinates to sample frames
        startFrame = Math.max(0, Math.floor(dirtyRegion.startX * originalAnalysis.numFrames));
        endFrame = Math.min(originalAnalysis.numFrames, Math.ceil(dirtyRegion.endX * originalAnalysis.numFrames));

        // UV Y=0 is the visual top (highest band index, highest freq); UV Y=1 is the bottom
        // (band 0, lowest freq). Invert so startBand..endBand covers the actually modified bands.
        startBand = Math.max(0, Math.floor((1.0 - dirtyRegion.endY) * originalAnalysis.numBands));
        endBand = Math.min(
          originalAnalysis.numBands,
          Math.ceil((1.0 - dirtyRegion.startY) * originalAnalysis.numBands),
        );

        // Extract existing audio channels for crossfade splicing in C++
        const extractStart = performance.now();
        existingAudio = [];
        for (let i = 0; i < existingBuffer.numberOfChannels; i++) {
          existingAudio.push(existingBuffer.getChannelData(i));
        }
        console.log(`[timing] extract existing audio channels: ${(performance.now() - extractStart).toFixed(2)}ms`);

        console.log("[timing] Partial synthesis range:", { startFrame, endFrame, startBand, endBand });
      }

      let synthesisResult;
      const cppSynthStart = performance.now();
      try {
        synthesisResult = await host.analysis.synthesize(
          processedDataArray,
          payload.analysisMetadata,
          originalAnalysis.sampleRate,
          analysisParams,
          false,
          existingAudio,
          startFrame,
          endFrame,
          startBand,
          endBand,
        );
      } catch (synthError) {
        console.error("[timing] Synthesis failed:", synthError);
        throw synthError;
      }
      const isPartial = startFrame !== undefined;
      console.log(
        `[timing] C++ synthesis: ${(performance.now() - cppSynthStart).toFixed(2)}ms` +
          (isPartial ? " (partial)" : " (full)"),
      );

      if (!synthesisResult || !synthesisResult.channels) {
        console.error("[timing] Invalid synthesis result:", synthesisResult);
        throw new Error("Synthesis returned invalid result");
      }

      // Clear dirty region after synthesis
      renderer.clearDirtyRegion();

      // C++ now returns the full buffer (with crossfade splice done internally)
      const audioBufferStart = performance.now();
      const numChannels = synthesisResult.channels.length;
      const numFrames = synthesisResult.channels[0].length;
      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(numChannels, numFrames, originalAnalysis.sampleRate);
      for (let i = 0; i < numChannels; i++) {
        const channelBuffer = synthesisResult.channels[i];
        audioBuffer.copyToChannel(channelBuffer as Float32Array<ArrayBuffer>, i);
      }
      console.log(`[timing] create AudioBuffer: ${(performance.now() - audioBufferStart).toFixed(2)}ms`);

      file.audioBuffer = audioBuffer;
      file.audioPeak = synthesisResult.peak > 0 ? synthesisResult.peak : 1;

      if (autoPlaybackParams) {
        // --- Handle auto-playback of the painted region ---
        const autoPlayStart = performance.now();
        const { startTimeSeconds, endTimeSeconds } = autoPlaybackParams;

        // If already playing, stop it first. togglePlayback is async.
        if (get().isPlaying) {
          await get().togglePlayback();
        }

        // Set the loop region for this stroke's playback
        get().setLoopRegion({ start: startTimeSeconds, end: endTimeSeconds });
        get().setFilePlaybackStartTime(fileId, startTimeSeconds);

        // Now, toggle playback ON. It will use the start/end times we just set.
        await get().togglePlayback();
        console.log(`[timing] auto-playback setup: ${(performance.now() - autoPlayStart).toFixed(2)}ms`);
      } else if (get().isPlaying && get().activeFileId === fileId) {
        // --- Handle standard buffer hot-swap while playing ---
        const bufferSwapStart = performance.now();
        const player = getPlayer();
        const t = get().getPlaybackTime(); // Get time BEFORE swapping

        // Swap the buffer in the player
        player.buffer = new Tone.ToneAudioBuffer(audioBuffer);

        // Update volume for new peak
        const peak = file.audioPeak ?? 1;
        const normalize = get().normalize;
        player.volume.value = normalize && peak > 0 ? Tone.gainToDb(1 / peak) : 0;

        // Use setPlaybackTime to correctly restart the player from the same spot
        // with the new buffer and correct loop settings.
        get().setPlaybackTime(t);
        console.log(`[timing] buffer hot-swap: ${(performance.now() - bufferSwapStart).toFixed(2)}ms`);
      }
      // If not playing and not auto-playing, do nothing. The new buffer is ready for the next time the user hits play.
      console.log(`[timing] synthesizeFile total: ${(performance.now() - synthesizeFileStart).toFixed(2)}ms`);
    } catch (error) {
      console.error("Error running synthesis:", error);
    } finally {
      setFileSynthesizing(fileId, false);
    }
  },
  loadCachedAudio: async (fileId: string, audioPath: string, peak: number): Promise<boolean> => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return false;

    const { setFileSynthesizing, getPlayer } = get();

    try {
      setFileSynthesizing(fileId, true);

      const sampleRate = file.spectrogramData.sampleRate;
      const numChannels = file.spectrogramData.numChannels;
      const channels = await host.analysis.decodeAudio(audioPath, sampleRate, numChannels);
      if (!channels.length || !channels[0].length) return false;

      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(numChannels, channels[0].length, sampleRate);
      for (let i = 0; i < numChannels; i++) {
        audioBuffer.copyToChannel(channels[i] as Float32Array<ArrayBuffer>, i);
      }

      file.audioBuffer = audioBuffer;
      file.audioPeak = peak > 0 ? peak : 1;

      // Hot-swap if currently playing this file
      if (get().isPlaying && get().activeFileId === fileId) {
        const player = getPlayer();
        const t = get().getPlaybackTime();
        player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
        const normalize = get().normalize;
        player.volume.value = normalize && file.audioPeak > 0 ? Tone.gainToDb(1 / file.audioPeak) : 0;
        get().setPlaybackTime(t);
      }

      return true;
    } catch (error) {
      console.error("Failed to load cached undo audio:", error);
      return false;
    } finally {
      setFileSynthesizing(fileId, false);
    }
  },
  exportHistory: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file) return;

    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest) {
      notifications.show({
        title: "Nothing to export",
        message: "No history for this file yet.",
        color: "yellow",
      });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export History",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);

    // Leaves (no children) → one root-to-leaf path per leaf.
    const leafIds = Object.values(manifest.nodes)
      .filter((n) => n.childIds.length === 0)
      .map((n) => n.id);
    const chains = leafIds.map((id) => chainFromRootTo(manifest, id));

    await runHistoryExport({
      historyManager,
      manifest,
      chains,
      outputRoot,
      pathOf,
      folderFor: (i) => `path-${String(i + 1).padStart(Math.max(2, String(chains.length).length), "0")}`,
      writeTreeJson: true,
      successNoun: `path${chains.length === 1 ? "" : "s"}`,
      successCount: chains.length,
    });
  },
  exportHistoryFavorites: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest) {
      notifications.show({ title: "Nothing to export", message: "No history yet.", color: "yellow" });
      return;
    }

    const favorites = Object.values(manifest.nodes)
      .filter((n) => n.favorited)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (favorites.length === 0) {
      notifications.show({
        title: "No favorites",
        message: "Favorite nodes via the right-click menu first.",
        color: "yellow",
      });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export Favorites",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);
    // One single-node "chain" per favorite — runHistoryExport already dedups
    // per node and writes to the root folder when folderFor returns null.
    const chains = favorites.map((n) => [n.id]);

    await runHistoryExport({
      historyManager,
      manifest,
      chains,
      outputRoot,
      pathOf,
      folderFor: () => null,
      writeTreeJson: false,
      successNoun: `favorite${favorites.length === 1 ? "" : "s"}`,
      successCount: favorites.length,
      omitOrdinal: true,
    });
  },
  exportHistoryBranch: async (nodeId: string) => {
    const state = get();
    if (!state.activeFileId) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest || !manifest.nodes[nodeId]) {
      notifications.show({ title: "Nothing to export", message: "Node no longer exists.", color: "yellow" });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export Branch",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);
    const chain = chainFromRootTo(manifest, nodeId);

    // Branch exports dump WAVs directly in the selected folder — no wrapper
    // subdirectory, since it's a single path.
    await runHistoryExport({
      historyManager,
      manifest,
      chains: [chain],
      outputRoot,
      pathOf,
      folderFor: () => null,
      writeTreeJson: false,
      successNoun: "node",
      successCount: chain.length,
    });
  },
  exportHistoryBranchToLive: async (nodeId: string) => {
    const state = get();
    if (!state.activeFileId || !host.session) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest || !manifest.nodes[nodeId]) {
      notifications.show({ title: "Nothing to export", message: "Node no longer exists.", color: "yellow" });
      return;
    }

    const chain = chainFromRootTo(manifest, nodeId);
    const notificationId = `branch-to-live-${nodeId}`;
    notifications.show({
      id: notificationId,
      title: "Rendering branch",
      message: `Synthesising ${chain.length} state${chain.length === 1 ? "" : "s"}…`,
      loading: true,
      autoClose: false,
      withCloseButton: false,
    });

    const renders: HostRender[] = [];
    for (const id of chain) {
      const node = manifest.nodes[id];
      if (!node) continue;
      const audio = await historyManager.synthesizeNodeAudio(id);
      if (!audio) continue;
      renders.push({ channels: audio.channels, sampleRate: audio.sampleRate, label: node.customLabel ?? node.label });
    }

    if (renders.length === 0) {
      notifications.update({
        id: notificationId,
        title: "Nothing to export",
        message: "Could not render any states in this branch.",
        loading: false,
        autoClose: 4000,
        color: "yellow",
      });
      return;
    }

    notifications.hide(notificationId);
    await host.session.apply(renders);
  },
  reanalyzeActiveFile: async () => {
    const initialState = get();
    if (!initialState.activeFileId) return;
    const file = openFiles[initialState.activeFileId];

    openReanalyzePrompt({
      initialBandsPerOctave: initialState.bandsPerOctave,
      onConfirm: async (bandsPerOctave) => {
        const state = get();
        if (!state.activeFileId) return;
        const audioBuffer = file?.audioBuffer;

        try {
          const result = audioBuffer
            ? await host.analysis.analyseBuffer(audioBuffer, {
                bandsPerOctave,
                minFreq: state.minFreq,
              })
            : await host.analysis.analyze(file.filePath, {
                bandsPerOctave,
                minFreq: state.minFreq,
              });

          const spectrogramData = {
            packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
            inverseMap: new Float32Array(
              result.inverseMap.buffer,
              result.inverseMap.byteOffset,
              result.inverseMap.byteLength / 4,
            ),
            metadata: new Float32Array(
              result.metadata.buffer,
              result.metadata.byteOffset,
              result.metadata.byteLength / 4,
            ),
            textureWidth: result.textureWidth,
            textureHeight: result.textureHeight,
            numFrames: result.numFrames,
            numBands: result.numBands,
            numChannels: result.numChannels,
            sampleRate: result.sampleRate,
            packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
            minFreq: state.minFreq,
            bandsPerOctave,
            synthesisMetadata: {
              bandOffsets: result.bandOffsets,
              bandStepLog2s: result.bandStepLog2s,
              bandLengths: result.bandLengths,
            },
          };

          file.spectrogramData = spectrogramData;

          file.rendererRef?.current?.reloadTextures();

          await getHistoryManager(state.activeFileId).addSnapshot({
            data: spectrogramData.packedData,
            kind: "reanalyze",
            label: "Re-analyze",
            spectrogram: spectrogramData,
          });

          return set(
            produce((state: State) => {
              state.bandsPerOctave = bandsPerOctave;
              state.filesBandsPerOctave[state.activeFileId!] = bandsPerOctave;
            }),
          );
        } catch (error) {
          console.error("Error during re-analysis:", error);
          notifications.show({
            title: "Re-analysis failed",
            message: `${error instanceof Error ? error.message : "Unknown error"}`,
            color: "red",
          });
          return;
        }
      },
    });
  },
  resizeActiveFileLength: async (factor: 2 | 0.5) => {
    const state = get();
    if (!state.activeFileId) return;
    const fileId = state.activeFileId;
    const file = openFiles[fileId];
    if (!file?.spectrogramData || !file.rendererRef?.current) return;

    const { spectrogramData } = file;
    const analysisParams = { bandsPerOctave: spectrogramData.bandsPerOctave, minFreq: spectrogramData.minFreq };

    try {
      const fboData = await file.rendererRef.current.getFBOData();
      if (!fboData) throw new Error("Could not read the current spectrogram state.");

      const synthResult = await host.analysis.synthesize(
        fboData,
        {
          numFrames: spectrogramData.numFrames,
          numChannels: spectrogramData.numChannels,
          numBands: spectrogramData.numBands,
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s,
          bandLengths: spectrogramData.synthesisMetadata.bandLengths,
        },
        spectrogramData.sampleRate,
        analysisParams,
        false,
      );

      const oldLength = synthResult.channels[0]?.length ?? 0;
      const newLength = factor === 2 ? oldLength * 2 : Math.floor(oldLength / 2);
      if (newLength <= 0) throw new Error("The file is too short to halve.");

      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(synthResult.channels.length, newLength, spectrogramData.sampleRate);
      for (let ch = 0; ch < synthResult.channels.length; ch++) {
        const src = synthResult.channels[ch];
        const dst = new Float32Array(newLength);
        if (factor === 2) {
          dst.set(src, 0);
          dst.set(src, oldLength);
        } else {
          dst.set(src.subarray(0, newLength), 0);
        }
        audioBuffer.copyToChannel(dst, ch);
      }

      const result = await host.analysis.analyseBuffer(audioBuffer, analysisParams);

      file.spectrogramData = {
        packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
        inverseMap: new Float32Array(
          result.inverseMap.buffer,
          result.inverseMap.byteOffset,
          result.inverseMap.byteLength / 4,
        ),
        metadata: new Float32Array(result.metadata.buffer, result.metadata.byteOffset, result.metadata.byteLength / 4),
        textureWidth: result.textureWidth,
        textureHeight: result.textureHeight,
        numFrames: result.numFrames,
        numBands: result.numBands,
        numChannels: result.numChannels,
        sampleRate: result.sampleRate,
        packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
        minFreq: analysisParams.minFreq,
        bandsPerOctave: analysisParams.bandsPerOctave,
        synthesisMetadata: {
          bandOffsets: result.bandOffsets,
          bandStepLog2s: result.bandStepLog2s,
          bandLengths: result.bandLengths,
        },
      };
      file.audioBuffer = audioBuffer;

      let newPeak = 0;
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > newPeak) newPeak = v;
        }
      }
      file.audioPeak = newPeak > 0 ? newPeak : 1;

      file.rendererRef.current.reloadTextures();

      await getHistoryManager(fileId).addSnapshot({
        data: file.spectrogramData.packedData,
        kind: "resize",
        label: "Resize",
        spectrogram: file.spectrogramData,
      });

      set(
        produce((s: State) => {
          s.filesDirty[fileId] = true;
        }),
      );
    } catch (error) {
      console.error("Resize failed:", error);
      notifications.show({
        title: "Resize failed",
        message: error instanceof Error ? error.message : "Unknown error",
        color: "red",
      });
    }
  },
  filepathsBpm: {},
  setFilepathBpm: (filepath, bpm) =>
    set(
      produce((state: State) => {
        state.filepathsBpm[filepath] = bpm;
        state.mostRecentBpm = bpm;
      }),
    ),
  mostRecentBpm: null,
  setMostRecentBpm: (bpm: number) => set({ mostRecentBpm: bpm }),
  filesBandsPerOctave: {},
  setFileBandsPerOctave: (fileId, bandsPerOctave) =>
    set(
      produce((state: State) => {
        state.filesBandsPerOctave[fileId] = bandsPerOctave;
      }),
    ),
  filesZoom: {},
  setFileZoom: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        state.filesZoom[fileId] = zoom;
      }),
    ),
  filesOffset: {},
  setFileOffset: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        state.filesOffset[fileId] = offset;
      }),
    ),
  filesZoomY: {},
  setFileZoomY: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        state.filesZoomY[fileId] = zoom;
      }),
    ),
  filesOffsetY: {},
  setFileOffsetY: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        state.filesOffsetY[fileId] = offset;
      }),
    ),
  persistedFilePaths: {},
  fileDisplayNames: {},
  recentFilePaths: [],
  addRecentFilePath: (filePath: string) => {
    set(
      produce((state: State) => {
        const filtered = state.recentFilePaths.filter((p) => p !== filePath);
        filtered.unshift(filePath);
        state.recentFilePaths = filtered.slice(0, 20);
      }),
    );
  },
  clearRecentFilePaths: () => {
    set(
      produce((state: State) => {
        state.recentFilePaths = [];
      }),
    );
  },
  reopenPersistedFiles: async () => {
    const state = get();
    const entries = Object.entries(state.persistedFilePaths);
    if (entries.length === 0) return;

    // Pull the untitled counter forward past any persisted "Untitled N"
    // labels so a freshly-created managed file later in the session doesn't
    // collide with one we're rehydrating.
    for (const persistedName of Object.values(state.fileDisplayNames)) {
      const m = /^Untitled (\d+)$/.exec(persistedName);
      if (m) bumpUntitledCounterTo(parseInt(m[1], 10));
    }

    const newlyAssigned: Record<string, string> = {};
    for (const [fileId, filePath] of entries) {
      // Prefer the persisted label so a managed file's "Untitled N" stays
      // stable across sessions. Fall back to a freshly-derived label only
      // when a persisted entry has no name (legacy state, or a prior bug).
      const persisted = state.fileDisplayNames[fileId];
      const displayName =
        persisted ?? (isManagedFilePath(filePath) ? nextUntitledName() : host.path.basename(filePath));
      if (!persisted) newlyAssigned[fileId] = displayName;
      openFiles[fileId] ??= { id: fileId, filePath, displayName };
    }
    // Persist any names we had to invent for entries missing a label so the
    // next session is fully stable.
    if (Object.keys(newlyAssigned).length > 0) {
      set(
        produce((draft: State) => {
          for (const [id, name] of Object.entries(newlyAssigned)) {
            draft.fileDisplayNames[id] = name;
          }
        }),
      );
    }
    set(
      produce((draft: State) => {
        for (const [fileId] of entries) {
          draft.filesLoading[fileId] = "Loading...";
        }
      }),
    );

    await Promise.all(
      entries.map(async ([fileId, filePath]) => {
        try {
          // History is the source of truth on reopen — skip gaborator entirely.
          // The root snapshot has full SpectrogramData (dimensions + inverseMap
          // + metadata + synthesisMetadata) and stroke deltas reproduce the
          // painted state at currentId.
          const historyManager = getHistoryManager(fileId);
          const hadExisting = await historyManager.initialize();
          if (!hadExisting) {
            // No on-disk history: this can only happen if persistedFilePaths
            // got out of sync (e.g. a crash between addRootSnapshot and the
            // store persist write). For real files we can fall back to
            // gaborator — for managed files there's no fallback.
            if (isManagedFilePath(filePath)) {
              throw new Error("No history found for managed file");
            }
            const pathState = get();
            await loadRealFileViaGaborator(
              fileId,
              filePath,
              pathState.filesBandsPerOctave[fileId] ?? pathState.bandsPerOctave,
              pathState.minFreq,
            );
            set(
              produce((draft: State) => {
                delete draft.filesLoading[fileId];
              }),
            );
            return;
          }
          const spectrogramData = await historyManager.loadSpectrogramAtCurrent();
          if (!spectrogramData) throw new Error("History tree is empty");
          openFiles[fileId] = { ...openFiles[fileId], spectrogramData };
          set(
            produce((draft: State) => {
              delete draft.filesLoading[fileId];
            }),
          );
        } catch (error) {
          delete openFiles[fileId];
          set(
            produce((draft: State) => {
              draft.openFileIds = draft.openFileIds.filter((id) => id !== fileId);
              draft.minimizedFileIds = draft.minimizedFileIds.filter((id) => id !== fileId);
              if (draft.activeFileId === fileId) draft.activeFileId = null;
              if (draft.fullscreenFileId === fileId) draft.fullscreenFileId = null;
              delete draft.persistedFilePaths[fileId];
              delete draft.fileDisplayNames[fileId];
              delete draft.filesLoading[fileId];
              delete draft.filesBandsPerOctave[fileId];
              delete draft.filesZoom[fileId];
              delete draft.filesOffset[fileId];
              delete draft.filesZoomY[fileId];
              delete draft.filesOffsetY[fileId];
              delete draft.filesPlaybackStartTime[fileId];
              delete draft.filesDirty[fileId];
            }),
          );
          const label = isManagedFilePath(filePath) ? "managed file" : truncateMiddle(host.path.basename(filePath), 50);
          notifications.show({
            title: "Failed to reopen file",
            message: `${label}: ${error instanceof Error ? error.message : ""}`,
            color: "red",
          });
        }
      }),
    );

    const after = get();
    if (after.activeFileId && openFiles[after.activeFileId]) {
      const file = openFiles[after.activeFileId];
      const transport = Tone.getTransport();
      const bpm = after.filepathsBpm[file.filePath];
      if (bpm) transport.bpm.value = bpm;
    }
  },
  filesPlaybackStartTime: {},
  setFilePlaybackStartTime: (fileId, time) =>
    set(
      produce((state: State) => {
        state.filesPlaybackStartTime[fileId] = time;
      }),
    ),
  filesDirty: {},
  setFileDirty: (fileId: string, dirty: boolean) => {
    set((state) => ({
      filesDirty: { ...state.filesDirty, [fileId]: dirty },
    }));
  },
  filesSynthesizing: {},
  setFileSynthesizing: (fileId: string, synthesizing: boolean) => {
    set((state) => ({
      filesSynthesizing: { ...state.filesSynthesizing, [fileId]: synthesizing },
    }));
  },
  filesLoading: {},
  setFileLoading: (fileId: string, message: string | undefined) => {
    set(
      produce((state: State) => {
        if (message === undefined) {
          delete state.filesLoading[fileId];
        } else {
          state.filesLoading[fileId] = message;
        }
      }),
    );
  },
  activeFileId: null,
  setActiveFileId: async (activeFileId) => {
    if (activeFileId && openFiles[activeFileId]) {
      const file = openFiles[activeFileId];
      const transport = Tone.getTransport();
      transport.bpm.value = get().filepathsBpm[file.filePath] ?? 120;

      if (file.audioBuffer) {
        transport.setLoopPoints(0, file.audioBuffer.duration);
      }

      get().stopAudio();
    }
    set({ activeFileId });
  },
  fullscreenFileId: null,
  setFullscreenFileId: (fileId) => set({ fullscreenFileId: fileId }),
  minimizedFileIds: [],
  setFileMinimized: (fileId, minimized) => {
    if (minimized) {
      const state = get();
      // Stop playback before minimizing
      if (state.isPlaying && state.activeFileId === fileId) {
        state.stopAudio();
      }
    }
    set(
      produce((state: State) => {
        if (minimized && !state.minimizedFileIds.includes(fileId)) {
          state.minimizedFileIds.push(fileId);
          if (state.activeFileId === fileId) {
            const lastVisible = [...state.openFileIds].reverse().find((id) => !state.minimizedFileIds.includes(id));
            state.activeFileId = lastVisible ?? null;
          }
        } else if (!minimized) {
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          state.activeFileId = fileId;
        }
      }),
    );
  },
  openFileMinimized: async (filePath) => {
    // Check if already open
    const existing = Object.values(openFiles).find((f) => f.filePath === filePath);
    if (existing) {
      // Only collapse if it wasn't already open in the normal (non-minimized) file list
      if (!get().minimizedFileIds.includes(existing.id)) return;
      get().setFileMinimized(existing.id, true);
      return;
    }

    const state = get();
    const fileId = generateFileId();
    const displayName = host.path.basename(filePath);

    // Add placeholder and immediately minimize — never appears as a full canvas
    openFiles[fileId] = { id: fileId, filePath, displayName };
    set(
      produce((state: State) => {
        state.openFileIds.push(fileId);
        state.minimizedFileIds.push(fileId);
        state.filepathsBpm[filePath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesZoomY[fileId] = 0;
        state.filesOffsetY[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
        state.persistedFilePaths[fileId] = filePath;
        state.fileDisplayNames[fileId] = displayName;
      }),
    );

    try {
      await loadRealFileViaGaborator(fileId, filePath, state.bandsPerOctave, state.minFreq);
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
        }),
      );
    } catch {
      delete openFiles[fileId];
      set(
        produce((state: State) => {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          delete state.filesLoading[fileId];
        }),
      );
    }
  },
  switchToNextFile: () => {
    const { openFileIds, activeFileId, setActiveFileId } = get();
    if (openFileIds.length <= 1 || !activeFileId) return;
    const currentIndex = openFileIds.indexOf(activeFileId);
    const nextIndex = (currentIndex + 1) % openFileIds.length;
    setActiveFileId(openFileIds[nextIndex]);
  },
  switchToPreviousFile: () => {
    const { openFileIds, activeFileId, setActiveFileId } = get();
    if (openFileIds.length <= 1 || !activeFileId) return;
    const currentIndex = openFileIds.indexOf(activeFileId);
    const prevIndex = (currentIndex - 1 + openFileIds.length) % openFileIds.length;
    setActiveFileId(openFileIds[prevIndex]);
  },
});
