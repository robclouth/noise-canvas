import { notifications } from "@mantine/notifications";
import { omit } from "lodash-es";
import type { AnalysisPayloadForRenderer } from "src/main/lib/types";
import { Vector2 } from "three";
import {
  activeFileAtom,
  activeFilePathAtom,
  audioBufferFamily,
  bandsPerOctaveAtom,
  fileAtomFamily,
  filesBpmAtom,
  minFreqAtom,
  normalizeAtom,
  openFilePathsAtom,
  rendererRefs,
  sourceFilePathAtom,
  store,
} from "./store";
import type { OpenFile } from "./types";

let unsubscribers: (() => void)[] = [];

export function init() {
  if (process.env.NODE_ENV === "development") {
    if (store.get(openFilePathsAtom).length === 0) {
      openFile(
        "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
      );
      openFile(
        "/Users/rob/Splice/sounds/packs/The Jungle Drummer - Breakbeat Culture/Test_Press_-_The_Jungle_Drummer_-_Breakbeat_Culture/Loops/Layered_Breaks/TSP_TJD_172_break_layered_2snare_junglism.wav",
      );
    }
  }

  const unsubOpenFile = window.api.onOpenFile((path) => {
    openFile(path);
  });
  unsubscribers.push(unsubOpenFile);

  const unsubOpenAndAnalyze = window.api.onOpenAndAnalyze(() => {
    const analysisParams = {
      bandsPerOctave: store.get(bandsPerOctaveAtom),
      minFreq: store.get(minFreqAtom),
    };
    window.api.openAndAnalyze(analysisParams);
  });
  unsubscribers.push(unsubOpenAndAnalyze);

  const unsubCloseActiveFile = window.api.onCloseActiveFile(() => {
    const activeFile = store.get(activeFileAtom);
    if (activeFile) {
      closeFile(activeFile.filePath);
    }
  });
  unsubscribers.push(unsubCloseActiveFile);

  const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
    store.get(openFilePathsAtom).forEach((path) => {
      fileAtomFamily.remove(path);
      audioBufferFamily.remove(path);
    });
    store.set(openFilePathsAtom, []);
    store.set(activeFilePathAtom, null);
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
    const rendererRef = rendererRefs[filePath];
    if (!rendererRef?.current) return;
    rendererRef.current.setFBOData(
      new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
    );
    rendererRef.current.synthesize();
  });
  unsubscribers.push(unsubUndo);

  const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
    const activeFile = store.get(activeFileAtom);

    if (!activeFile) return;
    const rendererRef = rendererRefs[activeFile?.filePath];
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
    const normalize = store.get(normalizeAtom);

    try {
      await window.api.saveAudioData(payload, analysisParams, normalize);
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
    const activeFile = store.get(activeFileAtom);
    if (!activeFile) return;
    const rendererRef = rendererRefs[activeFile?.filePath]; // Get the ref from the map

    if (!rendererRef?.current) return;

    rendererRef.current.restoreOriginal();
  });
  unsubscribers.push(unsubRestore);

  store.sub(activeFilePathAtom, () => {
    const newPath = store.get(activeFilePathAtom);
    if (newPath && !store.get(sourceFilePathAtom)) {
      store.set(sourceFilePathAtom, newPath);
    }
    window.api.setActiveFile(newPath);
  });
}

export function destroy() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];

  store.get(openFilePathsAtom).forEach((path) => {
    fileAtomFamily.remove(path);
    audioBufferFamily.remove(path);
  });
  store.set(openFilePathsAtom, []);
  store.set(activeFilePathAtom, null);
  store.set(sourceFilePathAtom, null);
}

export function addFile(payload: AnalysisPayloadForRenderer) {
  if (store.get(openFilePathsAtom).includes(payload.filePath)) {
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

  store.set(fileAtomFamily(newFile.filePath), newFile);
  store.set(audioBufferFamily(newFile.filePath), null);
  store.set(openFilePathsAtom, (paths) => [...paths, newFile.filePath]);

  if (!store.get(filesBpmAtom)[newFile.filePath]) {
    store.set(filesBpmAtom, (bpms) => ({ ...bpms, [newFile.filePath]: 120 }));
  }
  store.set(activeFilePathAtom, newFile.filePath);
  window.api.fileOpened(newFile.filePath);
}

function openFile(filePath: string) {
  const params = {
    bandsPerOctave: store.get(bandsPerOctaveAtom),
    minFreq: store.get(minFreqAtom),
  };
  window.api.loadFile(filePath, params);
}

export function closeFile(filePath: string) {
  const isClosingSource = store.get(sourceFilePathAtom) === filePath;
  store.set(openFilePathsAtom, (paths) => paths.filter((p) => p !== filePath));
  fileAtomFamily.remove(filePath);
  audioBufferFamily.remove(filePath);

  store.set(filesBpmAtom, (bpms) => omit(bpms, filePath));
  window.api.fileClosed(filePath);
  const openFilesPaths = store.get(openFilePathsAtom);

  let newActiveFilePath: string | null = null;
  if (openFilesPaths.length > 0) {
    newActiveFilePath = openFilesPaths[openFilesPaths.length - 1];
    store.set(activeFilePathAtom, newActiveFilePath);
  } else {
    store.set(activeFilePathAtom, null);
  }

  if (isClosingSource) {
    store.set(sourceFilePathAtom, newActiveFilePath);
  }
}
