import { notifications } from "@mantine/notifications";
import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { omit } from "lodash-es";
import { createRef, RefObject } from "react";
import type { AnalysisPayloadForRenderer } from "src/main/lib/types";
import { Vector2 } from "three";
import type { FileRendererHandle } from "./components/file-renderer";

export const store = createStore();

// This interface matches the flattened payload received from the Electron main process
export interface AnalysisPayload {
  data: Buffer;
  inverseMap: Buffer;
  metadataTexture: Buffer;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
  sampleRate: number; // Pass sample rate through
}

export interface SpectrogramData {
  packedData: Float32Array;
  inverseMap: Float32Array;
  metadata: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  packedTextureSize: Vector2;
  // Store the raw metadata needed for synthesis separately for clarity
  synthesisMetadata: {
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

export interface OpenFile {
  filePath: string;
  spectrogramData: SpectrogramData;
  rendererRef: RefObject<FileRendererHandle | null>;
  viewRef: RefObject<HTMLDivElement | null>;
  audioBuffer?: AudioBuffer | null;
}

// Describes the payload sent back to the main process for synthesis
export interface SynthesisPayload {
  processedData: Buffer;
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

// --- Jotai Atoms ---

export const openFilesAtom = atom<Record<string, OpenFile>>({});
export const activeFilePathAtom = atom<string | null>(null);
export const activeFileAtom = atom<OpenFile | null>((get) => {
  const activeFilePath = get(activeFilePathAtom);
  const openFiles = get(openFilesAtom);
  return openFiles[activeFilePath ?? ""] ?? null;
});

export const sourceFileAtom = atom<OpenFile | null>(null);

export const audioBufferAtom = atom<AudioBuffer | null>((get) => {
  const activeFile = get(activeFileAtom);
  return activeFile?.audioBuffer ?? null;
});

export const spectrogramDataAtom = atom<SpectrogramData | null>((get) => {
  const activeFile = get(activeFileAtom);
  return activeFile?.spectrogramData ?? null;
});

// Is audio currently playing?
export const isPlayingAtom = atom(false);
export const loopAtom = atom(false);

// Brush type - The default is just a string.
// The App component will be responsible for validating it.
export const brushTypeAtom = atomWithStorage<string>("brushType", "gain");

// Brush dimensions
export const brushWidthAtom = atomWithStorage("brushWidth", 0.25); // in beats
export const brushHeightAtom = atomWithStorage("brushHeight", 1); // in semitones

export const bpmAtom = atomWithStorage("bpm", 120);

// Controls whether the output of the synthesis is normalized
export const normalizeAtom = atom(true);

// Brush snapping
export const snapXAtom = atomWithStorage("snapX", true);
export const snapYAtom = atomWithStorage("snapY", true);
export const gridSizeAtom = atomWithStorage("gridSize", 0.25); // in beats
export const gridSizeYAtom = atomWithStorage("gridSizeY", 1); // in semitones

export const zoomPowerAtom = atomWithStorage("zoomPower", 0);
export const scrollAtom = atom(0);

export const featherXAtom = atomWithStorage("featherX", 0.5);
export const featherYAtom = atomWithStorage("featherY", 0.5);

export const brushIntensityAtom = atomWithStorage("brushIntensity", 1.0);
export const panAtom = atomWithStorage("pan", 0.0);

export const scaleRootAtom = atomWithStorage("scaleRoot", "C");
export const scaleTypeAtom = atomWithStorage("scaleType", "Major");

export const offsetXAtom = atomWithStorage("offsetX", 0.0);
export const offsetYAtom = atomWithStorage("offsetY", 0.0);
export const offsetLockAtom = atomWithStorage("offsetLock", false);

export const mouseUvAtom = atom<Vector2 | null>(null);

export const bandsPerOctaveAtom = atomWithStorage("bandsPerOctave", 48);
export const fminAtom = atomWithStorage("fmin", 20.0);

// --- Core Functions ---

let unsubscribers: (() => void)[] = [];
let currentFilePath: string | null = null;

export function init() {
  const handleOpenFile = (filePath: string) => {
    currentFilePath = filePath;
    const params = {
      bandsPerOctave: store.get(bandsPerOctaveAtom),
      fmin: store.get(fminAtom),
    };
    window.api.loadFile(filePath, params);
  };

  if (process.env.NODE_ENV === "development") {
    if (Object.keys(store.get(openFilesAtom)).length === 0) {
      handleOpenFile("/Users/rob/Documents/Projects/Music/Tools/Noise Canvas Python/input/garage.mp3");
    }
  }

  const unsubOpenFile = window.api.onOpenFile((path) => {
    handleOpenFile(path);
  });
  unsubscribers.push(unsubOpenFile);

  const unsubTriggerOpenFile = window.api.onTriggerOpenFile(async () => {
    try {
      const analysisParams = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      const result = await window.api.openFileAndAnalyze(analysisParams);
      if (result && result.filePath) {
        handleOpenFile(result.filePath);
      }
    } catch (error) {
      console.error("Error opening file:", error);
      notifications.show({
        title: "Analysis Error",
        message: "An error occurred while analyzing the audio.",
        color: "red",
      });
    }
  });
  unsubscribers.push(unsubTriggerOpenFile);

  const unsubCloseActiveFile = window.api.onCloseActiveFile(() => {
    const activeFile = store.get(activeFileAtom);
    if (activeFile) {
      closeFile(activeFile);
    }
  });
  unsubscribers.push(unsubCloseActiveFile);

  const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
    store.set(openFilesAtom, {});
    store.set(activeFilePathAtom, null);
  });
  unsubscribers.push(unsubCloseAllFiles);

  const unsubAnalysisComplete = window.api.onAnalysisComplete((payload) => {
    if (!currentFilePath) {
      console.error("Analysis completed but no file path is set.");
      return;
    }

    addFile(currentFilePath, payload);
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

  const unsubUndo = window.api.onUndoApplyState((data) => {
    const activeFile = store.get(activeFileAtom);
    if (activeFile?.rendererRef?.current) {
      activeFile.rendererRef.current.setFBOData(
        new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
    }
  });
  unsubscribers.push(unsubUndo);

  const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
    const activeFile = store.get(activeFileAtom);
    if (!activeFile?.rendererRef?.current) {
      return;
    }

    const processedData = activeFile.rendererRef.current.getFBOData();
    const spectrogramData = activeFile.spectrogramData;
    if (!processedData || !spectrogramData) {
      return;
    }

    const analysisParams = {
      bandsPerOctave: store.get(bandsPerOctaveAtom),
      fmin: store.get(fminAtom),
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
}

export function destroy() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];

  store.set(openFilesAtom, {});
  store.set(activeFilePathAtom, null);
  store.set(sourceFileAtom, null);
}

export function addFile(filePath: string, payload: AnalysisPayloadForRenderer) {
  const openFiles = store.get(openFilesAtom);
  if (filePath in openFiles) {
    return;
  }

  const newFile = {
    filePath,
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
      synthesisMetadata: {
        bandOffsets: payload.bandOffsets,
        bandStepLog2s: payload.bandStepLog2s,
        bandLengths: payload.bandLengths,
      },
    },
    rendererRef: createRef<FileRendererHandle>(),
    viewRef: createRef<HTMLDivElement>(),
  };

  store.set(openFilesAtom, (openFiles) => ({ ...openFiles, [newFile.filePath]: newFile }));
  store.set(activeFilePathAtom, newFile.filePath);

  window.api.clearUndoState();
}

export function closeFile(file: OpenFile) {
  store.set(openFilesAtom, (openFiles) => omit(openFiles, file.filePath));
  const openFiles = store.get(openFilesAtom);
  const filePaths = Object.keys(openFiles);

  if (filePaths.length > 0) {
    const lastFilePath = filePaths[filePaths.length - 1];
    store.set(activeFilePathAtom, lastFilePath);
  } else {
    store.set(activeFilePathAtom, null);
  }
}
