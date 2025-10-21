import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { getUndoManager } from "../lib/undo-manager";
import type { FilesState, State, ZustandGet, ZustandSet } from "./types";
import { generateFileId } from "./utils";

import type { OpenFile } from "./types";

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

export const createFilesSlice = (set: ZustandSet, get: ZustandGet): FilesState => ({
  openFileIds: [],
  openFilePath: async (filePath: string) => {
    const state = get();
    // Check if file is already open by path
    const existingFileId = getFileIdByPath(filePath);
    if (existingFileId) {
      // File already open, just activate it
      set({ activeFileId: existingFileId });
      return;
    }

    const result = await window.audioAnalysis.analyze(filePath, {
      bandsPerOctave: state.bandsPerOctave?.value ?? 36,
      minFreq: state.minFreq?.value ?? 16.3516,
    });

    const spectrogramData = {
      packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
      inverseMap: new Float32Array(
        result.inverseMap.buffer,
        result.inverseMap.byteOffset,
        result.inverseMap.byteLength / 4,
      ),
      metadata: new Float32Array(
        result.metadataTexture.buffer,
        result.metadataTexture.byteOffset,
        result.metadataTexture.byteLength / 4,
      ),
      textureWidth: result.textureWidth,
      textureHeight: result.textureHeight,
      numFrames: result.numFrames,
      numBands: result.numBands,
      numChannels: result.numChannels,
      sampleRate: result.sampleRate,
      packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
      minFreq: state.minFreq.value,
      bandsPerOctave: state.bandsPerOctave.value,
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
      filePath,
      spectrogramData,
    };

    return set(
      produce((state: State) => {
        state.openFileIds.push(fileId);
        const fileSettings = state.fileSettings[filePath] || {};

        if (!fileSettings.bpm) fileSettings.bpm = 120;
        if (!fileSettings.bandsPerOctave) fileSettings.bandsPerOctave = state.bandsPerOctave.value;
        if (!fileSettings.zoom) fileSettings.zoom = 0;
        if (!fileSettings.offset) fileSettings.offset = 0;
        if (!fileSettings.playbackStartTime) fileSettings.playbackStartTime = 0;

        state.fileSettings[filePath] = fileSettings;

        if (!state.sourceFile) state.sourceFile = { id: fileId, mode: "current" };
        state.activeFileId = fileId;
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
        children: `Do you want to overwrite "${fileName}"?`,
        labels: { confirm: "Overwrite", cancel: "Cancel" },
        confirmProps: { color: "red", size: "xs" },
        cancelProps: { size: "xs" },
        styles: {
          title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
          body: { fontSize: "var(--mantine-font-size-sm)" },
        },
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
              message: `Successfully saved ${fileName}`,
            });
          } catch (error) {
            console.error("Error saving file:", error);
            // Show error notification
            notifications.show({
              title: "Save failed",
              message: `Failed to save ${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`,
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
      const savedFileName = window.nodePath.basename(outputPath);
      notifications.show({
        title: "File saved",
        message: `Successfully saved as ${savedFileName}`,
      });
    } catch (error) {
      console.error("Error saving file as:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save file: ${error instanceof Error ? error.message : "Unknown error"}`,
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
        message: `Successfully saved as ${newFileName}`,
      });
    } catch (error) {
      console.error("Error saving file version:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save version: ${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    }
  },
  closeFile: (fileId: string) =>
    set(
      produce((state: State) => {
        const openFile = openFiles[fileId];
        if (openFile) {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.fileSettings[openFile.filePath];
          delete state.filesDirty[fileId];
          delete openFiles[fileId];

          const nextFileId = state.openFileIds[state.openFileIds.length - 1] || null;
          state.activeFileId = nextFileId || null;

          // If the file being closed is the source file, set the source file to the next file
          if (!nextFileId) state.sourceFile = null;
          else if (state.sourceFile?.id === fileId) {
            state.sourceFile = {
              id: nextFileId,
              mode: "current",
            };
          }
        }
      }),
    ),
  closeAllFiles: () => {
    // Clear the openFiles object
    Object.keys(openFiles).forEach((fileId) => {
      delete openFiles[fileId];
    });

    return set({
      openFileIds: [],
      filesDirty: {},
      activeFileId: null,
      sourceFile: null,
    });
  },
  synthesizeFile: async (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
  ) => {
    const { normalize, activeFileId, bandsPerOctave, minFreq, isPlaying, getPlayer } = get();
    if (!activeFileId) return;

    try {
      const file = openFiles[fileId];
      if (!file || !file.rendererRef?.current) {
        return;
      }

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
        bandsPerOctave: bandsPerOctave.value,
        minFreq: minFreq.value,
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
        normalize.value,
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
      styles: {
        title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
        body: { fontSize: "var(--mantine-font-size-sm)" },
      },
      onConfirm: async () => {
        if (!state.activeFileId) return;
        const audioBuffer = file?.audioBuffer;
        console.log(window.audioAnalysis);
        const result = audioBuffer
          ? await window.audioAnalysis.analyseBuffer(audioBuffer, {
              bandsPerOctave: state.bandsPerOctave.value,
              minFreq: state.minFreq.value,
            })
          : await window.audioAnalysis.analyze(file.filePath, {
              bandsPerOctave: state.bandsPerOctave.value,
              minFreq: state.minFreq.value,
            });

        const spectrogramData = {
          packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
          inverseMap: new Float32Array(
            result.inverseMap.buffer,
            result.inverseMap.byteOffset,
            result.inverseMap.byteLength / 4,
          ),
          metadata: new Float32Array(
            result.metadataTexture.buffer,
            result.metadataTexture.byteOffset,
            result.metadataTexture.byteLength / 4,
          ),
          textureWidth: result.textureWidth,
          textureHeight: result.textureHeight,
          numFrames: result.numFrames,
          numBands: result.numBands,
          numChannels: result.numChannels,
          sampleRate: result.sampleRate,
          packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
          minFreq: state.minFreq.value,
          bandsPerOctave: state.bandsPerOctave.value,
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
            const file = state.activeFileId && openFiles[state.activeFileId];
            if (file) {
              state.fileSettings[file.filePath].bandsPerOctave = state.bandsPerOctave.value;
            }
          }),
        );
      },
    });
  },
  fileSettings: {},
  getFileSettings: (fileId: string) => {
    const file = openFiles[fileId];
    if (file) return get().fileSettings[file.filePath];
    return null;
  },
  setFileBpm: (fileId, bpm) =>
    set(
      produce((state: State) => {
        if (state.activeFileId === fileId && bpm) {
          Tone.getTransport().bpm.value = bpm;
        }

        const file = openFiles[fileId];
        if (file) state.fileSettings[file.filePath].bpm = bpm;
      }),
    ),
  setFileResolution: (fileId, resolution) =>
    set(
      produce((state: State) => {
        const file = openFiles[fileId];
        if (file) {
          state.fileSettings[file.filePath].bandsPerOctave = resolution;
        }
      }),
    ),
  setFileZoom: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        const file = openFiles[fileId];
        if (file) {
          state.fileSettings[file.filePath].zoom = zoom;
        }
      }),
    ),
  setFileOffset: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        const file = openFiles[fileId];
        if (file) {
          state.fileSettings[file.filePath].offset = offset;
        }
      }),
    ),
  filesDirty: {},
  setFileDirty: (fileId: string, dirty: boolean) => {
    set((state) => ({
      filesDirty: { ...state.filesDirty, [fileId]: dirty },
    }));
  },
  activeFileId: null,
  setActiveFileId: async (activeFileId) => {
    if (activeFileId && openFiles[activeFileId]) {
      const file = openFiles[activeFileId];
      const { fileSettings } = get();
      const transport = Tone.getTransport();
      transport.bpm.value = fileSettings[file.filePath].bpm;

      if (file.audioBuffer) {
        transport.setLoopPoints(0, file.audioBuffer.duration);
      }

      get().stopAudio();
    }
    set({ activeFileId });
  },
  sourceFile: null,
  setSourceFile: (sourceFile) => set({ sourceFile }),
});
