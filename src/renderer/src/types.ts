import { RefObject } from "react";
import { Vector2 } from "three";
import { FileRendererHandle } from "./components/file-renderer";
import { ParameterKey } from "./store";

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
  minFreq: number;
  bandsPerOctave: number;
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
  rendererRef?: RefObject<FileRendererHandle | null>;
  audioBuffer?: AudioBuffer;
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

export type Parameter<T> = {
  name: string;
  label: string;
  description: string;
  unit?: string;
  value: T;
  modulatorParamKeys?: ParameterKey[];
  setValue: (value: T) => void;
  resetValue: () => void;
};

export type ContinuousNumberParameter = Parameter<number> & {
  min: number;
  max: number;
  step: number;
};

export type DiscreteNumberParameter = Parameter<number> & {
  values: readonly { value: number; label: string }[];
};

export type OptionsParameter<T> = Parameter<T> & {
  options: { value: T; label: string }[];
};

export type BooleanParameter = Parameter<boolean>;

export type AnyParameter<T> =
  | ContinuousNumberParameter
  | OptionsParameter<T>
  | BooleanParameter
  | DiscreteNumberParameter;

export type FileSettings = {
  bpm: number;
  bandsPerOctave: number;
  zoom: number;
  offset: number;
  playbackStartTime: number; // In seconds
};
