import type { FileRendererHandle } from "@renderer/components/file-renderer";
import type { Vector2 } from "three";
import type { AppState } from "./app";
import type { AudioState } from "./audio";
import type { BrushState } from "./brush";
import type { EffectsState } from "./effects";
import type { FilesState } from "./files";
import { ModulatorsState } from "./modulators";
import type { PresetsState } from "./presets";

export type SliderScale = "linear" | "log" | "logBipolar";

export type SliderMark = { value: number; label: string };

export interface Normalizable<T = number> {
  toNormalized: (value?: T) => number;
  fromNormalized: (normalized: number) => T;
}

export interface NumberParameter extends Normalizable<number> {
  name: string;
  label: string;
  description?: string;
  value: number;
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;

  scale?: SliderScale;
  marks?: SliderMark[];
  leftValue?: SliderMark;
  rightValue?: SliderMark;
  setValue: (v: number) => void;
  resetValue: () => void;

  modulatorParamKeys?: (keyof ModulatorAmountParameters)[];

  includeInPresets: boolean;
}

export interface BooleanParameter extends Normalizable<boolean> {
  name: string;
  label: string;
  description?: string;
  value: boolean;
  default: boolean;
  setValue: (v: boolean) => void;
  resetValue: () => void;

  includeInPresets: boolean;
}

export interface OptionsParameter<T = string> {
  name: string;
  label: string;
  description?: string;
  value: T;
  default: T;
  options: { value: T; label: string }[];
  setValue: (v: T) => void;
  resetValue: () => void;

  includeInPresets: boolean;
}

export type Parameter<T> = T extends boolean
  ? BooleanParameter
  : T extends number
    ? NumberParameter
    : T extends string
      ? OptionsParameter<string>
      : OptionsParameter<T>;

export type FileSettings = {
  bpm: number;
  bandsPerOctave: number;
  zoom: number;
  offset: number;
  playbackStartTime: number;
};

export type SpectrogramData = {
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
  synthesisMetadata: {
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
};

export type OpenFile = {
  id: string;
  filePath: string;
  spectrogramData: SpectrogramData;
  audioBuffer?: AudioBuffer;
  rendererRef?: React.RefObject<FileRendererHandle | null>;
};

export type PlayerClock = {
  startAt: number | null; // Tone.now() when (re)started
  startOffset: number; // seconds into buffer at (re)start
  loopStart: number; // active loop start
  loopEnd: number; // active loop end
};

export type State = BrushState &
  EffectsState &
  ModulatorsState &
  FilesState &
  AudioState &
  AppState &
  PresetsState & {
    setParameter: (key: ParameterKey, value: any) => void;
  };

// Helper type to extract parameter keys from state
export type ParameterKey = keyof State;

export type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;
export type ZustandGet = () => State;
