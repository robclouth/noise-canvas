import { Vector2 } from "three";
import * as Tone from "tone";
import { EffectType } from "../effects";
import { BrushPresetType } from "../lib/preset-schema";

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
}

export interface BooleanParameter extends Normalizable<boolean> {
  name: string;
  label: string;
  description?: string;
  value: boolean;
  setValue: (v: boolean) => void;
  resetValue: () => void;
}

export interface OptionsParameter<T = string> {
  name: string;
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  setValue: (v: T) => void;
  resetValue: () => void;
}

export type AnyParameter<T> = NumberParameter | OptionsParameter<T> | BooleanParameter;

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
  rendererRef?: React.RefObject<any>;
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
}

export interface EffectsState {
  dynamicsThresholdDb: NumberParameter;
  dynamicsUpperRatio: NumberParameter;
  dynamicsLowerRatio: NumberParameter;
  dynamicsKnee: NumberParameter;
  dynamicsGainDb: NumberParameter;
  transformShiftBeats: NumberParameter;
  transformShiftSemis: NumberParameter;
  transformScaleTime: NumberParameter;
  transformScalePitch: NumberParameter;
  transformRotation: NumberParameter;
  transformEdgeMode: OptionsParameter<number>;
  synthesizeBrushType: OptionsParameter<number>;
  blurAmountTime: NumberParameter;
  blurAmountPitch: NumberParameter;
  blurNoiseTime: NumberParameter;
  blurNoisePitch: NumberParameter;
  blurBleed: BooleanParameter;
  blurOrigin: OptionsParameter<number>;
  sharpenAmountTime: NumberParameter;
  sharpenAmountPitch: NumberParameter;
  harmonicsPower: NumberParameter;
  harmonicsFalloff: NumberParameter;
  effectOrder: EffectType[];
  setEffectOrder: (effectOrder: EffectType[]) => void;
  effectsEnabled: Record<EffectType, boolean>;
  setEffectEnabled: (effect: EffectType, enabled: boolean) => void;
}

export interface ModulatorsState extends ModulatorAmountParameters, ModulatorParameters {}

export interface FilesState {
  openFileIds: string[];
  openFilePath: (filePath: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
  saveActiveFileAs: () => Promise<void>;
  saveActiveFileVersion: () => Promise<void>;
  closeFile: (fileId: string) => void;
  closeAllFiles: () => void;
  reanalyzeActiveFile: () => Promise<void>;
  synthesizeFile: (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
  ) => Promise<void>;
  fileSettings: Record<string, FileSettings>;
  getFileSettings: (fileId: string) => FileSettings | null;
  setFileBpm: (fileId: string, bpm: number) => void;
  setFileResolution: (fileId: string, resolution: number) => void;
  setFileZoomAndOffset: (fileId: string, zoom: number, offset: number) => void;
  setFileZoom: (fileId: string, zoom: number) => void;
  setFileOffset: (fileId: string, offset: number) => void;
  filesDirty: Record<string, boolean>;
  setFileDirty: (fileId: string, dirty: boolean) => void;
  activeFileId: string | null;
  setActiveFileId: (activeFileId: string | null) => Promise<void>;
  sourceFile: { id: string; mode: "current" | "original" } | null;
  setSourceFile: (sourceFile: { id: string; mode: "current" | "original" } | null) => void;
}

export type PlayerClock = {
  startAt: number | null; // Tone.now() when (re)started
  startOffset: number; // seconds into buffer at (re)start
  loopStart: number; // active loop start
  loopEnd: number; // active loop end
};

export interface AudioState {
  playerClock: PlayerClock;
  player: Tone.Player | null;
  getPlaybackTime: () => number;
  getPlayer: () => Tone.Player;
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  autoPlayStroke: boolean;
  setAutoPlayStroke: (value: boolean) => void;
  autoPlayEndTime: number | null;
  setAutoPlayEndTime: (time: number | null) => void;
  setPlaybackTime: (playbackTime: number) => void;
  setFilePlaybackStartTime: (fileId: string, time: number) => void;
  togglePlayback: () => Promise<void>;
  stopAudio: () => void;
}

export interface DisplayState {
  displayMinDb: NumberParameter;
  displayMaxDb: NumberParameter;
  magnitudeLimit: NumberParameter;
  gridSizeBeats: NumberParameter;
  gridSizeSemis: NumberParameter;
  normalize: BooleanParameter;
  scaleTonic: OptionsParameter<string>;
  scaleType: OptionsParameter<string>;
  bandsPerOctave: OptionsParameter<number>;
  minFreq: NumberParameter;
  blendMode: OptionsParameter<number>;
  algorithm: OptionsParameter<number>;
  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (section: string, collapsed: boolean) => void;
}

export interface PresetsState {
  currentPresetId: string | null;
  availablePresets: BrushPresetType[];
  setCurrentPresetId: (presetId: string | null) => void;
  loadPresets: () => Promise<void>;
  loadPreset: (presetId: string) => void;
  savePreset: (name: string, presetId?: string) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  assignHotkeyToPreset: (presetId: string, hotkey: string) => void;
  presetHotkeys: Record<string, string>;
}

export type State = BrushState & EffectsState & ModulatorsState & FilesState & AudioState & DisplayState & PresetsState;

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
