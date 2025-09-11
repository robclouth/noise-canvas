import { notifications } from "@mantine/notifications";
import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { RefObject } from "react";
import type { AnalysisPayloadForRenderer } from "src/main/lib/types";
import { Vector2 } from "three";
import * as Tone from "tone";
import { audioBufferAtom } from "./audio-manager";
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
  id: string;
  filePath: string;
  spectrogramData: SpectrogramData;
  renderer?: RefObject<FileRendererHandle | null>;
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

export const openFilesAtom = atom<OpenFile[]>([]);
export const activeFileIdAtom = atom<string | null>(null);
export const sourceFileIdAtom = atom<string | null>(null);

export const activeFileAtom = atom((get) => {
  const files = get(openFilesAtom);
  const activeId = get(activeFileIdAtom);
  if (!activeId) return null;
  return files.find((f) => f.id === activeId) ?? null;
});

export const sourceFileAtom = atom((get) => {
  const files = get(openFilesAtom);
  const sourceId = get(sourceFileIdAtom);
  if (sourceId === null) return null;
  return files.find((f) => f.id === sourceId) ?? null;
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
    if (store.get(openFilesAtom).length === 0) {
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
      closeFile(activeFile.id);
    }
  });
  unsubscribers.push(unsubCloseActiveFile);

  const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
    store.set(openFilesAtom, []);
    store.set(activeFileIdAtom, null);
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
    if (activeFile?.renderer?.current) {
      activeFile.renderer.current.setFBOData(
        new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
    }
  });
  unsubscribers.push(unsubUndo);

  const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
    const activeFile = store.get(activeFileAtom);
    if (!activeFile?.renderer?.current) {
      return;
    }

    const processedData = activeFile.renderer.current.getFBOData();
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

  store.set(openFilesAtom, []);
  store.set(activeFileIdAtom, null);
  store.set(sourceFileIdAtom, null);
}

export function addFile(filePath: string, payload: AnalysisPayloadForRenderer) {
  const openFiles = store.get(openFilesAtom);
  if (openFiles.some((file) => file.filePath === filePath)) {
    return;
  }

  const newFile = {
    id: crypto.randomUUID(),
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
  };

  store.set(openFilesAtom, [...store.get(openFilesAtom), newFile]);
  store.set(activeFileIdAtom, newFile.id);

  window.api.clearUndoState();
}

export function closeFile(fileId: string) {
  store.set(
    openFilesAtom,
    store.get(openFilesAtom).filter((f) => f.id !== fileId),
  );
}

export const runSynthesis = async (processedData: Float32Array | null): Promise<void> => {
  try {
    const originalAnalysis = store.get(spectrogramDataAtom);
    const normalize = store.get(normalizeAtom);

    if (!processedData || !originalAnalysis) {
      console.error("No processed data available to synthesize.");
      alert("Please process the spectrogram (by changing a parameter) before synthesizing.");
      return;
    }

    // Assemble the payload for the main process
    const payload = {
      processedData: processedData.buffer,
      analysisMetadata: {
        numFrames: originalAnalysis.numFrames,
        numChannels: originalAnalysis.numChannels,
        numBands: originalAnalysis.numBands,
        ...originalAnalysis.synthesisMetadata,
      },
    };

    const analysisParams = {
      bandsPerOctave: store.get(bandsPerOctaveAtom),
      fmin: store.get(fminAtom),
    };
    const audioBufferArray: Float32Array = await window.api.synthesizeAudio(payload, analysisParams, normalize);

    const audioContext = Tone.getContext().rawContext;
    const numFrames = audioBufferArray.length / originalAnalysis.numChannels;

    const audioBuffer = audioContext.createBuffer(originalAnalysis.numChannels, numFrames, originalAnalysis.sampleRate);

    // For each channel, copy the samples from the interleaved array
    for (let c = 0; c < originalAnalysis.numChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      for (let i = 0; i < numFrames; i++) {
        // Pick samples from the interleaved array
        channelData[i] = audioBufferArray[i * originalAnalysis.numChannels + c];
      }
    }

    store.set(audioBufferAtom, audioBuffer);
  } catch (error) {
    console.error("Error running synthesis:", error);
  }
};
