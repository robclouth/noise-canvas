// Describes the flat object returned directly from the C++ addon
export interface GaboratorAnalysisResult {
  data: Float32Array;
  inverseMap: Float32Array;
  metadataTexture: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
}

// Describes the payload sent to the renderer process via IPC. Large arrays are Buffers.
export interface AnalysisPayloadForRenderer {
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

// Describes the payload received from the renderer when requesting synthesis
export interface SynthesisPayload {
  processedData: Buffer; // The modified data from the GPU
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

export interface GaboratorParams {
  bandsPerOctave: number;
  fmin: number;
}
