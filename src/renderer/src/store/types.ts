import { FileRendererHandle } from "@renderer/components/file-renderer";
import { Vector2 } from "three";
import { AppState } from "./app";
import { AudioState } from "./audio";
import { EffectsState } from "./effects";
import { FilesState } from "./files";
import { PresetsState } from "./presets";

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

export type ModulatableParameterKey =
  | "brushIntensity"
  | "brushPan"
  | "dynamicsThresholdDb"
  | "dynamicsUpperRatio"
  | "dynamicsLowerRatio"
  | "dynamicsKnee"
  | "dynamicsGainDb"
  | "blurAmountTime"
  | "blurAmountPitch"
  | "blurNoiseTime"
  | "blurNoisePitch"
  | "sharpenAmountTime"
  | "sharpenAmountPitch"
  | "harmonicsPower"
  | "harmonicsFalloff"
  | "transformShiftBeats"
  | "transformShiftSemis"
  | "transformScaleTime"
  | "transformScalePitch"
  | "transformRotation";

export type ModulatorAmountParameters = {
  [K in ModulatableParameterKey as `${K}Mod${Range<1, 4>}Amount`]: NumberParameter;
};

export type ModulatorParameters = {
  [K in Range<1, 4> as `modulator${K}Mode`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}PatternShape`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateBeats`]: NumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateSemis`]: NumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRadial`]: BooleanParameter;
} & {
  [K in Range<1, 4> as `modulator${K}Strength`]: NumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}Rotation`]: NumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}ImagePath`]: string | null;
} & {
  [K in Range<1, 4> as `setModulator${K}ImagePath`]: (path: string | null) => void;
} & {
  [K in Range<1, 4> as `modulator${K}PhaseMode`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMinDb`]: NumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMaxDb`]: NumberParameter;
};

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

// Slice state interfaces
export interface BrushState {
  brushIntensity: NumberParameter;
  brushIterations: NumberParameter;
  brushPan: NumberParameter;
  brushFeatherTime: NumberParameter;
  brushFeatherPitch: NumberParameter;
  brushFeatherSlopeTime: NumberParameter;
  brushFeatherSlopePitch: NumberParameter;
  sourcePosition: { beats: number; pitch: number; fileId: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) => void;
  sourcePositionMode: OptionsParameter<string>;
  isSettingPosition: boolean;
  setIsSettingPosition: (value: boolean) => void;
  brushStartPosition: { beats: number; pitch: number } | null;
  setBrushStartPosition: (position: { beats: number; pitch: number } | null) => void;
  lockedOffset: { beats: number; pitch: number } | null;
  setLockedOffset: (offset: { beats: number; pitch: number } | null) => void;
  brushWidthBeats: NumberParameter;
  brushHeightSemis: NumberParameter;
  brushSizeLockedToGrid: BooleanParameter;
  brushWrapMode: OptionsParameter<number>;
  blendMode: OptionsParameter<number>;
  algorithm: OptionsParameter<number>;
}

export interface ModulatorsState extends ModulatorAmountParameters, ModulatorParameters {}

export type PlayerClock = {
  startAt: number | null; // Tone.now() when (re)started
  startOffset: number; // seconds into buffer at (re)start
  loopStart: number; // active loop start
  loopEnd: number; // active loop end
};

export type State = BrushState & EffectsState & ModulatorsState & FilesState & AudioState & AppState & PresetsState;

// Helper type to extract parameter keys from state
export type ParameterKey = keyof {
  [K in keyof State as State[K] extends { value: unknown } ? K : never]: State[K];
};

// Extract the base parameter type (without setValue/resetValue/modulatorParamKeys)
export type BaseParameterType<K extends ParameterKey> = State[K] extends NumberParameter
  ? Omit<NumberParameter, "setValue" | "resetValue" | "modulatorParamKeys">
  : State[K] extends OptionsParameter<infer T>
    ? Omit<OptionsParameter<T>, "setValue" | "resetValue" | "modulatorParamKeys">
    : State[K] extends BooleanParameter
      ? Omit<BooleanParameter, "setValue" | "resetValue" | "modulatorParamKeys">
      : never;

export type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;
export type ZustandGet = () => State;
