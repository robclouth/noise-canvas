import { atom, createStore } from "jotai";

export const store = createStore();

// This interface matches the payload received from the Electron main process
export interface AnalysisPayload {
  data: Buffer;
  metadata: {
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array; // Added back
  };
  numFrames: number;
  sampleRate: number;
}

// This is the processed data structure that our React components will use
export interface ProcessedAnalysis {
  dataForTexture: {
    array: Float32Array;
    width: number;
    height: number;
  };
  metadataForTexture: {
    array: Float32Array;
    width: number; // This will be numBands
    height: number; // This will be 1
  };
  numFrames: number;
  numBands: number;
  numChannels: number;
}

export const spectrogramDataAtom = atom<ProcessedAnalysis | null>(null);

const analysisParams = {
  bandsPerOctave: 96,
  fmin: 20.0,
};

// Helper to calculate optimal 2D texture dimensions for a 1D array of "pixels"
const getTextureSize = (numPixels: number): { width: number; height: number } => {
  const maxWidth = 4096; // A common GPU limit
  const width = Math.min(numPixels, maxWidth);
  const height = Math.ceil(numPixels / width);
  return { width, height };
};

export const runAnalysis = async (filePath: string): Promise<void> => {
  const payload: AnalysisPayload = await window.electron.ipcRenderer.invoke("analyze-audio", filePath, analysisParams);

  const { data, metadata, numFrames } = payload;
  const { numBands, numChannels, bandOffsets, bandStepLog2s, bandLengths } = metadata;

  const dataAsFloat32 = new Float32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );

  const numPixels = dataAsFloat32.length / 4;
  const dataTextureSize = getTextureSize(numPixels);
  const paddedDataLength = dataTextureSize.width * dataTextureSize.height * 4;
  const paddedData = new Float32Array(paddedDataLength);
  paddedData.set(dataAsFloat32); // Copy the data from the addon into the perfectly sized buffer.

  const metadataForShader = new Float32Array(numBands * 3);
  for (let i = 0; i < numBands; i++) {
    metadataForShader[i * 3 + 0] = bandOffsets[i];
    metadataForShader[i * 3 + 1] = bandLengths[i];
    metadataForShader[i * 3 + 2] = bandStepLog2s[i];
  }

  const processedResult: ProcessedAnalysis = {
    dataForTexture: {
      array: paddedData,
      width: dataTextureSize.width,
      height: dataTextureSize.height,
    },
    metadataForTexture: {
      array: metadataForShader,
      width: numBands,
      height: 1,
    },
    numFrames,
    numBands,
    numChannels,
  };

  store.set(spectrogramDataAtom, processedResult);
};

export const openAudioFile = async (): Promise<void> => {
  const filePath = await window.electron.ipcRenderer.invoke("open-file-dialog");
  if (filePath) {
    store.set(spectrogramDataAtom, null);
    await runAnalysis(filePath);
  }
};
