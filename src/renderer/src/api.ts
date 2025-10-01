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

  useStore.subscribe((state, prevState) => {
    if (state.activeFilePath !== prevState.activeFilePath) {
      const newPath = state.activeFilePath;
      if (newPath) {
        if (!state.sourceFilePath) {
          useStore.getState().setSourceFilePath(newPath);
        }
        window.api.setActiveFile(newPath);
      }
    }
  });
}

export function destroy() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  const { closeAllFiles, setActiveFilePath, setSourceFilePath } = useStore.getState();
  closeAllFiles();
  setActiveFilePath(null);
  setSourceFilePath(null);
}

export function addFile(payload: AnalysisPayloadForRenderer) {
  const { openFile, filesBpm, setFileBpm, setActiveFilePath } = useStore.getState();
  if (openFiles[payload.filePath]) {
    return;
  }

  const newFile: OpenFile = {
    filePath: payload.filePath,
    spectrogramData: {
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
    },
  };
  openFile(newFile);
  if (!filesBpm[newFile.filePath]) {
    setFileBpm(newFile.filePath, 120);
  }
  setActiveFilePath(newFile.filePath);
  window.api.fileOpened(newFile.filePath);
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
  const { sourceFilePath, closeFile, setFileBpm, setActiveFilePath, setSourceFilePath } = useStore.getState();
  const isClosingSource = sourceFilePath === filePath;
  closeFile(filePath);

  setFileBpm(filePath, undefined);
  window.api.fileClosed(filePath);
  const openFilePaths = Object.keys(openFiles);

  let newActiveFilePath: string | null = null;
  if (openFilePaths.length > 0) {
    newActiveFilePath = openFilePaths[openFilePaths.length - 1];
    setActiveFilePath(newActiveFilePath);
  } else {
    setActiveFilePath(null);
  }

  if (isClosingSource) {
    setSourceFilePath(newActiveFilePath);
  }
}
