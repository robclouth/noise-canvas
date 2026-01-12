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
  saveActiveFile: () => Promise<void>;
  saveActiveFileAs: () => Promise<void>;
  saveActiveFileVersion: () => Promise<void>;
  tryCloseFile: (fileId: string) => Promise<void>;
  closeFile: (fileId: string) => void;
  reanalyzeActiveFile: () => Promise<void>;
  synthesizeFile: (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
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
  activeFileId: string | null;
  setActiveFileId: (activeFileId: string | null) => Promise<void>;
  sourceFile: string | null;
  setSourceFile: (sourceFile: string | null) => void;
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

      // Generate unique file ID
      const fileId = generateFileId();
      openFiles[fileId] = {
        id: fileId,
        filePath: filepath,
        spectrogramData,
      };

      return set(
        produce((state: State) => {
          state.openFileIds.push(fileId);
          state.filepathsBpm[filepath] ??= state.mostRecentBpm ?? 120;
          state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
          state.filesZoom[fileId] = 0;
          state.filesOffset[fileId] = 0;
          state.filesPlaybackStartTime[fileId] = 0;

          state.sourceFile = fileId;
          state.activeFileId = fileId;
        }),
      );
    } catch (error) {
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

      // Update file path in openFiles
      file.filePath = outputPath;

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

      // Update file path in openFiles
      file.filePath = outputPath;

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
  ) => {
    const { normalize, activeFileId, bandsPerOctave, minFreq, isPlaying, getPlayer, setFileSynthesizing } = get();
    if (!activeFileId) return;

    try {
      const file = openFiles[fileId];
      if (!file || !file.rendererRef?.current) {
        return;
      }

      setFileSynthesizing(fileId, true);

      const originalAnalysis = file.spectrogramData;

      // Assemble the payload for the main process
      const fboData = await file.rendererRef.current.getFBOData();
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

      const synthesisStart = performance.now();

      const processedDataArray = new Float32Array(
        payload.processedData,
        0,
        payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      const audioBufferChannels = await window.audioAnalysis.synthesize(
        processedDataArray,
        payload.analysisMetadata,
        originalAnalysis.sampleRate,
        analysisParams,
        normalize,
      );

      const synthesisTime = performance.now() - synthesisStart;
      console.log("Synthesis took:", synthesisTime.toFixed(2), "ms");

      const numChannels = audioBufferChannels.length;
      const numFrames = audioBufferChannels[0].length;

      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(numChannels, numFrames, originalAnalysis.sampleRate);
      for (let i = 0; i < numChannels; i++) {
        const channelBuffer = audioBufferChannels[i];

        audioBuffer.copyToChannel(channelBuffer as Float32Array<ArrayBuffer>, i);
      }

      // Mark file as dirty if it's not the first synthesis
      get().setFileDirty(fileId, file.audioBuffer !== undefined);

      file.audioBuffer = audioBuffer;

      if (autoPlaybackParams) {
        // --- Handle auto-playback of the painted region ---
        const { startTimeSeconds, endTimeSeconds } = autoPlaybackParams;

        // If already playing, stop it first. togglePlayback is async.
        if (get().isPlaying) {
          await get().togglePlayback();
        }

        // Set the special one-shot playback boundaries
        get().setAutoPlayEndTime(endTimeSeconds);
        get().setFilePlaybackStartTime(fileId, startTimeSeconds);

        // Now, toggle playback ON. It will use the start/end times we just set.
        await get().togglePlayback();
      } else if (isPlaying && activeFileId === fileId) {
        // --- Handle standard buffer hot-swap while playing ---
        const player = getPlayer();
        const t = get().getPlaybackTime(); // Get time BEFORE swapping

        // Swap the buffer in the player
        player.buffer = new Tone.ToneAudioBuffer(audioBuffer);

        // Use setPlaybackTime to correctly restart the player from the same spot
        // with the new buffer and correct loop settings.
        get().setPlaybackTime(t);
      }
      // If not playing and not auto-playing, do nothing. The new buffer is ready for the next time the user hits play.
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
