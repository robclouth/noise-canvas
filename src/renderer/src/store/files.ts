import { openConfirm, openContextModal } from "../lib/modals";
import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { EffectItem } from "@renderer/effects/types";
import { FileParameterValue, getFileParameterKeys, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { destroyUndoManager, getUndoManager } from "../lib/undo-manager";
import type { Brush, OpenFile, ParameterKey, State, ZustandGet, ZustandSet } from "./types";
import { generateFileId } from "./utils";

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
  exportUndoHistory: () => Promise<void>;
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
  // Maps persistable (non-virtual) fileId → filePath. Serialised so the open-file list
  // survives app restart; virtual files (new/duplicate/stems) are deliberately excluded.
  persistedFilePaths: Record<string, string>;
  reopenPersistedFiles: () => Promise<void>;
  recentFilePaths: string[];
  addRecentFilePath: (filePath: string) => void;
  clearRecentFilePaths: () => void;
  getUnsavedFiles: () => Array<{ fileId: string; filePath: string; fileName: string }>;
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

// Derives a Finder-style "copy" filename:
//   foo.wav         → foo copy.wav
//   foo copy.wav    → foo copy 2.wav
//   foo copy 3.wav  → foo copy 4.wav
function makeCopyPath(filePath: string): string {
  const ext = window.nodePath.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  const match = base.match(/^(.*) copy(?: (\d+))?$/);
  if (match) {
    const n = match[2] ? parseInt(match[2], 10) + 1 : 2;
    return `${match[1]} copy ${n}${ext}`;
  }
  return `${base} copy${ext}`;
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
] as const;

export const createFilesSlice = (set: ZustandSet, get: ZustandGet): FilesState => ({
  newFile: async () => {
    const { sampleRate, bpm, lengthBeats } = await new Promise<{
      sampleRate: number;
      bpm: number;
      lengthBeats: number;
    }>((resolve) => {
      openContextModal({
        modal: "newFile",
        title: "New File",
        innerProps: {
          resolve,
        },
      });
    });

    const state = get();

    try {
      const lengthSeconds = (60 / bpm) * lengthBeats;
      const audioBuffer = new AudioBuffer({
        length: lengthSeconds * sampleRate,
        sampleRate,
        numberOfChannels: 2,
      });
      const result = await window.audioAnalysis.analyseBuffer(audioBuffer, {
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

      const tempPath = await window.nodeFs.mkdtemp(window.nodePath.join(window.nodeOs.tmpdir(), "noise-canvas-files-"));
      const filepath = window.nodePath.join(tempPath, `${Date.now()}.wav`);

      const fileId = generateFileId();
      openFiles[fileId] = {
        id: fileId,

        filePath: filepath,
        spectrogramData,
        isVirtual: true,
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

    // Add a placeholder immediately so the file appears in the UI with a loading state
    openFiles[fileId] = { id: fileId, filePath: filepath, isVirtual: false };
    set(
      produce((state: State) => {
        state.openFileIds.push(fileId);
        state.filepathsBpm[filepath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesZoomY[fileId] = 0;
        state.filesOffsetY[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
        state.persistedFilePaths[fileId] = filepath;
      }),
    );

    try {
      const result = await window.audioAnalysis.analyze(filepath, {
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

      openFiles[fileId] = { ...openFiles[fileId], spectrogramData };

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
        }),
      );
      console.error("Error opening file:", error);
      notifications.show({
        title: `Failed to open file`,
        message: `Opening '${truncateMiddle(window.nodePath.basename(filepath), 50)}' failed. ${error instanceof Error ? error.message : ""}`,
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
    const newFilePath = makeCopyPath(originalFile.filePath);

    const newFile: OpenFile = {
      id: newFileId,
      filePath: newFilePath,
      isVirtual: true,
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

    const ext = window.nodePath.extname(originalFile.filePath);
    const base = originalFile.filePath.slice(0, originalFile.filePath.length - ext.length);

    const harmonicId = generateFileId();
    const percussiveId = generateFileId();

    // Add placeholder files immediately so they appear in the UI with a loading state
    openFiles[harmonicId] = { id: harmonicId, filePath: `${base}_harmonic${ext}`, isVirtual: true };
    openFiles[percussiveId] = { id: percussiveId, filePath: `${base}_percussive${ext}`, isVirtual: true };

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
          state.filepathsBpm[newPath] = sourceBpm;
          state.filesLoading[id] = "Separating harmonic and percussive...";
        }
      }),
    );

    try {
      const { harmonic, percussive } = await window.audioAnalysis.hpss(fboData, {
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
    if (!window.audioAnalysis.isModelDownloaded(modelFile)) {
      notifications.show({
        id: "ai-model-download",
        title: "Downloading AI model",
        message: "Starting download…",
        color: "blue",
        loading: true,
        autoClose: false,
      });
      try {
        await window.audioAnalysis.downloadModel(modelFile, (downloaded, total) => {
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

    const ext = window.nodePath.extname(originalFile.filePath);
    const base = originalFile.filePath.slice(0, originalFile.filePath.length - ext.length);
    const sourceBpm = state.filepathsBpm[originalFile.filePath];

    for (let i = 0; i < stemNames.length; i++) {
      openFiles[stemIds[i]] = { id: stemIds[i], filePath: `${base}_${stemNames[i]}${ext}`, isVirtual: true };
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

      const synthesisResult = await window.audioAnalysis.synthesize(
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
        { bandsPerOctave: state.bandsPerOctave, minFreq: state.minFreq },
        false, // don't normalize — preserve relative levels for separation
      );

      // Step 2: AI-separate the synthesized audio into stems
      const stems = await window.audioAnalysis.aiSeparate(synthesisResult.channels, spectrogramData.sampleRate);

      // Step 3: Re-analyse each stem with Gaborator → SpectrogramData → new file entry
      const analysisParams = { bandsPerOctave: state.bandsPerOctave, minFreq: state.minFreq };
      audioContext = new AudioContext({ sampleRate: spectrogramData.sampleRate });

      for (let i = 0; i < stemNames.length; i++) {
        const stemChannels = stems[stemNames[i]];
        if (!stemChannels) continue;

        const numSamples = stemChannels[0].length;
        const audioBuffer = audioContext.createBuffer(stemChannels.length, numSamples, spectrogramData.sampleRate);
        for (let ch = 0; ch < stemChannels.length; ch++) {
          audioBuffer.copyToChannel(new Float32Array(stemChannels[ch]), ch);
        }

        const result = await window.audioAnalysis.analyseBuffer(audioBuffer, analysisParams);

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

    const filePath = file.filePath;
    const fileName = window.nodePath.basename(filePath);

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
            const ext = window.nodePath.extname(filePath).slice(1).toLowerCase();
            const format = ext || "wav";

            // Export the audio
            await window.audioAnalysis.exportAudio(audioChannels, filePath, file.audioBuffer!.sampleRate, format);

            // Mark as not dirty
            get().setFileDirty(state.activeFileId!, false);
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
    const currentFileName = window.nodePath.basename(currentFilePath);
    const currentDir = window.nodePath.dirname(currentFilePath);

    // Show save dialog (we'll need to add this to IPC)
    const result = await window.ipcRenderer.invoke("show-save-dialog", {
      defaultPath: window.nodePath.join(currentDir, currentFileName),
      filters: [
        { name: "Audio Files", extensions: ["wav", "flac", "mp3"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) return;

    const outputPath = result.filePath;
    const savedFileName = window.nodePath.basename(outputPath);
    const truncatedFileName = truncateMiddle(savedFileName, 50);

    try {
      // Extract audio channels from AudioBuffer
      const numChannels = file.audioBuffer.numberOfChannels;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        audioChannels.push(file.audioBuffer.getChannelData(i));
      }

      // Determine format from file extension
      const ext = window.nodePath.extname(outputPath).slice(1).toLowerCase();
      const format = ext || "wav";

      // Export the audio
      await window.audioAnalysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.isVirtual = false;
      set(
        produce((state: State) => {
          const oldBpm = state.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            state.filepathsBpm[outputPath] = oldBpm;
          }
          state.persistedFilePaths[state.activeFileId!] = outputPath;
        }),
      );

      // Mark as not dirty
      get().setFileDirty(state.activeFileId!, false);
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

    const currentFilePath = file.filePath;
    const dir = window.nodePath.dirname(currentFilePath);
    const ext = window.nodePath.extname(currentFilePath);
    const baseName = window.nodePath.basename(currentFilePath, ext);

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

    const outputPath = window.nodePath.join(dir, newFileName);
    const truncatedFileName = truncateMiddle(newFileName, 50);

    try {
      // Extract audio channels from AudioBuffer
      const numChannels = file.audioBuffer.numberOfChannels;
      const audioChannels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        audioChannels.push(file.audioBuffer.getChannelData(i));
      }

      // Determine format from file extension
      const format = ext.slice(1).toLowerCase() || "wav";

      // Export the audio
      await window.audioAnalysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.isVirtual = false;
      set(
        produce((state: State) => {
          const oldBpm = state.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            state.filepathsBpm[outputPath] = oldBpm;
          }
          state.persistedFilePaths[state.activeFileId!] = outputPath;
        }),
      );

      // Mark as not dirty
      get().setFileDirty(state.activeFileId!, false);
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

    // Fire-and-forget: drops FBO snapshots and the per-file temp directory.
    destroyUndoManager(fileId).catch((err) => console.error("destroyUndoManager failed", err));

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

    const { activeFileId, bandsPerOctave, minFreq, getPlayer, setFileSynthesizing } = get();
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
        bandsPerOctave: bandsPerOctave,
        minFreq: minFreq,
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
        synthesisResult = await window.audioAnalysis.synthesize(
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

      // Mark file as dirty if it's not the first synthesis, or if the file has no on-disk
      // backing (virtual files are always considered unsaved until exported).
      get().setFileDirty(fileId, file.isVirtual === true || file.audioBuffer !== undefined);

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
      const channels = await window.audioAnalysis.decodeAudio(audioPath, sampleRate, numChannels);
      if (!channels.length || !channels[0].length) return false;

      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(numChannels, channels[0].length, sampleRate);
      for (let i = 0; i < numChannels; i++) {
        audioBuffer.copyToChannel(channels[i] as Float32Array<ArrayBuffer>, i);
      }

      const hadPreviousBuffer = file.audioBuffer !== undefined;
      file.audioBuffer = audioBuffer;
      file.audioPeak = peak > 0 ? peak : 1;

      get().setFileDirty(fileId, file.isVirtual === true || hadPreviousBuffer);

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
  exportUndoHistory: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file) return;

    const { getUndoManager } = await import("../lib/undo-manager");
    const undoManager = getUndoManager(state.activeFileId);
    const audioPaths = undoManager.getCachedAudioPaths();

    if (audioPaths.length === 0) {
      notifications.show({
        title: "Nothing to export",
        message: "No cached audio is available in the undo history yet.",
        color: "yellow",
      });
      return;
    }

    const baseName = window.nodePath.basename(file.filePath, window.nodePath.extname(file.filePath));
    const defaultDir = window.nodePath.dirname(file.filePath);

    const result = await window.ipcRenderer.invoke("show-directory-dialog", {
      title: "Export Undo History",
      defaultPath: defaultDir,
      buttonLabel: "Export Here",
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputDir = result.filePaths[0];

    const pad = Math.max(2, String(audioPaths.length).length);
    let exportedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < audioPaths.length; i++) {
      const index = String(i + 1).padStart(pad, "0");
      const destPath = window.nodePath.join(outputDir, `${baseName}_history_${index}.wav`);
      try {
        await window.audioAnalysis.copyAudioFile(audioPaths[i], destPath);
        exportedCount++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (errors.length > 0) {
      notifications.show({
        title: "Export partially failed",
        message: `Exported ${exportedCount} of ${audioPaths.length} files. First error: ${errors[0]}`,
        color: "red",
      });
    } else {
      notifications.show({
        title: "Undo history exported",
        message: `Exported ${exportedCount} audio file${exportedCount === 1 ? "" : "s"} to ${truncateMiddle(outputDir, 50)}`,
      });
    }
  },
  reanalyzeActiveFile: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];

    openConfirm({
      title: "Re-analyze File",
      message: `This will re-analyze the file with the new settings. You will lose the undo history.`,
      confirmLabel: "Re-analyze",
      danger: true,
      onConfirm: async () => {
        if (!state.activeFileId) return;
        const audioBuffer = file?.audioBuffer;

        try {
          const result = audioBuffer
            ? await window.audioAnalysis.analyseBuffer(audioBuffer, {
                bandsPerOctave: state.bandsPerOctave,
                minFreq: state.minFreq,
              })
            : await window.audioAnalysis.analyze(file.filePath, {
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
          };

          file.spectrogramData = spectrogramData;

          file.rendererRef?.current?.reloadTextures();

          const undoManager = getUndoManager(state.activeFileId);
          undoManager.clear();

          return set(
            produce((state: State) => {
              state.filesBandsPerOctave[state.activeFileId!] = state.bandsPerOctave;
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
    const analysisParams = { bandsPerOctave: state.bandsPerOctave, minFreq: state.minFreq };

    try {
      const fboData = await file.rendererRef.current.getFBOData();
      if (!fboData) throw new Error("Could not read the current spectrogram state.");

      const synthResult = await window.audioAnalysis.synthesize(
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

      const result = await window.audioAnalysis.analyseBuffer(audioBuffer, analysisParams);

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
        minFreq: state.minFreq,
        bandsPerOctave: state.bandsPerOctave,
        synthesisMetadata: {
          bandOffsets: result.bandOffsets,
          bandStepLog2s: result.bandStepLog2s,
          bandLengths: result.bandLengths,
        },
      };
      file.audioBuffer = audioBuffer;
      file.audioPeak = synthResult.peak > 0 ? synthResult.peak : 1;

      file.rendererRef.current.reloadTextures();
      getUndoManager(fileId).clear();

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

    for (const [fileId, filePath] of entries) {
      openFiles[fileId] ??= { id: fileId, filePath };
    }
    set(
      produce((draft: State) => {
        for (const [fileId] of entries) {
          draft.filesLoading[fileId] = "Analysing audio...";
        }
      }),
    );

    await Promise.all(
      entries.map(async ([fileId, filePath]) => {
        try {
          const pathState = get();
          const result = await window.audioAnalysis.analyze(filePath, {
            bandsPerOctave: pathState.filesBandsPerOctave[fileId] ?? pathState.bandsPerOctave,
            minFreq: pathState.minFreq,
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
            minFreq: pathState.minFreq,
            bandsPerOctave: pathState.filesBandsPerOctave[fileId] ?? pathState.bandsPerOctave,
            synthesisMetadata: {
              bandOffsets: result.bandOffsets,
              bandStepLog2s: result.bandStepLog2s,
              bandLengths: result.bandLengths,
            },
          };
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
              delete draft.filesLoading[fileId];
              delete draft.filesBandsPerOctave[fileId];
              delete draft.filesZoom[fileId];
              delete draft.filesOffset[fileId];
              delete draft.filesZoomY[fileId];
              delete draft.filesOffsetY[fileId];
              delete draft.filesPlaybackStartTime[fileId];
            }),
          );
          notifications.show({
            title: "Failed to reopen file",
            message: `${truncateMiddle(window.nodePath.basename(filePath), 50)}: ${error instanceof Error ? error.message : ""}`,
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
  getUnsavedFiles: () => {
    const state = get();
    return state.openFileIds
      .filter((id) => state.filesDirty[id])
      .map((id) => {
        const file = openFiles[id];
        const filePath = file?.filePath ?? "";
        return {
          fileId: id,
          filePath,
          fileName: filePath ? window.nodePath.basename(filePath) : id,
        };
      });
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

    // Add placeholder and immediately minimize — never appears as a full canvas
    openFiles[fileId] = { id: fileId, filePath, isVirtual: false };
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
      }),
    );

    try {
      const result = await window.audioAnalysis.analyze(filePath, {
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

      openFiles[fileId] = { ...openFiles[fileId], spectrogramData };
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
