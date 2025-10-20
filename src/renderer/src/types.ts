import type {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  FileSettings,
  OpenFile,
  OptionsParameter,
  Parameter,
  ParameterKey,
  SpectrogramData,
} from "./store/types";

// Re-export types from store for convenience
export type {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  FileSettings,
  OpenFile,
  OptionsParameter,
  Parameter,
  ParameterKey,
  SpectrogramData,
};

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

export type ParameterUniform = {
  value: number;
  minValue: number;
  maxValue: number;
  modulationAmounts: number[];
};

export type AnyParameter<T> =
  | ContinuousNumberParameter
  | OptionsParameter<T>
  | BooleanParameter
  | DiscreteNumberParameter;
