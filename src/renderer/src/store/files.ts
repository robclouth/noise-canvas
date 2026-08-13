import { openConfirm, openNewFilePrompt, openReanalyzePrompt } from "../lib/modals";
import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { EffectItem } from "@renderer/effects/types";
import { FileParameterValue, getFileParameterKeys, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { host } from "../lib/host";
import { isBundledPath, resolveBundledPath } from "../lib/bundled-samples";
import type { AnalysisParams, CommitStrokeResult, PackedOnsets } from "../../../main/lib/types";
import { ONSET_REGION_PAD_SEC } from "../lib/constants";
import type { HostRender } from "../lib/host/types";
import { destroyHistoryManager, getHistoryManager } from "../lib/history-manager";
import { buildChildIndexPaths, chainFromRootTo, runHistoryExport } from "../lib/history-export";
import { disposeOnsetTexture, packOnsetState, spliceOnsets, unpackOnsetState } from "../lib/onset-map";
import { commitStrokeOf, commitWindowOf, type StrokeCommitSnapshot } from "../lib/stroke-commit";

/** The audio side of any synthesis, whichever pass produced it. */
interface SynthesisAudioResult {
  channels: Float32Array[];
  peak: number;
  gainReductionDb?: Float32Array;
  maxGainReductionDb?: number;
  onsets?: PackedOnsets;
  onsetOdfMax?: number;
  onsetBandMax?: Float32Array;
}
import type { Brush, OpenFile, ParameterKey, SpectrogramData, State, ZustandGet, ZustandSet } from "./types";
import type { StemGroupMethod } from "./stem-groups";
import { generateFileId, isManagedFilePath, makeManagedFilePath } from "./utils";

export interface FilesState {
  newFile: () => Promise<void>;
  openFileIds: string[];
  openFilePath: (filePath: string) => Promise<void>;
  duplicateFile: (fileId: string) => Promise<void>;
  hpssFile: (fileId: string) => Promise<void>;
  aiSeparateFile: (fileId: string) => Promise<void>;
  nmfFile: (fileId: string, numComponents: number) => Promise<void>;
  /** Sum the given files into a new one, leaving the originals open. */
  mergeStems: (fileIds: string[]) => Promise<void>;
  mergeStemGroup: (groupId: string) => Promise<void>;
  /** Close every member of a group, after one confirmation covering all of them. */
  closeStemGroup: (groupId: string) => Promise<void>;
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
  /**
   * Puts a synthesis result into a file: its audio buffer, peak, onsets and
   * limiting, and either starts the stroke's playback or swaps the buffer under
   * a running one.
   */
  applySynthesizedAudio: (
    fileId: string,
    result: SynthesisAudioResult,
    options?: {
      autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null;
      onsetStartSec?: number;
      onsetEndSec?: number;
    },
  ) => Promise<void>;
  /**
   * Derives everything a finished stroke means from one snapshot: the audio,
   * its hard edges, its limiting, its onsets and levels, and the coefficients
   * the audio analyses to. Applies the audio to the file and hands the caller
   * the result so it can write the coefficients to the canvas and to history.
   * Rejects whole — a commit that half happened would leave the three
   * disagreeing.
   */
  commitStroke: (
    fileId: string,
    snapshot: StrokeCommitSnapshot,
    data: Float32Array,
  ) => Promise<CommitStrokeResult | null>;
  loadCachedAudio: (fileId: string, audioPath: string, peak: number) => Promise<boolean>;
  restoreOnsetsForNode: (fileId: string, nodeId: string, packedData: Float32Array) => Promise<void>;
  exportHistory: () => Promise<void>;
  exportHistoryBranch: (nodeId: string) => Promise<void>;
  exportHistoryBranchToLive: (nodeId: string) => Promise<void>;
  exportHistoryFavorites: () => Promise<void>;
  mostRecentBpm: number | null;
  setMostRecentBpm: (bpm: number) => void;
  filepathsBpm: Record<string, number>;
  setFilepathBpm: (fileId: string, bpm: number) => void;
  // Onset sensitivity is a property of the material, like its tempo: how far
  // down its own level range the hits worth keeping sit.
  filepathsOnsetSensitivity: Record<string, number>;
  setFilepathOnsetSensitivity: (filepath: string, sensitivity: number) => void;
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
  const diskPath = isBundledPath(filePath) ? resolveBundledPath(filePath) : filePath;
  const result = await host.analysis.analyze(diskPath, { bandsPerOctave, minFreq });
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
    magnitudeEnergy: result.magnitudeEnergy,
    synthesisMetadata: {
      bandOffsets: result.bandOffsets,
      bandStepLog2s: result.bandStepLog2s,
      bandLengths: result.bandLengths,
    },
  };
  openFiles[fileId] = {
    ...openFiles[fileId],
    spectrogramData,
    onsets: result.onsets,
    onsetReference:
      result.onsetOdfMax !== undefined && result.onsetBandMax
        ? { odfMax: result.onsetOdfMax, bandMax: result.onsetBandMax }
        : undefined,
  };
}

// In-flight AI separation guard — blocks a second concurrent stem split on the same file.
const aiSeparatingFileIds = new Set<string>();

/** Stable 0-359 hue for a string, so the same path always reads the same colour. */
export function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

/** Get a consistent colour for a file based on a hash of its file path. */
export function getFileColor(filePath: string): string {
  return `hsl(${hashHue(filePath)}, 60%, 60%)`;
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

// ─── Stem splitting ──────────────────────────────────────────────────────────

// Derive a child spectrogram from the file it was split from: same grid, same
// metadata, new coefficients. The typed arrays are copied so editing the child
// never writes through to its source.
function deriveSpectrogramData(base: SpectrogramData, packedData: Float32Array): SpectrogramData {
  return {
    ...base,
    packedData,
    inverseMap: base.inverseMap.slice(),
    metadata: base.metadata.slice(),
    synthesisMetadata: {
      bandLengths: base.synthesisMetadata.bandLengths.slice(),
      bandOffsets: base.synthesisMetadata.bandOffsets.slice(),
      bandStepLog2s: base.synthesisMetadata.bandStepLog2s.slice(),
    },
  };
}

// The metadata shape the coefficient-domain addon entry points (hpss, nmf,
// mergeSpectrograms) expect.
function bandLayout(data: SpectrogramData) {
  return {
    numBands: data.numBands,
    numChannels: data.numChannels,
    bandOffsets: data.synthesisMetadata.bandOffsets,
    bandLengths: data.synthesisMetadata.bandLengths,
  };
}

// The current painted state of a file, falling back to its analysed
// coefficients when no renderer is mounted to read an FBO from.
async function readCurrentPackedData(file: OpenFile): Promise<Float32Array | undefined> {
  const fboData = await file.rendererRef?.current?.getFBOData();
  return fboData ?? file.spectrogramData?.packedData;
}

// Insert placeholder files for a pending split directly after their source so
// they appear with a spinner while the separator runs. The caller fills in each
// file's spectrogramData when it returns, or calls discardFiles on failure.
function createStemPlaceholders(
  set: ZustandSet,
  get: ZustandGet,
  sourceFileId: string,
  labels: string[],
  loadingMessage: string,
): string[] {
  const sourceFile = openFiles[sourceFileId];
  const baseLabel = stripExtensionForLabel(sourceFile.displayName);
  const ids = labels.map(() => generateFileId());
  const sourceBpm = get().filepathsBpm[sourceFile.filePath];

  for (let i = 0; i < ids.length; i++) {
    openFiles[ids[i]] = {
      id: ids[i],
      filePath: makeManagedFilePath(ids[i]),
      displayName: `${baseLabel} ${labels[i]}`,
    };
  }

  set(
    produce((state: State) => {
      const idx = state.openFileIds.indexOf(sourceFileId);
      state.openFileIds.splice(idx + 1, 0, ...ids);
      for (const id of ids) {
        state.filesBandsPerOctave[id] = state.filesBandsPerOctave[sourceFileId];
        state.filesZoom[id] = state.filesZoom[sourceFileId];
        state.filesOffset[id] = state.filesOffset[sourceFileId];
        state.filesZoomY[id] = state.filesZoomY[sourceFileId] ?? 0;
        state.filesOffsetY[id] = state.filesOffsetY[sourceFileId] ?? 0;
        state.filesPlaybackStartTime[id] = 0;
        state.filesDirty[id] = true;
        state.persistedFilePaths[id] = openFiles[id].filePath;
        state.fileDisplayNames[id] = openFiles[id].displayName;
        if (sourceBpm !== undefined) state.filepathsBpm[openFiles[id].filePath] = sourceBpm;
        state.filesLoading[id] = loadingMessage;
      }
    }),
  );

  return ids;
}

// Remove files created for an operation that then failed, along with every
// per-file map entry seeded for them.
function discardFiles(set: ZustandSet, ids: string[]): void {
  for (const id of ids) {
    delete openFiles[id];
    disposeOnsetTexture(id);
  }
  set(
    produce((state: State) => {
      state.openFileIds = state.openFileIds.filter((id) => !ids.includes(id));
      for (const id of ids) {
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
}

function clearLoading(set: ZustandSet, ids: string[]): void {
  set(
    produce((state: State) => {
      for (const id of ids) delete state.filesLoading[id];
    }),
  );
}

// Register a completed split so its parts stay visibly connected and can be
// summed back together. The hue comes from the source path, so a group reads as
// a shade of the file it came from.
function registerStemGroup(
  get: ZustandGet,
  method: StemGroupMethod,
  sourceFileId: string,
  memberIds: string[],
  label: string,
): void {
  const sourceFile = openFiles[sourceFileId];
  get().createStemGroup({
    method,
    label,
    originId: sourceFileId,
    memberIds,
    hue: hashHue(sourceFile?.filePath ?? sourceFileId),
  });
}

// Files whose view a change to `fileId` should also move: itself, plus the rest
// of its stem group while that group has view sync switched on.
function viewSyncTargets(state: State, fileId: string): string[] {
  const groupId = state.stemGroupOfFile[fileId];
  const group = groupId ? state.stemGroups[groupId] : undefined;
  if (!group?.syncView) return [fileId];
  return group.memberIds.includes(fileId) ? group.memberIds : [fileId, ...group.memberIds];
}

export const FILES_PERSISTED_KEYS = [
  "filepathsBpm",
  "filepathsOnsetSensitivity",
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
        magnitudeEnergy: result.magnitudeEnergy,
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
      disposeOnsetTexture(fileId);
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

    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const ids = createStemPlaceholders(
      set,
      get,
      fileId,
      ["harmonic", "percussive"],
      "Separating harmonic and percussive...",
    );

    try {
      const { harmonic, percussive } = await host.analysis.hpss(fboData, bandLayout(spectrogramData));

      openFiles[ids[0]] = { ...openFiles[ids[0]], spectrogramData: deriveSpectrogramData(spectrogramData, harmonic) };
      openFiles[ids[1]] = { ...openFiles[ids[1]], spectrogramData: deriveSpectrogramData(spectrogramData, percussive) };
    } catch (error) {
      console.error("HPSS separation failed:", error);
      notifications.show({
        title: "Separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, ids);
      return;
    }

    clearLoading(set, ids);
    registerStemGroup(get, "hpss", fileId, ids, `${baseLabel} — harmonic / percussive`);
  },
  nmfFile: async (fileId: string, numComponents: number) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;

    const fboData = await originalFile.rendererRef?.current?.getFBOData();
    if (!fboData) return;

    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    const parts = Math.max(2, Math.round(numComponents));
    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const labels = Array.from({ length: parts }, (_, i) => `part ${i + 1}`);
    const ids = createStemPlaceholders(set, get, fileId, labels, `Splitting into ${parts} parts...`);

    try {
      const result = await host.analysis.nmf(fboData, bandLayout(spectrogramData), parts);
      if (result.parts.length !== parts) {
        throw new Error(`Expected ${parts} parts, got ${result.parts.length}`);
      }
      for (let i = 0; i < ids.length; i++) {
        openFiles[ids[i]] = {
          ...openFiles[ids[i]],
          spectrogramData: deriveSpectrogramData(spectrogramData, result.parts[i]),
        };
      }
    } catch (error) {
      console.error("NMF separation failed:", error);
      notifications.show({
        title: "Separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, ids);
      return;
    }

    clearLoading(set, ids);
    registerStemGroup(get, "nmf", fileId, ids, `${baseLabel} — ${parts} parts`);
  },
  mergeStems: async (fileIds: string[]) => {
    if (fileIds.length < 2) return;
    const files = fileIds.map((id) => openFiles[id]);
    // Merging a subset of what was asked for would quietly drop energy, so a
    // part that hasn't finished loading blocks the whole thing.
    if (files.some((f) => !f?.spectrogramData)) {
      notifications.show({
        title: "Can't merge yet",
        message: "One of these files is still loading.",
        color: "yellow",
      });
      return;
    }

    const base = files[0].spectrogramData as SpectrogramData;
    // Summing only means anything while every part still describes the same
    // grid; a length- or resolution-changing edit on one of them breaks that.
    const mismatched = files.find((f) => {
      const data = f.spectrogramData as SpectrogramData;
      return (
        data.numBands !== base.numBands ||
        data.numChannels !== base.numChannels ||
        data.numFrames !== base.numFrames ||
        data.sampleRate !== base.sampleRate ||
        data.bandsPerOctave !== base.bandsPerOctave
      );
    });
    if (mismatched) {
      notifications.show({
        title: "Can't merge these files",
        message: `'${truncateMiddle(mismatched.displayName, 40)}' no longer lines up with the others — its length or resolution has changed.`,
        color: "red",
      });
      return;
    }

    const groupId = get().stemGroupOfFile[fileIds[0]];
    const group = groupId ? get().stemGroups[groupId] : undefined;
    const originFile = group ? openFiles[group.originId] : undefined;
    const displayName = `${stripExtensionForLabel(originFile?.displayName ?? files[0].displayName)} merged`;

    const newFileId = generateFileId();
    const newFilePath = makeManagedFilePath(newFileId);
    openFiles[newFileId] = { id: newFileId, filePath: newFilePath, displayName };

    const sourceId = files[0].id;
    const sourceBpm = get().filepathsBpm[files[0].filePath];

    set(
      produce((state: State) => {
        const lastIdx = fileIds.reduce((max, id) => Math.max(max, state.openFileIds.indexOf(id)), -1);
        state.openFileIds.splice(lastIdx + 1, 0, newFileId);
        state.filesBandsPerOctave[newFileId] = state.filesBandsPerOctave[sourceId];
        state.filesZoom[newFileId] = state.filesZoom[sourceId];
        state.filesOffset[newFileId] = state.filesOffset[sourceId];
        state.filesZoomY[newFileId] = state.filesZoomY[sourceId] ?? 0;
        state.filesOffsetY[newFileId] = state.filesOffsetY[sourceId] ?? 0;
        state.filesPlaybackStartTime[newFileId] = 0;
        state.filesDirty[newFileId] = true;
        state.persistedFilePaths[newFileId] = newFilePath;
        state.fileDisplayNames[newFileId] = displayName;
        if (sourceBpm !== undefined) state.filepathsBpm[newFilePath] = sourceBpm;
        state.filesLoading[newFileId] = "Merging...";
      }),
    );

    try {
      const packed = await Promise.all(files.map((f) => readCurrentPackedData(f)));
      const parts = packed.filter((p): p is Float32Array => Boolean(p));
      if (parts.length !== files.length) throw new Error("Could not read the current state of every file");

      const { merged } = await host.analysis.mergeSpectrograms(parts, bandLayout(base));

      openFiles[newFileId] = {
        ...openFiles[newFileId],
        spectrogramData: {
          ...deriveSpectrogramData(base, merged),
          // The parts each carry a slice of the original's energy, so none of
          // their totals describes the sum. Take the figure the split came
          // from when it's still around; the Convolve effect normalises its
          // impulse response against it.
          magnitudeEnergy: originFile?.spectrogramData?.magnitudeEnergy ?? base.magnitudeEnergy,
        },
      };
    } catch (error) {
      console.error("Merge failed:", error);
      notifications.show({
        title: "Merge failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, [newFileId]);
      return;
    }

    clearLoading(set, [newFileId]);
    await get().setActiveFileId(newFileId);
  },
  mergeStemGroup: async (groupId: string) => {
    const group = get().stemGroups[groupId];
    if (!group) return;
    await get().mergeStems(group.memberIds);
  },
  closeStemGroup: async (groupId: string) => {
    const group = get().stemGroups[groupId];
    if (!group) return;
    // Closing a member dissolves the group once it drops below two, so the list
    // is snapshotted before anything is removed.
    const memberIds = [...group.memberIds];
    const unsaved = memberIds.filter((id) => get().filesDirty[id]).length;
    const confirmed = await new Promise<boolean>((resolve) => {
      openConfirm({
        title: "Close all parts",
        message:
          unsaved > 0
            ? `Close all ${memberIds.length} parts of this split? ${unsaved === 1 ? "One has" : `${unsaved} have`} unsaved changes.`
            : `Close all ${memberIds.length} parts of this split?`,
        confirmLabel: "Close All",
        danger: true,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onClose: () => resolve(false),
      });
    });
    if (!confirmed) return;
    for (const id of memberIds) get().closeFile(id);
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

    const stemNames = ["drums", "bass", "other", "vocals"];
    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const stemIds = createStemPlaceholders(set, get, fileId, stemNames, "Separating stems (AI)…");

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
        false, // don't limit — preserve relative levels for separation
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
            // From analysisParams, not the current global setting — a stem has
            // to record the resolution it was actually analysed at, or it stops
            // lining up with the file it was split from.
            minFreq: analysisParams.minFreq,
            bandsPerOctave: analysisParams.bandsPerOctave,
            magnitudeEnergy: result.magnitudeEnergy,
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
      discardFiles(set, stemIds);
      aiSeparatingFileIds.delete(fileId);
      return;
    }

    clearLoading(set, stemIds);
    registerStemGroup(get, "ai", fileId, stemIds, `${baseLabel} — drums / bass / other / vocals`);
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
            // Copy the audio channels out of the AudioBuffer at their final level.
            const numChannels = file.audioBuffer!.numberOfChannels;
            const audioChannels: Float32Array[] = [];
            for (let i = 0; i < numChannels; i++) {
              audioChannels.push(new Float32Array(file.audioBuffer!.getChannelData(i)));
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
      // Copy the audio channels out of the AudioBuffer at their final level.
      const numChannels = file.audioBuffer.numberOfChannels;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        audioChannels.push(new Float32Array(file.audioBuffer.getChannelData(i)));
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
      // Copy the audio channels out of the AudioBuffer at their final level.
      const numChannels = file.audioBuffer.numberOfChannels;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        audioChannels.push(new Float32Array(file.audioBuffer.getChannelData(i)));
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

    state.removeFileFromStemGroup(fileId);

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
          disposeOnsetTexture(fileId);

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

    const { activeFileId, setFileSynthesizing } = get();
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

      const analysisParams: AnalysisParams = {
        bandsPerOctave: originalAnalysis.bandsPerOctave,
        minFreq: originalAnalysis.minFreq,
      };

      const processedDataArray = new Float32Array(
        payload.processedData,
        0,
        payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      // Check for dirty region to enable partial synthesis optimization
      const dirtyRegion = renderer.getDirtyRegion();

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

      // Only the span the stroke touched needs its onsets found again, which on
      // a long file is the difference between a few milliseconds and walking
      // every coefficient in it. Padded either side, because an event is
      // anchored at the foot of its attack and measured for a moment after it,
      // so the ones at the edges are read from a little more material than the
      // span itself. Needs the reference from a pass that read the whole file;
      // without one this stays a whole-file pass, which then produces it.
      const onsetReference = file.onsetReference;
      if (onsetReference && startFrame !== undefined && endFrame !== undefined) {
        const sampleRate = originalAnalysis.sampleRate;
        analysisParams.detectOnsets = true;
        analysisParams.onsetStartSec = Math.max(0, startFrame / sampleRate - ONSET_REGION_PAD_SEC);
        analysisParams.onsetEndSec = Math.min(
          originalAnalysis.numFrames / sampleRate,
          endFrame / sampleRate + ONSET_REGION_PAD_SEC,
        );
        analysisParams.onsetOdfReference = onsetReference.odfMax;
        analysisParams.onsetBandMax = onsetReference.bandMax;
      } else if (!file.onsets || !onsetReference) {
        // Nothing to work from yet, so this pass reads the whole file and
        // produces the reference the ones after it go on. A synthesis that
        // changed nothing — arriving at a history state, say — leaves the
        // onsets it already has alone.
        analysisParams.detectOnsets = true;
      }

      let synthesisResult;
      const cppSynthStart = performance.now();
      try {
        // The native call references the packed buffer and existing audio in
        // place rather than copying them, so the synchronous part before the
        // promise is returned is near-zero; the FFT runs off-thread. Timing the
        // gap before the await isolates any remaining main-thread marshaling.
        const synthPromise = host.analysis.synthesize(
          processedDataArray,
          payload.analysisMetadata,
          originalAnalysis.sampleRate,
          analysisParams,
          get().limiterEnabled,
          existingAudio,
          startFrame,
          endFrame,
          startBand,
          endBand,
        );
        console.log(
          `[timing] synthesize marshaling (MAIN THREAD, sync) ${(performance.now() - cppSynthStart).toFixed(1)}ms`,
        );
        synthesisResult = await synthPromise;
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

      await get().applySynthesizedAudio(fileId, synthesisResult, {
        autoPlaybackParams,
        onsetStartSec: analysisParams.onsetStartSec,
        onsetEndSec: analysisParams.onsetEndSec,
      });
      console.log(`[timing] synthesizeFile total: ${(performance.now() - synthesizeFileStart).toFixed(2)}ms`);
    } catch (error) {
      console.error("Error running synthesis:", error);
    } finally {
      setFileSynthesizing(fileId, false);
    }
  },
  applySynthesizedAudio: async (fileId, result, options = {}) => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData || !result.channels.length) return;

    const audioBufferStart = performance.now();
    const numChannels = result.channels.length;
    const numFrames = result.channels[0].length;
    const audioContext = Tone.getContext().rawContext;
    const audioBuffer = audioContext.createBuffer(numChannels, numFrames, file.spectrogramData.sampleRate);
    for (let i = 0; i < numChannels; i++) {
      audioBuffer.copyToChannel(result.channels[i] as Float32Array<ArrayBuffer>, i);
    }
    console.log(`[timing] create AudioBuffer: ${(performance.now() - audioBufferStart).toFixed(2)}ms`);

    file.audioBuffer = audioBuffer;
    file.audioPeak = result.peak > 0 ? result.peak : 1;
    file.gainReductionDb = result.gainReductionDb;
    file.maxGainReductionDb = result.maxGainReductionDb;
    if (result.onsets) {
      const { onsetStartSec, onsetEndSec } = options;
      file.onsets =
        onsetStartSec !== undefined && onsetEndSec !== undefined
          ? spliceOnsets(file.onsets, result.onsets, onsetStartSec, onsetEndSec)
          : result.onsets;
      if (result.onsetOdfMax !== undefined && result.onsetBandMax) {
        file.onsetReference = { odfMax: result.onsetOdfMax, bandMax: result.onsetBandMax };
      }
    }
    if (get().activeFileId === fileId) {
      get().setGainReduction(result.gainReductionDb ?? null, result.maxGainReductionDb ?? 0);
    }

    const { autoPlaybackParams } = options;
    if (autoPlaybackParams) {
      const autoPlayStart = performance.now();
      const { startTimeSeconds, endTimeSeconds } = autoPlaybackParams;
      if (get().isPlaying) await get().togglePlayback();
      get().setLoopRegion({ start: startTimeSeconds, end: endTimeSeconds });
      get().setFilePlaybackStartTime(fileId, startTimeSeconds);
      await get().togglePlayback();
      console.log(`[timing] auto-playback setup: ${(performance.now() - autoPlayStart).toFixed(2)}ms`);
    } else if (get().isPlaying && get().activeFileId === fileId) {
      // Swap the buffer under the player and restart it from where it was, so
      // the edit is heard without the transport moving.
      const bufferSwapStart = performance.now();
      const player = get().getPlayer();
      const t = get().getPlaybackTime();
      player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
      player.volume.value = 0;
      get().setPlaybackTime(t);
      console.log(`[timing] buffer hot-swap: ${(performance.now() - bufferSwapStart).toFixed(2)}ms`);
    }
  },
  commitStroke: async (fileId, snapshot, data) => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return null;

    const spec = file.spectrogramData;
    const window = commitWindowOf(snapshot);
    const stroke = commitStrokeOf(snapshot, snapshot.limiterEnabled);

    const params: AnalysisParams = { bandsPerOctave: spec.bandsPerOctave, minFreq: spec.minFreq };
    // Only the span the stroke touched needs its onsets found again, padded
    // either side because an event is anchored at the foot of its attack and
    // measured for a moment after it. Without a reference from a whole-file
    // pass this reads everything, and produces one.
    const onsetReference = file.onsetReference;
    if (onsetReference && window) {
      params.detectOnsets = true;
      params.onsetStartSec = Math.max(0, window.startFrame / spec.sampleRate - ONSET_REGION_PAD_SEC);
      params.onsetEndSec = Math.min(
        spec.numFrames / spec.sampleRate,
        window.endFrame / spec.sampleRate + ONSET_REGION_PAD_SEC,
      );
      params.onsetOdfReference = onsetReference.odfMax;
      params.onsetBandMax = onsetReference.bandMax;
    } else if (!file.onsets || !onsetReference) {
      params.detectOnsets = true;
    }

    // Without a window, or without audio to splice into, the commit rebuilds
    // the whole file — which is what the addon does when either is missing.
    const existingBuffer = file.audioBuffer;
    const existingAudio: Float32Array[] = [];
    if (window && existingBuffer) {
      for (let i = 0; i < existingBuffer.numberOfChannels; i++) existingAudio.push(existingBuffer.getChannelData(i));
    }

    get().setFileSynthesizing(fileId, true);
    try {
      const commitStart = performance.now();
      const result = await host.analysis.commitStroke(
        data,
        {
          numFrames: spec.numFrames,
          numChannels: spec.numChannels,
          numBands: spec.numBands,
          bandOffsets: spec.synthesisMetadata.bandOffsets,
          bandStepLog2s: spec.synthesisMetadata.bandStepLog2s,
          bandLengths: spec.synthesisMetadata.bandLengths,
        },
        spec.sampleRate,
        params,
        existingAudio,
        window ?? { startFrame: -1, endFrame: -1, startBand: -1, endBand: -1 },
        stroke,
      );
      console.log(
        `[timing] commitStroke: ${(performance.now() - commitStart).toFixed(2)}ms ` +
          `(${result.patch.ranges.length / 3} band ranges)`,
      );

      await get().applySynthesizedAudio(fileId, result, {
        autoPlaybackParams: snapshot.autoPlaybackParams,
        onsetStartSec: params.onsetStartSec,
        onsetEndSec: params.onsetEndSec,
      });
      return result;
    } finally {
      get().setFileSynthesizing(fileId, false);
    }
  },
  /**
   * Put a file's onsets back to the ones belonging to a history node — after an
   * undo, or on reopening. Stored with the node where possible; a node from
   * before they were stored, or one whose file has gone, is detected once and
   * then stored, so a history heals as it is used.
   */
  restoreOnsetsForNode: async (fileId: string, nodeId: string, packedData: Float32Array): Promise<void> => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return;
    const historyManager = getHistoryManager(fileId);

    try {
      const stored = await historyManager.getNodeOnsets(nodeId);
      const state = stored ? unpackOnsetState(stored) : null;
      if (state) {
        file.onsets = state.onsets;
        file.onsetReference = state.reference;
        return;
      }

      const spectrogramData = file.spectrogramData;
      const result = await host.analysis.detectOnsets(
        packedData,
        {
          numBands: spectrogramData.numBands,
          numChannels: spectrogramData.numChannels,
          numFrames: spectrogramData.numFrames,
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
          bandLengths: spectrogramData.synthesisMetadata.bandLengths,
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s,
        },
        spectrogramData.sampleRate,
      );
      file.onsets = result.onsets;
      file.onsetReference = { odfMax: result.odfMax, bandMax: result.bandMax };
      await historyManager.setNodeOnsets(
        nodeId,
        packOnsetState({ onsets: result.onsets, reference: file.onsetReference }),
      );
    } catch (error) {
      // Losing the onsets costs the markers and the onset grid, not the file.
      console.error("Onsets for history node failed:", error);
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
      // Cached audio carries no gain-reduction envelope; the meter clears until
      // the next synthesis re-derives it.
      file.gainReductionDb = undefined;
      file.maxGainReductionDb = undefined;
      if (get().activeFileId === fileId) get().setGainReduction(null, 0);

      // Hot-swap if currently playing this file
      if (get().isPlaying && get().activeFileId === fileId) {
        const player = getPlayer();
        const t = get().getPlaybackTime();
        player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
        player.volume.value = 0;
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
            magnitudeEnergy: result.magnitudeEnergy,
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
        magnitudeEnergy: result.magnitudeEnergy,
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
  filepathsOnsetSensitivity: {},
  setFilepathOnsetSensitivity: (filepath, sensitivity) =>
    set(
      produce((state: State) => {
        state.filepathsOnsetSensitivity[filepath] = sensitivity;
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
        for (const id of viewSyncTargets(state, fileId)) state.filesZoom[id] = zoom;
      }),
    ),
  filesOffset: {},
  setFileOffset: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesOffset[id] = offset;
      }),
    ),
  filesZoomY: {},
  setFileZoomY: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesZoomY[id] = zoom;
      }),
    ),
  filesOffsetY: {},
  setFileOffsetY: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesOffsetY[id] = offset;
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
          // Restored from the node the file reopens on, before the loading flag
          // clears, so its first paint already has them.
          const currentId = historyManager.getManifest()?.currentId;
          if (currentId) {
            await get().restoreOnsetsForNode(fileId, currentId, spectrogramData.packedData);
          }
          set(
            produce((draft: State) => {
              delete draft.filesLoading[fileId];
            }),
          );
        } catch (error) {
          delete openFiles[fileId];
          disposeOnsetTexture(fileId);
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
      get().setGainReduction(file.gainReductionDb ?? null, file.maxGainReductionDb ?? 0);
    } else {
      get().setGainReduction(null, 0);
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
      disposeOnsetTexture(fileId);
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
