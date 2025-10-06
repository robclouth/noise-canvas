import { deepMerge } from "@mantine/core";
import { modals } from "@mantine/modals";
import { produce } from "immer";
import { startCase } from "lodash-es";
import { Vector2 } from "three";
import { ScaleType } from "tonal";
import * as Tone from "tone";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import {
  BEAT_VALUES,
  BLEND_MODES,
  EDGE_MODE,
  MODULATOR_MODES,
  MULTIPLIER_VALUES,
  NUM_MODULATORS,
  PATTERN_SHAPES,
  PITCH_VALUES,
  PITCH_VALUES_NO_FRACTIONS,
  SYNTHESIZE_TYPES,
} from "./lib/constants";
import { getPresetManager } from "./lib/preset-manager";
import { BrushPreset, defaultPresets, PRESET_KEYS } from "./lib/presets";
import { getUndoManager } from "./lib/undo-manager";
import { Parameter } from "./Parameter";
import {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  OpenFile,
  OptionsParameter,
} from "./types";

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

type ModulatableParameterKey =
  | "brushIntensity"
  | "brushPan"
  | "gainDb"
  | "blurAmountTime"
  | "blurAmountPitch"
  | "blurNoiseTime"
  | "blurNoisePitch"
  | "sharpenAmountTime"
  | "sharpenAmountPitch"
  | "harmonicsPower"
  | "harmonicsFalloff"
  | "harmonicsOddEven"
  | "transformShiftBeats"
  | "transformShiftSemis"
  | "transformScaleTime"
  | "transformScalePitch"
  | "transformRotation";

type ModulatorAmountParameters = {
  [K in ModulatableParameterKey as `${K}Mod${Range<1, 4>}Amount`]: ContinuousNumberParameter;
};

type ModulatorParameters = {
  [K in Range<1, 4> as `modulator${K}Mode`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}PatternShape`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateBeats`]: DiscreteNumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRateSemis`]: DiscreteNumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}PatternRadial`]: BooleanParameter;
} & {
  [K in Range<1, 4> as `modulator${K}Strength`]: ContinuousNumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}Rotation`]: ContinuousNumberParameter;
};

const persistedKeys: (keyof State)[] = [
  "filesBpm",
  "filesResolution",
  "effectOrder",
  "effectsEnabled",
  "sectionCollapsed",
];

export type State = {
  // Brush Parameters
  brushIntensity: ContinuousNumberParameter;
  brushIterations: ContinuousNumberParameter;
  brushPan: ContinuousNumberParameter;
  brushFeatherTime: ContinuousNumberParameter;
  brushFeatherPitch: ContinuousNumberParameter;
  brushFeatherSlopeTime: ContinuousNumberParameter;
  brushFeatherSlopePitch: ContinuousNumberParameter;

  // Source Position
  sourcePosition: { beats: number; pitch: number; filePath: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; filePath: string } | null) => void;
  sourcePositionMode: OptionsParameter<string>;
  isSettingPosition: boolean;
  setIsSettingPosition: (value: boolean) => void;
  brushStartPosition: { beats: number; pitch: number } | null;
  setBrushStartPosition: (position: { beats: number; pitch: number } | null) => void;
  lockedOffset: { beats: number; pitch: number } | null;
  setLockedOffset: (offset: { beats: number; pitch: number } | null) => void;

  // Brush Options
  brushWidthBeats: DiscreteNumberParameter; // in beats
  brushHeightSemis: DiscreteNumberParameter; // in semitones
  brushSizeLockedToGrid: BooleanParameter;

  // Effect Order and Enabled States
  effectOrder: string[];
  setEffectOrder: (effectOrder: string[]) => void;
  effectsEnabled: Record<string, boolean>;
  setEffectEnabled: (effect: string, enabled: boolean) => void;

  // Section Collapse States
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (section: string, collapsed: boolean) => void;

  // View Controls
  zoomPower: ContinuousNumberParameter;
  scroll: ContinuousNumberParameter;

  // Grid and Snapping
  gridSizeBeats: DiscreteNumberParameter; // in beats
  gridSizeSemis: DiscreteNumberParameter; // in semitones

  // Settings
  normalize: BooleanParameter;
  scaleTonic: OptionsParameter<string>;
  scaleType: OptionsParameter<string>;
  bandsPerOctave: OptionsParameter<number>;
  minFreq: ContinuousNumberParameter;
  blendMode: OptionsParameter<number>;

  // Gain Brush
  gainDb: ContinuousNumberParameter;

  // Transform Brush
  transformShiftBeats: DiscreteNumberParameter;
  transformShiftSemis: DiscreteNumberParameter;
  transformScaleTime: DiscreteNumberParameter;
  transformScalePitch: DiscreteNumberParameter;
  transformRotation: ContinuousNumberParameter;
  transformEdgeMode: OptionsParameter<number>;

  // Synthesize Brush
  synthesizeBrushType: OptionsParameter<number>;

  // Blur Brush
  blurAmountTime: ContinuousNumberParameter;
  blurAmountPitch: ContinuousNumberParameter;
  blurNoiseTime: ContinuousNumberParameter;
  blurNoisePitch: ContinuousNumberParameter;
  blurBleed: BooleanParameter;

  // Sharpen Brush
  sharpenAmountTime: ContinuousNumberParameter;
  sharpenAmountPitch: ContinuousNumberParameter;

  // Harmonics Brush
  harmonicsPower: ContinuousNumberParameter;
  harmonicsFalloff: ContinuousNumberParameter;
  harmonicsOddEven: ContinuousNumberParameter;

  // UI State
  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFilePath: string | null;
  setHoveredFilePath: (filePath: string | null) => void;

  // Files
  openFilePaths: string[];
  openFilePath: (filePath: string) => Promise<void>;
  saveActiveFile: () => void;
  closeFilePath: (filePath: string) => void;
  closeAllFilePaths: () => void;
  reanalyzeActiveFile: () => Promise<void>;
  synthesizeFilePath: (filePath: string) => Promise<void>;
  audioBuffers: Record<string, AudioBuffer>;
  setAudioBuffers: (audioBuffers: Record<string, AudioBuffer>) => void;
  filesBpm: Record<string, number>;
  setFileBpm: (filePath: string, bpm: number | undefined) => void;
  filesResolution: Record<string, number>;
  setFileResolution: (filePath: string, resolution: number) => void;
  activeFilePath: string | null;
  setActiveFilePath: (activeFilePath: string | null) => void;
  sourceFile: { path: string; mode: "current" | "original" } | null;
  setSourceFile: (sourceFile: { path: string; mode: "current" | "original" } | null) => void;

  // Audio Playback
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  playbackTime: number;
  setPlaybackTime: (playbackTime: number) => void;
  togglePlayback: () => Promise<void>;
  stopAudio: () => void;
} & ModulatorAmountParameters &
  ModulatorParameters & {
    // Presets
    currentPresetId: string | null;
    availablePresets: BrushPreset[];
    setCurrentPresetId: (presetId: string | null) => void;
    loadPresets: () => Promise<void>;
    loadPreset: (presetId: string) => void;
    savePreset: (name: string, presetId?: string) => Promise<void>;
    deletePreset: (presetId: string) => Promise<void>;
  };

// Helper type to extract keys of state that are parameters
export type ParameterKey = keyof {
  [K in keyof State as State[K] extends { value: unknown } ? K : never]: State[K];
};

type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;

// Extract the base parameter type (without setValue/resetValue/modulatorParamKeys)
type BaseParameterType<K extends ParameterKey> = State[K] extends ContinuousNumberParameter
  ? Omit<ContinuousNumberParameter, "setValue" | "resetValue" | "modulatorParamKeys">
  : State[K] extends DiscreteNumberParameter
    ? Omit<DiscreteNumberParameter, "setValue" | "resetValue" | "modulatorParamKeys">
    : State[K] extends OptionsParameter<infer T>
      ? Omit<OptionsParameter<T>, "setValue" | "resetValue" | "modulatorParamKeys">
      : State[K] extends BooleanParameter
        ? Omit<BooleanParameter, "setValue" | "resetValue" | "modulatorParamKeys">
        : never;

// Internal helper for creating parameters without type constraints (used for dynamic modulator params)
function createParameterInternal<T extends { value: unknown }>(
  set: ZustandSet,
  key: string,
  parameter: T,
  modulatable: boolean,
) {
  let params = {
    [key]: {
      ...parameter,
      setValue: (value: T["value"]) => set((state) => ({ [key]: { ...state[key], value } })),
      resetValue: () => set((state) => ({ [key]: { ...state[key], value: parameter.value } })),
      modulatorParamKeys: modulatable
        ? Array.from({ length: NUM_MODULATORS }).map(
            (_, i) => `${key}Mod${i + 1}Amount` as keyof ModulatorAmountParameters,
          )
        : undefined,
    },
  };

  if (modulatable) {
    params = {
      ...params,
      ...createModulatorParamsForParameter(set, key),
    };
  }

  return params;
}

// Type-safe createParameter that enforces the parameter structure matches the State type
function createParameter<K extends ParameterKey>(
  set: ZustandSet,
  key: K,
  parameter: BaseParameterType<K>,
  modulatable: boolean,
) {
  return createParameterInternal(set, key as string, parameter as any, modulatable) as any;
}

function createModulatorParamsForParameter(set: ZustandSet, key: string) {
  let params = {} as any;
  for (let i = 0; i < NUM_MODULATORS; i++) {
    const paramKey = `${key}Mod${i + 1}Amount`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Mod ${i + 1} Amount`,
          label: `Mod ${i + 1}`,
          value: 0,
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
          description:
            "The amount of modulation to apply. 0% is no modulation and only the value of the parameter is used, 100% is full modulation and the current value of the modulated parameter is ignored.",
        },
        false,
      ),
    };
  }
  return params;
}

function createModulatorParams(set: ZustandSet): ModulatorParameters {
  let params = {} as any;
  for (let i = 0; i < NUM_MODULATORS; i++) {
    let paramKey = `modulator${i + 1}Mode`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Mode ${i + 1}`,
          label: "Mode",
          description: "The mode of the modulator.",
          value: 0,
          options: MODULATOR_MODES,
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}PatternShape`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Shape ${i + 1}`,
          label: "Shape",
          description: "The shape of the modulator pattern.",
          value: 0,
          options: PATTERN_SHAPES,
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}Strength`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Strength ${i + 1}`,
          label: "Strength",
          description: "The strength of the modulator.",
          value: 100,
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}PatternRateBeats`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Rate Beats ${i + 1}`,
          label: "Rate H",
          description: "The rate of the modulator pattern.",
          value: 1,
          values: [{ value: 0, label: "Off" }, ...BEAT_VALUES].map((value) => ({
            value: value.value,
            label: value.label,
          })),
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}PatternRateSemis`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Rate Semis ${i + 1}`,
          label: "Rate V",
          description: "The rate of the modulator pattern.",
          value: 12,
          values: [{ value: 0, label: "Off" }, ...PITCH_VALUES].map((value) => ({
            value: value.value,
            label: value.label,
          })),
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}Rotation`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Rotation ${i + 1}`,
          label: "Rotation",
          description: "The rotation of the modulator pattern.",
          value: 0,
          min: 0,
          max: 360,
          step: 1,
          unit: "°",
        },
        true,
      ),
    };
  }
  return params;
}

export const openFiles: Record<string, OpenFile> = {};

export const player = new Tone.Player().toDestination();

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => {
        const initialState = {
          ...createParameter(
            set,
            "brushIntensity",
            {
              name: "Brush Intensity",
              label: "Amount",
              description: "Controls the strength of the brush.",
              value: 100,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },

            true,
          ),
          ...createParameter(
            set,
            "brushIterations",
            {
              name: "Brush Iterations",
              label: "Iterations",
              description: "How many times to apply the brush effect.",
              value: 1,
              min: 1,
              max: 20,
              step: 1,
            },
            false,
          ),
          ...createParameter(
            set,
            "brushPan",
            {
              name: "Pan",
              label: "Pan",
              description: "Pans the brush effect left or right.",
              value: 0.0,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "brushFeatherTime",
            {
              name: "Feather Time",
              label: "Amount H",
              description: "Softens the brush effect at the edges of the time selection.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },

            false,
          ),
          ...createParameter(
            set,
            "brushFeatherPitch",
            {
              name: "Feather Pitch",
              label: "Amount V",
              description: "Softens the brush effect at the edges of the pitch selection.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            false,
          ),
          ...createParameter(
            set,
            "brushFeatherSlopeTime",
            {
              name: "Feather Slope Time",
              label: "Slope H",
              description:
                "Controls the slope of the time feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
              value: 0,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
            },
            false,
          ),
          ...createParameter(
            set,
            "brushFeatherSlopePitch",
            {
              name: "Feather Slope Pitch",
              label: "Slope V",
              description:
                "Controls the slope of the pitch feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
              value: 0,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
            },

            false,
          ),
          // Source Position
          sourcePosition: null,
          setSourcePosition: (position: { beats: number; pitch: number; filePath: string } | null) =>
            set({ sourcePosition: position, lockedOffset: null }),
          ...createParameter(
            set,
            "sourcePositionMode",
            {
              name: "Source Position Mode",
              label: "Mode",
              description: "How the source position is used when painting.",
              value: "anchored" as string,
              options: [
                { value: "fixed", label: "Fixed" },
                { value: "anchored", label: "Anchored" },
                { value: "offset", label: "Offset" },
              ],
            },
            false,
          ),
          isSettingPosition: false,
          setIsSettingPosition: (value: boolean) => set({ isSettingPosition: value }),
          brushStartPosition: null,
          setBrushStartPosition: (position: { beats: number; pitch: number } | null) =>
            set({ brushStartPosition: position }),
          lockedOffset: null,
          setLockedOffset: (offset: { beats: number; pitch: number } | null) => set({ lockedOffset: offset }),
          ...createParameter(
            set,
            "brushWidthBeats",
            {
              name: "Brush Width",
              label: "Width",
              description: "The width of the brush in beats.",
              value: 1,
              values: [...BEAT_VALUES, { value: 0, label: "Full" }].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },
            false,
          ),
          ...createParameter(
            set,
            "brushHeightSemis",
            {
              name: "Brush Height",
              label: "Height",
              description: "The height of the brush in semitones.",
              value: 12,
              values: [...PITCH_VALUES_NO_FRACTIONS, { value: 0, label: "Full" }].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },
            false,
          ),
          ...createParameter(
            set,
            "brushSizeLockedToGrid",
            {
              name: "Lock Brush Size to Grid",
              label: "Grid",
              description: "Locks the brush size to the grid size.",
              value: false as boolean,
            },

            false,
          ),
          ...createParameter(
            set,
            "zoomPower",
            {
              name: "Zoom",
              label: "Zoom",
              description: "Controls the zoom level of the spectrogram.",
              value: 0,
              min: -10,
              max: 10,
              step: 1,
            },
            false,
          ),
          ...createParameter(
            set,
            "scroll",
            {
              name: "Scroll",
              label: "Scroll",
              description: "Scrolls the spectrogram horizontally.",
              value: 0,
              min: 0,
              max: 1,
              step: 0.01,
            },
            false,
          ),
          ...createParameter(
            set,
            "gridSizeBeats",
            {
              name: "Grid Size Beats",
              label: "Beats",
              description: "The horizontal grid size in beats.",
              value: 1,
              values: [{ value: 0, label: "Off" }, ...BEAT_VALUES].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },

            false,
          ),
          ...createParameter(
            set,
            "gridSizeSemis",
            {
              name: "Grid Size Semis",
              label: "Semis",
              description: "The vertical grid size in semitones.",
              value: 24,
              values: [{ value: 0, label: "Off" }, ...PITCH_VALUES].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },
            false,
          ),
          ...createParameter(
            set,
            "normalize",
            {
              name: "Normalize",
              label: "Normalize",
              description: "Normalizes the audio output.",
              value: true as boolean,
            },

            false,
          ),
          ...createParameter(
            set,
            "scaleTonic",
            {
              name: "Scale Tonic",
              label: "Tonic",
              description: "The root note of the scale.",
              value: "C",
              options: [
                { value: "C", label: "C" },
                { value: "C#", label: "C#" },
                { value: "D", label: "D" },
                { value: "D#", label: "D#" },
                { value: "E", label: "E" },
                { value: "F", label: "F" },
                { value: "F#", label: "F#" },
                { value: "G", label: "G" },
                { value: "G#", label: "G#" },
                { value: "A", label: "A" },
                { value: "A#", label: "A#" },
                { value: "B", label: "B" },
              ],
            },
            false,
          ),
          ...createParameter(
            set,
            "scaleType",
            {
              name: "Scale Type",
              label: "Type",
              description: "The type of scale to use.",
              value: "major",
              options: ScaleType.all().map(({ name }) => ({
                value: name,
                label: startCase(name),
              })),
            },
            false,
          ),
          ...createParameter(
            set,
            "bandsPerOctave",
            {
              name: "Resolution Mode",
              label: "Resolution",
              description:
                "Balance between time and frequency resolution. Time resolution gives sharper transients, frequency resolution gives more precise pitch detail.",
              value: 36,
              options: [
                { value: 12, label: "Best Time" },
                { value: 24, label: "Better Time" },
                { value: 36, label: "Balanced" },
                { value: 48, label: "Better Pitch" },
                { value: 60, label: "Best Pitch" },
              ],
            },
            false,
          ),
          ...createParameter(
            set,
            "minFreq",
            {
              name: "Minimum Frequency",
              label: "Min. Freq.",
              description: "The minimum frequency of the spectrogram.",
              value: 16.3516, // C0
              min: 10,
              max: 100,
              step: 0.01,
              unit: "Hz",
            },
            false,
          ),
          ...createParameter(
            set,
            "blendMode",
            {
              name: "Blend Mode",
              label: "Blend",
              description: "The blend mode to use when applying the brush.",
              value: 0,
              options: BLEND_MODES,
            },
            false,
          ),
          ...createParameter(
            set,
            "gainDb",
            {
              name: "Gain",
              label: "Gain",
              description: "The amount of gain to apply in decibels.",
              value: 0.0,
              min: -24,
              max: 24,
              step: 0.1,
              unit: "dB",
            },
            true,
          ),
          ...createParameter(
            set,
            "blurAmountTime",
            {
              name: "Blur Amount Time",
              label: "Blur H",
              description: "The amount of blur to apply over time.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "blurAmountPitch",
            {
              name: "Blur Amount Pitch",
              label: "Blur V",
              description: "The amount of blur to apply over pitch.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "blurNoiseTime",
            {
              name: "Blur Noise Time",
              label: "Noise H",
              description: "The amount of noise to apply over time.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "blurNoisePitch",
            {
              name: "Blur Noise Pitch",
              label: "Noise V",
              description: "The amount of noise to apply over pitch.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "blurBleed",
            {
              name: "Blur Bleed",
              label: "Bleed",
              description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
              value: true as boolean,
            },
            false,
          ),
          ...createParameter(
            set,
            "sharpenAmountTime",
            {
              name: "Sharpen Time",
              label: "Sharpen H",
              description: "The amount of sharpening to apply over time.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },

            true,
          ),
          ...createParameter(
            set,
            "sharpenAmountPitch",
            {
              name: "Sharpen Pitch",
              label: "Sharpen V",
              description: "The amount of sharpening to apply over pitch.",
              value: 0,
              min: 0,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "harmonicsPower",
            {
              name: "Harmonic Power",
              label: "Power",
              description: "Controls the spacing of harmonics.",
              value: 1.0,
              min: 0.1,
              max: 4.0,
              step: 0.01,
            },

            true,
          ),
          ...createParameter(
            set,
            "harmonicsFalloff",
            {
              name: "Harmonic Falloff",
              label: "Falloff",
              description: "Controls the amplitude falloff of harmonics.",
              value: 10.0,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "harmonicsOddEven",
            {
              name: "Odd/Even Harmonics",
              label: "Odd/Even",
              description: "Controls the balance of odd and even harmonics.",
              value: 0,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
            },
            true,
          ),
          ...createParameter(
            set,
            "transformShiftBeats",
            {
              name: "Shift Beats",
              label: "Shift H",
              description: "Shifts the content horizontally by a number of beats.",
              value: 0,
              values: [
                ...BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
                { label: "0 beats", value: 0 },
                ...BEAT_VALUES,
              ],
            },
            true,
          ),
          ...createParameter(
            set,
            "transformShiftSemis",
            {
              name: "Shift Semis",
              label: "Shift V",
              description: "Shifts the content vertically by a number of semitones.",
              value: 0.0,
              values: [
                ...PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
                { label: "0 semis", value: 0 },
                ...PITCH_VALUES,
              ],
            },
            true,
          ),
          ...createParameter(
            set,
            "transformScaleTime",
            {
              name: "Scale Time",
              label: "Scale H",
              description: "Scales the content horizontally.",
              value: 1.0,
              values: [
                ...MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
                ...MULTIPLIER_VALUES,
              ],
            },
            true,
          ),
          ...createParameter(
            set,
            "transformScalePitch",
            {
              name: "Scale Pitch",
              label: "Scale V",
              description: "Scales the content vertically.",
              value: 1.0,
              values: [
                ...MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
                ...MULTIPLIER_VALUES,
              ],
            },
            true,
          ),
          ...createParameter(
            set,
            "transformRotation",
            {
              name: "Rotation",
              label: "Rotation",
              description: "Rotates the content.",
              value: 0.0,
              min: -180,
              max: 180,
              step: 1,
              unit: "°",
            },

            true,
          ),
          ...createParameter(
            set,
            "transformEdgeMode",
            {
              name: "Edge Mode",
              label: "Edge",
              description: "How to handle edges when transforming.",
              value: 1,
              options: EDGE_MODE,
            },
            false,
          ),
          ...createParameter(
            set,
            "synthesizeBrushType",
            {
              name: "Synthesize Type",
              label: "Type",
              description: "The type of synthesis to use.",
              value: 0,
              options: SYNTHESIZE_TYPES,
            },
            false,
          ),
          ...createModulatorParams(set),
          openFilePaths: [],
          openFilePath: async (filePath: string) => {
            const state = get();
            const fileAlreadyOpen = state.openFilePaths.includes(filePath);
            if (!fileAlreadyOpen) {
              console.log("Starting analysis...");
              const result = await window.audioAnalysis.analyze(filePath, {
                bandsPerOctave: state.bandsPerOctave.value,
                minFreq: state.minFreq.value,
              });
              console.log("Analysis complete:", result);

              const spectrogramData = {
                packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
                inverseMap: new Float32Array(
                  result.inverseMap.buffer,
                  result.inverseMap.byteOffset,
                  result.inverseMap.byteLength / 4,
                ),
                metadata: new Float32Array(
                  result.metadataTexture.buffer,
                  result.metadataTexture.byteOffset,
                  result.metadataTexture.byteLength / 4,
                ),
                textureWidth: result.textureWidth,
                textureHeight: result.textureHeight,
                numFrames: result.numFrames,
                numBands: result.numBands,
                numChannels: result.numChannels,
                sampleRate: result.sampleRate,
                packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
                minFreq: state.minFreq.value,
                bandsPerOctave: state.bandsPerOctave.value,
                synthesisMetadata: {
                  bandOffsets: result.bandOffsets,
                  bandStepLog2s: result.bandStepLog2s,
                  bandLengths: result.bandLengths,
                },
              };
              openFiles[filePath] = {
                filePath,
                spectrogramData,
              };

              console.log(openFiles);

              return set((state) => {
                const newState: Partial<State> = { openFilePaths: [...state.openFilePaths, filePath] };
                if (!state.filesBpm[filePath]) newState.filesBpm = { ...state.filesBpm, [filePath]: 120 };
                if (!state.filesResolution[filePath])
                  newState.filesResolution = { ...state.filesResolution, [filePath]: state.bandsPerOctave.value };
                if (!state.sourceFile) newState.sourceFile = { path: filePath, mode: "current" };
                newState.activeFilePath = filePath;

                return newState;
              });
            }
            return state;
          },
          saveActiveFile: () => {
            const state = get();
            if (!state.activeFilePath) return;
            const file = openFiles[state.activeFilePath];
            if (!file) return;
          },
          closeFilePath: (filePath: string) =>
            set(
              produce((state: State) => {
                const openFile = openFiles[filePath];
                if (openFile) {
                  state.openFilePaths = state.openFilePaths.filter((path) => path !== filePath);
                  delete state.filesBpm[filePath];

                  const nextFilePath = state.openFilePaths[state.openFilePaths.length - 1] || null;
                  state.activeFilePath = nextFilePath || null;

                  // If the file being closed is the source file, set the source file to the next file
                  if (!nextFilePath) state.sourceFile = null;
                  else if (state.sourceFile?.path === filePath) {
                    state.sourceFile = {
                      path: nextFilePath,
                      mode: "current",
                    };
                  }
                }
              }),
            ),
          closeAllFilePaths: () => {
            return set({
              openFilePaths: [],
              filesBpm: {},
              filesResolution: {},
              activeFilePath: null,
              sourceFile: null,
            });
          },
          synthesizeFilePath: async (filePath: string) => {
            const state = get();
            if (!state.activeFilePath) return;

            try {
              const totalStart = performance.now();
              console.log("runSynthesis");
              const { normalize, bandsPerOctave, minFreq, isPlaying } = useStore.getState();
              const file = openFiles[filePath];
              if (!file || !file.rendererRef?.current) {
                return;
              }

              const originalAnalysis = file.spectrogramData;

              // Assemble the payload for the main process
              const fboData = await file.rendererRef.current.getFBOData();
              const payload = {
                processedData: fboData.buffer,
                analysisMetadata: {
                  numFrames: originalAnalysis.numFrames,
                  numChannels: originalAnalysis.numChannels,
                  numBands: originalAnalysis.numBands,
                  ...originalAnalysis.synthesisMetadata,
                },
              };

              const analysisParams = {
                bandsPerOctave: bandsPerOctave.value,
                minFreq: minFreq.value,
              };

              const synthesisStart = performance.now();
              // Use direct gaborator API (no IPC transfer)
              if (!window.audioAnalysis) {
                throw new Error("Direct gaborator API not available. Make sure contextIsolation is disabled.");
              }

              const processedDataArray = new Float32Array(
                payload.processedData,
                0,
                payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
              );

              const audioBufferChannels = await window.audioAnalysis.synthesize(
                processedDataArray,
                payload.analysisMetadata,
                originalAnalysis.sampleRate,
                analysisParams,
                normalize.value,
              );
              const synthesisTime = performance.now() - synthesisStart;
              console.log("Direct synthesis took:", synthesisTime.toFixed(2), "ms");

              if (audioBufferChannels.length === 0) {
                throw new Error("Synthesis returned no audio channels.");
              }

              const numChannels = audioBufferChannels.length;
              const numFrames = audioBufferChannels[0].length;

              const audioContext = Tone.getContext().rawContext;
              const audioBuffer = audioContext.createBuffer(numChannels, numFrames, originalAnalysis.sampleRate);

              // Copy channels in a non-blocking way using async iteration
              const copyStart = performance.now();
              await new Promise<void>((resolve) => {
                let channelIndex = 0;

                const copyNextChannel = () => {
                  if (channelIndex < numChannels) {
                    // Convert Buffer to Float32Array efficiently
                    const channelBuffer = audioBufferChannels[channelIndex] as any;
                    let channelData: Float32Array;

                    if (channelBuffer instanceof Float32Array) {
                      channelData = channelBuffer;
                    } else if (ArrayBuffer.isView(channelBuffer)) {
                      // It's a Buffer or typed array view - create a view without copying
                      channelData = new Float32Array(
                        channelBuffer.buffer as ArrayBuffer,
                        channelBuffer.byteOffset as number,
                        (channelBuffer.byteLength as number) / Float32Array.BYTES_PER_ELEMENT,
                      );
                    } else {
                      // Fallback for plain array
                      channelData = new Float32Array(channelBuffer);
                    }

                    audioBuffer.copyToChannel(channelData as Float32Array<ArrayBuffer>, channelIndex);
                    channelIndex++;

                    // Yield to the event loop between channels
                    setTimeout(copyNextChannel, 0);
                  } else {
                    resolve();
                  }
                };

                copyNextChannel();
              });
              const copyTime = performance.now() - copyStart;
              console.log("Channel copy took:", copyTime.toFixed(2), "ms");

              file.audioBuffer = audioBuffer;

              if (isPlaying && state.activeFilePath && state.activeFilePath === filePath) {
                const transport = Tone.getTransport();
                transport.cancel(0);
                player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
                player.seek(transport.seconds);
              }

              const totalTime = performance.now() - totalStart;
              console.log("Total synthesis took:", totalTime.toFixed(2), "ms");
            } catch (error) {
              console.error("Error running synthesis:", error);
            }
          },
          reanalyzeActiveFile: () => {
            const state = get();
            if (!state.activeFilePath) return;
            const file = openFiles[state.activeFilePath];

            modals.openConfirmModal({
              title: "Re-analyze File",
              children: `This will re-analyze the file with the new settings. All edits will be lost.`,
              labels: { confirm: "Re-analyze", cancel: "Cancel" },
              confirmProps: { color: "red", size: "xs" },
              cancelProps: { size: "xs" },
              styles: {
                title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
                body: { fontSize: "var(--mantine-font-size-sm)" },
              },
              onConfirm: async () => {
                if (!state.activeFilePath) return;

                const result = await window.audioAnalysis.analyze(state.activeFilePath, {
                  bandsPerOctave: state.bandsPerOctave.value,
                  minFreq: state.minFreq.value,
                });

                const spectrogramData = {
                  packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
                  inverseMap: new Float32Array(
                    result.inverseMap.buffer,
                    result.inverseMap.byteOffset,
                    result.inverseMap.byteLength / 4,
                  ),
                  metadata: new Float32Array(
                    result.metadataTexture.buffer,
                    result.metadataTexture.byteOffset,
                    result.metadataTexture.byteLength / 4,
                  ),
                  textureWidth: result.textureWidth,
                  textureHeight: result.textureHeight,
                  numFrames: result.numFrames,
                  numBands: result.numBands,
                  numChannels: result.numChannels,
                  sampleRate: result.sampleRate,
                  packedTextureSize: new Vector2(result.textureWidth, result.textureHeight),
                  minFreq: state.minFreq.value,
                  bandsPerOctave: state.bandsPerOctave.value,
                  synthesisMetadata: {
                    bandOffsets: result.bandOffsets,
                    bandStepLog2s: result.bandStepLog2s,
                    bandLengths: result.bandLengths,
                  },
                };

                file.spectrogramData = spectrogramData;

                file.rendererRef?.current?.reloadTextures();

                const undoManager = getUndoManager(state.activeFilePath);
                undoManager.clear();

                return set({
                  filesResolution: { ...state.filesResolution, [state.activeFilePath]: state.bandsPerOctave.value },
                });
              },
            });
          },
          audioBuffers: {},
          setAudioBuffers: (audioBuffers) => set({ audioBuffers }),
          filesBpm: {},
          setFileBpm: (filePath, bpm) =>
            set(
              produce((state: State) => {
                if (bpm) {
                  state.filesBpm[filePath] = bpm;
                } else {
                  delete state.filesBpm[filePath];
                }
              }),
            ),
          filesResolution: {},
          setFileResolution: (filePath, resolution) =>
            set((state) => {
              const newFilesResolution = { ...state.filesResolution };
              newFilesResolution[filePath] = resolution;
              return { filesResolution: newFilesResolution };
            }),
          activeFilePath: null,
          setActiveFilePath: (activeFilePath) => set({ activeFilePath }),
          sourceFile: null,
          setSourceFile: (sourceFile) => set({ sourceFile }),
          togglePlayback: async () => {
            const { isPlaying, activeFilePath, loop } = get();
            if (isPlaying) {
              const transport = Tone.getTransport();
              transport.stop();
              transport.cancel(0);

              return set({ playbackTime: 0, isPlaying: false });
            }
            const file = activeFilePath ? openFiles[activeFilePath] : undefined;
            const audioBuffer = file?.audioBuffer;

            if (audioBuffer) {
              if (Tone.getContext().rawContext.state !== "running") {
                await Tone.start();
              }
              player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
              player.loop = loop;
              player.sync().start(0);

              const transport = Tone.getTransport();

              transport.start();

              // updatePlaybackTime();
              return set({ playbackTime: 0, isPlaying: true });
            } else {
              console.error("No audio buffer available to play.");
              return;
            }
          },
          isPlaying: false,
          setIsPlaying: (isPlaying) => set({ isPlaying }),
          loop: false,
          setLoop: (loop) => set({ loop }),
          playbackTime: 0,
          setPlaybackTime: (playbackTime) => set({ playbackTime }),

          mousePos: null,
          setMousePos: (mousePos) => set({ mousePos }),
          hoveredFilePath: null,
          setHoveredFilePath: (filePath) => set({ hoveredFilePath: filePath }),
          effectOrder: ["gain", "transform", "harmonics", "blur", "synthesize", "sharpen"],
          setEffectOrder: (effectOrder) => set({ effectOrder }),
          effectsEnabled: {
            gain: true,
            transform: false,
            harmonics: false,
            blur: false,
            synthesize: false,
            sharpen: false,
          },
          setEffectEnabled: (effect, enabled) =>
            set((state) => ({
              effectsEnabled: { ...state.effectsEnabled, [effect]: enabled },
            })),
          sectionCollapsed: {},
          setSectionCollapsed: (section, collapsed) =>
            set((state) => ({
              sectionCollapsed: { ...state.sectionCollapsed, [section]: collapsed },
            })),

          // Preset management
          currentPresetId: "default",
          availablePresets: [...defaultPresets],
          setCurrentPresetId: (presetId) => set({ currentPresetId: presetId }),
          loadPresets: async () => {
            const presetManager = getPresetManager();
            const presets = await presetManager.loadPresets();
            set({ availablePresets: presets });
          },
          loadPreset: (presetId: string) => {
            const state = get();
            const preset = state.availablePresets.find((p) => p.id === presetId);
            if (!preset) {
              console.error("Preset not found:", presetId);
              return;
            }

            // Dynamically build the update object from preset keys
            const updates: any = { currentPresetId: presetId };

            for (const key of PRESET_KEYS) {
              const stateValue = state[key];
              const presetValue = preset[key];

              // For parameters (objects with .value), preserve the parameter structure
              if (stateValue && typeof stateValue === "object" && "value" in stateValue) {
                updates[key] = { ...stateValue, value: presetValue };
              } else {
                // For non-parameter values (effectOrder, effectsEnabled), just copy directly
                updates[key] = presetValue;
              }
            }

            set(updates);
          },
          savePreset: async (name: string, presetId?: string) => {
            const state = get();
            const presetManager = getPresetManager();

            // Generate ID if not provided
            const id = presetId || `preset-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

            // Dynamically build preset from current state
            const preset: any = {
              id,
              name,
              isDefault: false,
            };

            for (const key of PRESET_KEYS) {
              const stateValue = state[key];
              // For parameters (objects with .value), extract the value
              if (stateValue && typeof stateValue === "object" && "value" in stateValue) {
                preset[key] = stateValue.value;
              } else {
                // For non-parameter values (effectOrder, effectsEnabled), copy directly
                preset[key] = stateValue;
              }
            }

            // Save to file
            await presetManager.savePreset(preset as BrushPreset);

            // Reload presets
            await state.loadPresets();

            // Set as current preset
            set({ currentPresetId: id });
          },
          deletePreset: async (presetId: string) => {
            const state = get();
            const presetManager = getPresetManager();

            await presetManager.deletePreset(presetId);

            // Reload presets
            await state.loadPresets();

            // If we deleted the current preset, switch to default
            if (state.currentPresetId === presetId) {
              set({ currentPresetId: "default" });
            }
          },
        } satisfies State;
        return initialState;
      },
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (typeof value === "object" && value !== null && "value" in value) {
                acc[key] = { value: (value as Parameter<unknown>).value };
              } else if (persistedKeys.includes(key as keyof State)) {
                acc[key] = value;
              }
              return acc;
            },
            {} as Record<string, any>,
          );
        },
        merge: (persistedState, currentState) => deepMerge(currentState, persistedState),
      },
    ),
  ),
);

export function getModulator(index: number) {
  return {
    modulatorMode: useStore.getState()[`modulator${index}Mode` as ParameterKey],
    modulatorPatternShape: useStore.getState()[`modulator${index}PatternShape` as ParameterKey],
    modulatorPatternRateBeats: useStore.getState()[`modulator${index}PatternRateBeats` as ParameterKey],
    modulatorPatternRateSemis: useStore.getState()[`modulator${index}PatternRateSemis` as ParameterKey],
    modulatorStrength: useStore.getState()[`modulator${index}Strength` as ParameterKey],
    modulatorRotation: useStore.getState()[`modulator${index}Rotation` as ParameterKey],
  };
}
