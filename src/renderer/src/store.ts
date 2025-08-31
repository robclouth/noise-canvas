import { atom, createStore } from "jotai";

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

// This is the processed data structure that our React components will use.
// It's now a direct mapping of the payload, with Buffers converted to Float32Arrays.
export interface ProcessedAnalysis {
  dataForTexture: { array: Float32Array; width: number; height: number };
  metadataForTexture: { array: Float32Array; width: number; height: number };
  inverseMapForTexture: { array: Float32Array; width: number; height: number };
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
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
export const spectrogramDataAtom = atom<ProcessedAnalysis | null>(null);

// Holds the current gain value from the UI (in dB)
export const gainAtom = atom(0.0);

// Holds the current pitch shift value from the UI (in bands)
export const pitchShiftAtom = atom(0.0);

// This will hold the Float32Array read back from the GPU, ready for synthesis
export const processedSpectrogramDataAtom = atom<Float32Array | null>(null);

// --- Core Functions ---

const analysisParams = {
  bandsPerOctave: 96,
  fmin: 20.0,
};

export const runAnalysis = async (filePath: string): Promise<void> => {
  // 1. Get the complete, padded, flattened payload from the C++ addon via the main process
  const payload: AnalysisPayload = await window.electron.ipcRenderer.invoke("analyze-audio", filePath, analysisParams);

  // 2. Assemble the final object for the React components.
  //    The only logic here is converting IPC-friendly Buffers into GPU-friendly Float32Arrays.
  const processedResult: ProcessedAnalysis = {
    dataForTexture: {
      array: new Float32Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength / 4),
      width: payload.textureWidth,
      height: payload.textureHeight,
    },
    metadataForTexture: {
      array: new Float32Array(
        payload.metadataTexture.buffer,
        payload.metadataTexture.byteOffset,
        payload.metadataTexture.byteLength / 4,
      ),
      width: payload.numBands,
      height: 1,
    },
    inverseMapForTexture: {
      array: new Float32Array(
        payload.inverseMap.buffer,
        payload.inverseMap.byteOffset,
        payload.inverseMap.byteLength / 4,
      ),
      width: payload.textureWidth,
      height: payload.textureHeight,
    },
    numFrames: payload.numFrames,
    numBands: payload.numBands,
    numChannels: payload.numChannels,
    sampleRate: payload.sampleRate,
    synthesisMetadata: {
      bandOffsets: payload.bandOffsets,
      bandStepLog2s: payload.bandStepLog2s,
      bandLengths: payload.bandLengths,
    },
  };

  // 3. Set the atom, which will trigger the UI to update
  store.set(spectrogramDataAtom, processedResult);
};

export const openAudioFile = async (): Promise<void> => {
  const filePath = await window.electron.ipcRenderer.invoke("open-file-dialog");
  if (filePath) {
    // Reset state before loading new file
    store.set(spectrogramDataAtom, null);
    store.set(processedSpectrogramDataAtom, null);
    await runAnalysis(filePath);
  }
};

export const runSynthesis = async (): Promise<void> => {
  const processedData = store.get(processedSpectrogramDataAtom);
  const originalAnalysis = store.get(spectrogramDataAtom);

  if (!processedData || !originalAnalysis) {
    console.error("No processed data available to synthesize.");
    alert("Please process the spectrogram (by changing a parameter) before synthesizing.");
    return;
  }

  console.log("Sending processed data to main process for synthesis...");

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

  const audioBuffer: Float32Array = await window.electron.ipcRenderer.invoke(
    "synthesize-audio",
    payload,
    analysisParams, // Pass original analysis params
  );

  console.log("Synthesis complete!", audioBuffer);
  // Next steps: play the audio or offer it as a download
  // For example, you could create a Blob and an object URL to play in an <audio> element.
};
