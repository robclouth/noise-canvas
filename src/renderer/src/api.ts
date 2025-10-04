import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import type { AnalysisPayloadForRenderer } from "src/main/lib/types";
import { Vector2 } from "three";
import { openFiles, useStore } from "./store";
import type { OpenFile } from "./types";

let unsubscribers: (() => void)[] = [];

export function init() {
  if (process.env.NODE_ENV === "development") {
    if (Object.keys(useStore.getState().openFilePaths).length === 0) {
      openFile(
        "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
      );
      openFile(
        "/Users/rob/Splice/sounds/packs/Indian Vocal Pack (Mitika Kanwar)/Indian_Vocal_Pack/Loops/Resampled/JMK_IVP_124_indian_vocal_female_hook_humming_dance_resampled_pitched_A#m.wav",
      );
      // openFile("/Users/rob/Desktop/tone2.wav");
      // openFile("/Users/rob/Desktop/tone2-sat.wav");
    }
  }

  // Clear locked offset when switching away from offset mode
  const unsubModeChange = useStore.subscribe(
    (state) => state.sourcePositionMode.value,
    (mode, prevMode) => {
      if (prevMode === "offset" && mode !== "offset") {
        useStore.getState().setLockedOffset(null);
      }
    },
  );
  unsubscribers.push(unsubModeChange);

  const unsubOpenFile = window.api.onOpenFile((path) => {
    openFile(path);
  });
  unsubscribers.push(unsubOpenFile);

  const unsubOpenAndAnalyze = window.api.onOpenAndAnalyze(() => {
    const { bandsPerOctave, minFreq } = useStore.getState();
    const analysisParams = {
      bandsPerOctave: bandsPerOctave.value,
      minFreq: minFreq.value,
    };
    window.api.openAndAnalyze(analysisParams);
  });
  unsubscribers.push(unsubOpenAndAnalyze);

  const unsubCloseActiveFile = window.api.onCloseActiveFile(() => {
    const { activeFilePath } = useStore.getState();
    if (activeFilePath) {
      closeFile(activeFilePath);
    }
  });
  unsubscribers.push(unsubCloseActiveFile);

  const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
    const { closeFile, setActiveFilePath } = useStore.getState();
    Object.keys(openFiles).forEach((path) => {
      closeFile(path);
    });
    setActiveFilePath(null);
  });
  unsubscribers.push(unsubCloseAllFiles);

  const unsubAnalysisComplete = window.api.onAnalysisComplete((payload) => {
    addFile(payload);
  });
  unsubscribers.push(unsubAnalysisComplete);

  const unsubAnalysisError = window.api.onAnalysisError(() => {
    notifications.show({
      title: "Analysis Error",
      message: "An error occurred while analyzing the audio.",
      color: "red",
    });
  });
  unsubscribers.push(unsubAnalysisError);

  const unsubUndo = window.api.onUndoApplyState(({ filePath, data }) => {
    const file = openFiles[filePath];
    if (!file?.rendererRef?.current) return;
    file.rendererRef.current.setFBOData(
      new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
    );
    file.rendererRef.current.synthesize();
  });
  unsubscribers.push(unsubUndo);

  const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
    const { activeFilePath, normalize } = useStore.getState();
    const activeFile = activeFilePath ? openFiles[activeFilePath] : null;

    if (!activeFile) return;
    const rendererRef = activeFile.rendererRef;
    if (!rendererRef?.current) return;

    const processedData = rendererRef.current.getFBOData();
    const spectrogramData = activeFile.spectrogramData;
    if (!processedData || !spectrogramData) {
      return;
    }

    const analysisParams = {
      bandsPerOctave: activeFile.spectrogramData.bandsPerOctave,
      minFreq: activeFile.spectrogramData.minFreq,
    };
    const payload = {
      processedData: processedData.buffer,
      analysisMetadata: {
        numFrames: spectrogramData.numFrames,
        numChannels: spectrogramData.numChannels,
        numBands: spectrogramData.numBands,
        ...spectrogramData.synthesisMetadata,
      },
    };

    try {
      await window.api.saveAudioData(payload, analysisParams, normalize.value);
      notifications.show({
        title: "Success",
        message: "File saved successfully!",
        color: "green",
      });
      console.log("File saved successfully!");
    } catch (e) {
      console.error("Failed to save audio", e);
      notifications.show({
        title: "Failed to save file",
        message: e instanceof Error ? e.message : "An unknown error occurred.",
        color: "red",
      });
    }
  });
  unsubscribers.push(unsubRequestAudioForSaving);

  const unsubRestore = window.api.onRestoreOriginal(() => {
    const { activeFilePath } = useStore.getState();
    if (!activeFilePath) return;
    const file = openFiles[activeFilePath]; // Get the ref from the map

    if (!file?.rendererRef?.current) return;

    file.rendererRef.current.restoreOriginal();
  });
  unsubscribers.push(unsubRestore);

  const unsubReanalyze = window.api.onReanalyzeActiveFile(() => {
    const { activeFilePath, bandsPerOctave, minFreq } = useStore.getState();
    if (!activeFilePath) {
      notifications.show({
        title: "No Active File",
        message: "Please select a file to re-analyze.",
        color: "yellow",
      });
      return;
    }

    const file = openFiles[activeFilePath];
    if (!file) return;

    const currentResolution = bandsPerOctave.value;
    const currentMinFreq = minFreq.value;

    modals.openConfirmModal({
      title: "Re-analyze File",
      children: `This will re-analyze the file with the new settings. All edits will be lost.`,
      labels: { confirm: "Re-analyze", cancel: "Cancel" },
      confirmProps: { color: "red", size: "xs" },
      cancelProps: { size: "xs" },
      styles: {
        title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
        body: { fontSize: "var(--mantine-font-size-sm)" },
      },
      onConfirm: async () => {
        try {
          const analysisParams = {
            bandsPerOctave: currentResolution,
            minFreq: currentMinFreq,
          };
          await window.api.reanalyzeCurrentFile(analysisParams);
        } catch (error) {
          notifications.show({
            title: "Re-analysis Failed",
            message: error instanceof Error ? error.message : "An unknown error occurred.",
            color: "red",
          });
        }
      },
    });
  });
  unsubscribers.push(unsubReanalyze);

  // Subscribe to active file changes to notify the main process
  useStore.subscribe((state, prevState) => {
    if (state.activeFilePath !== prevState.activeFilePath) {
      const newPath = state.activeFilePath;
      if (newPath) {
        window.api.setActiveFile(newPath);
      }
    }
  });
}

export function destroy() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  const { closeAllFiles, setActiveFilePath, setSourceFile } = useStore.getState();
  closeAllFiles();
  setActiveFilePath(null);
  setSourceFile(null);
}

export function addFile(payload: AnalysisPayloadForRenderer) {
  const { openFile, filesBpm, setFileBpm, setActiveFilePath, sourceFile, setSourceFile, setFileResolution } =
    useStore.getState();

  const isReanalysis = !!openFiles[payload.filePath];

  const spectrogramData = {
    packedData: new Float32Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength / 4),
    inverseMap: new Float32Array(
      payload.inverseMap.buffer,
      payload.inverseMap.byteOffset,
      payload.inverseMap.byteLength / 4,
    ),
    metadata: new Float32Array(
      payload.metadataTexture.buffer,
      payload.metadataTexture.byteOffset,
      payload.metadataTexture.byteLength / 4,
    ),
    textureWidth: payload.textureWidth,
    textureHeight: payload.textureHeight,
    numFrames: payload.numFrames,
    numBands: payload.numBands,
    numChannels: payload.numChannels,
    sampleRate: payload.sampleRate,
    packedTextureSize: new Vector2(payload.textureWidth, payload.textureHeight),
    minFreq: payload.minFreq,
    bandsPerOctave: payload.bandsPerOctave,
    synthesisMetadata: {
      bandOffsets: payload.bandOffsets,
      bandStepLog2s: payload.bandStepLog2s,
      bandLengths: payload.bandLengths,
    },
  };

  if (isReanalysis) {
    // Update the existing file's data
    const existingFile = openFiles[payload.filePath];
    existingFile.spectrogramData = spectrogramData;
    delete existingFile.audioBuffer; // Clear cached audio

    // Clear undo history for this file
    window.api.clearUndoState();

    // Update the resolution in the store (reactive)
    const { setFileResolution } = useStore.getState();
    setFileResolution(payload.filePath, payload.bandsPerOctave);

    // Call reloadTextures on the renderer to update with new data
    if (existingFile.rendererRef?.current) {
      existingFile.rendererRef.current.reloadTextures();
    }
  } else {
    // Create new file
    const newFile: OpenFile = {
      filePath: payload.filePath,
      spectrogramData,
    };
    openFile(newFile);
    if (!filesBpm[newFile.filePath]) {
      setFileBpm(newFile.filePath, 120);
    }
    setFileResolution(newFile.filePath, payload.bandsPerOctave);
    setActiveFilePath(newFile.filePath);

    // If no source file is set, set this file as the source
    if (!sourceFile) {
      setSourceFile({ path: newFile.filePath, mode: "current" });
    }

    window.api.fileOpened(newFile.filePath);
  }

  // Show notification if the file was clamped due to texture size limits
  if (payload.isClamped) {
    notifications.show({
      title: "File Duration Clamped",
      message: `File exceeded 8K x 8K texture limit and was clamped to ${payload.clampedDurationSeconds.toFixed(2)} seconds.`,
      color: "yellow",
      autoClose: 8000,
    });
  }
}

function openFile(filePath: string) {
  const { bandsPerOctave, minFreq } = useStore.getState();
  const params = {
    bandsPerOctave: bandsPerOctave.value,
    minFreq: minFreq.value,
  };
  window.api.loadFile(filePath, params);
}

export function closeFile(filePath: string) {
  const { sourceFile, closeFile, setFileBpm, setActiveFilePath, setSourceFile, openFilePaths } = useStore.getState();
  const isClosingSource = sourceFile?.path === filePath;

  // Get the index of the file being closed before we close it
  const closingFileIndex = openFilePaths.indexOf(filePath);

  closeFile(filePath);
  delete openFiles[filePath];

  setFileBpm(filePath, undefined);
  window.api.fileClosed(filePath);
  const remainingOpenFiles = Object.keys(openFiles);

  let newActiveFilePath: string | null = null;
  let newSourceFilePath: string | null = null;

  if (remainingOpenFiles.length > 0) {
    // For active file, use the last one
    newActiveFilePath = remainingOpenFiles[remainingOpenFiles.length - 1];
    setActiveFilePath(newActiveFilePath);

    // For source file, use the file before the one being closed, or the first available
    if (isClosingSource) {
      if (closingFileIndex > 0 && remainingOpenFiles[closingFileIndex - 1]) {
        newSourceFilePath = remainingOpenFiles[closingFileIndex - 1];
      } else {
        newSourceFilePath = remainingOpenFiles[0];
      }
      setSourceFile({ path: newSourceFilePath, mode: sourceFile?.mode ?? "current" });
    }
  } else {
    setActiveFilePath(null);
    if (isClosingSource) {
      setSourceFile(null);
    }
  }
}
