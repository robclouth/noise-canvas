import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { DataTexture, RGBFormat, FloatType, NearestFilter, RGBAFormat, RGFormat, Vector2 } from "three";
import { audioBufferAtom } from "./audio-manager";
import * as Tone from "tone";
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
export const brushWidthAtom = atomWithStorage("brushWidth", 0.1); // in seconds
export const brushHeightAtom = atomWithStorage("brushHeight", 1000); // in Hz

export const bpmAtom = atomWithStorage("bpm", 120);

// Controls whether the output of the synthesis is normalized
export const normalizeAtom = atom(true);

// --- Core Functions ---

const analysisParams = {
  bandsPerOctave: 48,
  fmin: 20.0,
};

export const runAnalysis = async (filePath: string): Promise<void> => {
  const payload: AnalysisPayload = await window.electron.ipcRenderer.invoke("analyze-audio", filePath, analysisParams);

  const packedDataTex = new DataTexture(
    new Float32Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength / 4),
    payload.textureWidth,
    payload.textureHeight,
    RGBAFormat,
    FloatType,
  );
  packedDataTex.internalFormat = "RGBA32F";
  packedDataTex.minFilter = NearestFilter;
  packedDataTex.magFilter = NearestFilter;
  packedDataTex.needsUpdate = true;

  const inverseMapTex = new DataTexture(
    new Float32Array(payload.inverseMap.buffer, payload.inverseMap.byteOffset, payload.inverseMap.byteLength / 4),
    payload.textureWidth,
    payload.textureHeight,
    RGFormat,
    FloatType,
  );
  inverseMapTex.internalFormat = "RG32F";
  inverseMapTex.minFilter = NearestFilter;
  inverseMapTex.magFilter = NearestFilter;
  inverseMapTex.needsUpdate = true;

  const metadataTex = new DataTexture(
    new Float32Array(
      payload.metadataTexture.buffer,
      payload.metadataTexture.byteOffset,
      payload.metadataTexture.byteLength / 4,
    ),
    payload.numBands,
    1,
    RGBFormat,
    FloatType,
  );
  metadataTex.internalFormat = "RGB32F";
  metadataTex.minFilter = NearestFilter;
  metadataTex.magFilter = NearestFilter;
  metadataTex.needsUpdate = true;

  store.set(spectrogramDataAtom, {
    packedDataTex,
    inverseMapTex,
    metadataTex,
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
  });
};

export const openAudioFile = async (): Promise<void> => {
  const filePath = await window.electron.ipcRenderer.invoke("open-file-dialog");
  if (filePath) {
    // Reset state before loading new file
    store.set(spectrogramDataAtom, null);
    // store.set(processedSpectrogramDataAtom, null);
    await runAnalysis(filePath);
  }
};

export const runSynthesis = async (processedData: Float32Array | null): Promise<void> => {
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

  // If it's mono, we can just copy it directly.
  if (originalAnalysis.numChannels === 1) {
    audioBuffer.copyToChannel(audioBufferArray, 0);
  } else {
    // For stereo (or more channels), we must de-interleave.
    for (let c = 0; c < originalAnalysis.numChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      for (let i = 0; i < numFrames; i++) {
        // Pick samples from the interleaved array
        channelData[i] = audioBufferArray[i * originalAnalysis.numChannels + c];
      }
    }
  }

  store.set(audioBufferAtom, audioBuffer);
};
