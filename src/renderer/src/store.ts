import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { DataTexture, Vector2 } from "three";
import * as Tone from "tone";
import { audioBufferAtom } from "./audio-manager";

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

export const filePathAtom = atom<string | null>(null);

// Is audio currently playing?
export const isPlayingAtom = atom(false);

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
