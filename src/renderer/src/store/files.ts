import { modals, openContextModal } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { getUndoManager } from "../lib/undo-manager";
import type { OpenFile, State, ZustandGet, ZustandSet } from "./types";
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
  synthesizeFile: (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
    prefetchedFboData?: Float32Array,
  ) => Promise<void>;
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
  sourceFile: string | null;
  setSourceFile: (sourceFile: string | null) => void;
  fullscreenFileId: string | null;
  setFullscreenFileId: (fileId: string | null) => void;
  switchToNextFile: () => void;
  switchToPreviousFile: () => void;
}

// Open files keyed by file ID
export const openFiles: Record<string, OpenFile> = {};

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

export const FILES_PERSISTED_KEYS = ["filepathsBpm"] as const;

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
      };

      return set(
        produce((state: State) => {
          state.openFileIds.push(fileId);
          state.filepathsBpm[filepath] = bpm;
          state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
          state.filesZoom[fileId] = 0;
          state.filesOffset[fileId] = 0;
          state.filesPlaybackStartTime[fileId] = 0;
          state.filesDirty[fileId] = true;

          if (!state.sourceFile) state.sourceFile = fileId;
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
    const fileId = generateFileId();

    // Add a placeholder immediately so the file appears in the UI with a loading state
    openFiles[fileId] = { id: fileId, filePath: filepath };
    set(
      produce((state: State) => {
        state.openFileIds.push(fileId);
        state.filepathsBpm[filepath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
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
          state.sourceFile = fileId;
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
          delete state.filesPlaybackStartTime[fileId];
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
    if (!originalFile) return;

    const fboData = await originalFile.rendererRef?.current?.getFBOData();
    if (!fboData) {
      console.error("Failed to duplicate file: could not get FBO data");
      return;
    }

    const newFileId = generateFileId();

    const newFile: OpenFile = {
      id: newFileId,
      filePath: originalFile.filePath,
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

    set(
      produce((state: State) => {
        state.openFileIds.push(newFileId);
        state.activeFileId = newFileId;
        state.filesBandsPerOctave[newFileId] = state.filesBandsPerOctave[fileId];
        state.filesZoom[newFileId] = state.filesZoom[fileId];
        state.filesOffset[newFileId] = state.filesOffset[fileId];
        state.filesPlaybackStartTime[newFileId] = state.filesPlaybackStartTime[fileId];
        state.filesDirty[newFileId] = false;
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
    openFiles[harmonicId] = { id: harmonicId, filePath: `${base}_harmonic${ext}` };
    openFiles[percussiveId] = { id: percussiveId, filePath: `${base}_percussive${ext}` };

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
      openFiles[stemIds[i]] = { id: stemIds[i], filePath: `${base}_${stemNames[i]}${ext}` };
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
          state.filesPlaybackStartTime[id] = 0;
          state.filesDirty[id] = true;
          state.filepathsBpm[openFiles[id].filePath] = sourceBpm;
          state.filesLoading[id] = "Separating stems (AI)…";
        }
      }),
    );

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
      const stems = await window.audioAnalysis.aiSeparate(
        synthesisResult.channels,
        spectrogramData.sampleRate,
      );

      // Step 3: Re-analyse each stem with Gaborator → SpectrogramData → new file entry
      const analysisParams = { bandsPerOctave: state.bandsPerOctave, minFreq: state.minFreq };
      const audioContext = new AudioContext({ sampleRate: spectrogramData.sampleRate });

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
            inverseMap: new Float32Array(result.inverseMap.buffer, result.inverseMap.byteOffset, result.inverseMap.byteLength / 4),
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
          },
        };
      }

      audioContext.close();
    } catch (error) {
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
            delete state.filesPlaybackStartTime[id];
            delete state.filesDirty[id];
            delete state.filesLoading[id];
          }
        }),
      );
      return;
    }

    set(
      produce((state: State) => {
        for (const id of stemIds) delete state.filesLoading[id];
      }),
    );
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
      modals.openConfirmModal({
        title: "Overwrite File",
        children: `Do you want to overwrite "${truncateMiddle(fileName, 50)}"?`,
        labels: { confirm: "Overwrite", cancel: "Cancel" },
        confirmProps: { color: "red", size: "xs" },
        cancelProps: { size: "xs" },
        onConfirm: async () => {
          try {
            // Extract audio channels from AudioBuffer
            const numChannels = file.audioBuffer!.numberOfChannels;
            const audioChannels: Float32Array[] = [];
            for (let i = 0; i < numChannels; i++) {
              audioChannels.push(file.audioBuffer!.getChannelData(i));
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
      set(
        produce((state: State) => {
          const oldBpm = state.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            state.filepathsBpm[outputPath] = oldBpm;
          }
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
      set(
        produce((state: State) => {
          const oldBpm = state.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            state.filepathsBpm[outputPath] = oldBpm;
          }
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

    if (state.filesDirty[fileId]) {
      await new Promise<void>((resolve) => {
        modals.openConfirmModal({
          title: "Unsaved Changes",
          children: `Are you sure you want to close this file without saving?`,
          labels: { confirm: "Close", cancel: "Cancel" },
          confirmProps: { color: "red", size: "xs" },
          cancelProps: { size: "xs" },
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

    return set(
      produce((state: State) => {
        if (openFile) {
          if (state.isPlaying && state.activeFileId === fileId) {
            state.stopAudio();
          }

          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.filesBandsPerOctave[fileId];
          delete state.filesZoom[fileId];
          delete state.filesOffset[fileId];
          delete state.filesPlaybackStartTime[fileId];
          delete state.filesDirty[fileId];
          delete openFiles[fileId];

          const nextFileId = state.openFileIds[state.openFileIds.length - 1] || null;
          state.activeFileId = nextFileId || null;

          // If the file being closed is the source file, set the source file to the next file
          if (!nextFileId) state.sourceFile = null;
          else if (state.sourceFile === fileId) {
            state.sourceFile = nextFileId;
          }
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

    const { normalize, activeFileId, bandsPerOctave, minFreq, isPlaying, getPlayer, setFileSynthesizing } = get();
    if (!activeFileId) return;

    try {
      const file = openFiles[fileId];
      if (!file || !file.rendererRef?.current) {
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

        // Convert UV Y coordinates to band numbers (Y=0 is lowest freq, Y=1 is highest)
        startBand = Math.max(0, Math.floor(dirtyRegion.startY * originalAnalysis.numBands));
        endBand = Math.min(originalAnalysis.numBands, Math.ceil(dirtyRegion.endY * originalAnalysis.numBands));

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
          normalize,
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
      console.log(`[timing] C++ synthesis: ${(performance.now() - cppSynthStart).toFixed(2)}ms` + (isPartial ? " (partial)" : " (full)"));

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

      // Mark file as dirty if it's not the first synthesis
      get().setFileDirty(fileId, file.audioBuffer !== undefined);

      file.audioBuffer = audioBuffer;

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
  reanalyzeActiveFile: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];

    modals.openConfirmModal({
      title: "Re-analyze File",
      children: `This will re-analyze the file with the new settings. You will lose the undo history.`,
      labels: { confirm: "Re-analyze", cancel: "Cancel" },
      confirmProps: { color: "red", size: "xs" },
      cancelProps: { size: "xs" },
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
      transport.bpm.value = get().filepathsBpm[file.filePath];

      if (file.audioBuffer) {
        transport.setLoopPoints(0, file.audioBuffer.duration);
      }

      get().stopAudio();
    }
    set({ activeFileId });
  },
  sourceFile: null,
  setSourceFile: (sourceFile) => set({ sourceFile }),
  fullscreenFileId: null,
  setFullscreenFileId: (fileId) => set({ fullscreenFileId: fileId }),
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
