import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { DataTexture, Vector2 } from "three";
import * as Tone from "tone";
import { audioBufferAtom } from "./audio-manager";
import { BrushType, brushes } from "./components/brushes";

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
  packedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
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

// This atom will hold the processed, ready-to-render spectrogram data
export const spectrogramDataAtom = atom<SpectrogramData | null>(null);

// Is audio currently playing?
export const isPlayingAtom = atom(false);

// Brush type
const defaultBrush = Object.keys(brushes)[0] as BrushType;
export const brushTypeAtom = atomWithStorage<BrushType>("brushType", defaultBrush);

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

// --- Core Functions ---

export const analysisParams = {
  bandsPerOctave: 48,
  fmin: 20.0,
};

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
    const payload: SynthesisPayload = {
      processedData: Buffer.from(processedData.buffer),
      analysisMetadata: {
        numFrames: originalAnalysis.numFrames,
        numChannels: originalAnalysis.numChannels,
        numBands: originalAnalysis.numBands,
        ...originalAnalysis.synthesisMetadata,
      },
    };

    const audioBufferArray: Float32Array = await window.electron.ipcRenderer.invoke(
      "synthesize-audio",
      payload,
      analysisParams, // Pass original analysis params
      normalize,
    );

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
