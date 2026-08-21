import { Vector2 } from "three";

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

/** Slider scale a parameter uniform carries so the shader can map a swept knob position back to a value. */
export enum ParameterScaleKind {
  Linear = 0,
  Log = 1,
  LogBipolar = 2,
  Log1p = 3,
}

export type ParameterUniform = {
  value: number;
  /** The knob position, 0–1, that sources sweep on a log slider; unused on a linear one. */
  position: number;
  minValue: number;
  maxValue: number;
  modulationAmounts: number[];
  // Stroke-context and macro contributions, pre-summed on the CPU: weighted sum and total weight.
  staticSum: number;
  staticWeight: number;
  scaleKind: ParameterScaleKind;
  /** Log: natural logs of the slider's ends. LogBipolar and Log1p: log1p of the largest magnitude, then 0. */
  logEnds: Vector2;
};

export type ModulatorParameterUniform = {
  value: number;
  minValue: number;
  maxValue: number;
  modulationAmounts: number[];
  // Stroke-context and macro contributions as an affine map applied after pattern nesting.
  staticScale: number;
  staticOffset: number;
};
