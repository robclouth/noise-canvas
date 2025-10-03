import { deepMerge } from "@mantine/core";
import { startCase } from "lodash-es";
import { Vector2 } from "three";
import { ScaleType } from "tonal";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import {
  BANDS_PER_OCTAVE_VALUES,
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
import { Parameter } from "./Parameter";
import {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  OpenFile,
  OptionsParameter,
} from "./types";

export const openFiles: Record<string, OpenFile> = {};

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

type ModulatableParameterKey =
  | "brushIntensity"
  | "brushPan"
  | "sourceOffsetBeats"
  | "sourceOffsetSemis"
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

export type State = {
  // Brush Parameters
  brushIntensity: ContinuousNumberParameter;
  brushIterations: ContinuousNumberParameter;
  brushPan: ContinuousNumberParameter;
  brushFeatherTime: ContinuousNumberParameter;
  brushFeatherPitch: ContinuousNumberParameter;
  brushFeatherSlopeTime: ContinuousNumberParameter;
  brushFeatherSlopePitch: ContinuousNumberParameter;
  sourceOffsetBeats: DiscreteNumberParameter;
  sourceOffsetSemis: DiscreteNumberParameter;
  sourceOffsetLock: BooleanParameter;

  // Brush Options
  brushType: OptionsParameter<string>;
  brushWidthBeats: DiscreteNumberParameter; // in beats
  brushHeightSemis: DiscreteNumberParameter; // in semitones
  brushSizeLockedToGrid: BooleanParameter;

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
  bandsPerOctave: DiscreteNumberParameter;
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

  // Audio Playback
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  playbackTime: number;
  setPlaybackTime: (playbackTime: number) => void;
  isSynthesizing: boolean;
  setIsSynthesizing: (isSynthesizing: boolean) => void;

  // UI State
  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;

  // Files
  openFilePaths: string[];
  openFile: (file: OpenFile) => void;
  closeFile: (filePath: string) => void;
  closeAllFiles: () => void;
  audioBuffers: Record<string, AudioBuffer>;
  setAudioBuffers: (audioBuffers: Record<string, AudioBuffer>) => void;
  filesBpm: Record<string, number>;
  setFileBpm: (filePath: string, bpm: number | undefined) => void;
  activeFilePath: string | null;
  setActiveFilePath: (activeFilePath: string | null) => void;
  sourceFilePath: string | null;
  setSourceFilePath: (sourceFilePath: string | null) => void;
} & ModulatorAmountParameters &
  ModulatorParameters;

// Helper type to extract keys of state that are parameters
export type ParameterKey = keyof {
  [K in keyof State as State[K] extends { value: unknown } ? K : never]: State[K];
};

type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;

function createParameter<T extends { value: unknown }>(
  set: ZustandSet,
  key: ParameterKey,
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

function createModulatorParamsForParameter(set: ZustandSet, key: ParameterKey) {
  let params = {} as any;
  for (let i = 0; i < NUM_MODULATORS; i++) {
    const paramKey = `${key}Mod${i + 1}Amount` as keyof ModulatorAmountParameters;
    params = {
      ...params,
      ...createParameter(
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
    let paramKey = `modulator${i + 1}Mode` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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
    paramKey = `modulator${i + 1}PatternShape` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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
    paramKey = `modulator${i + 1}Strength` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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
    paramKey = `modulator${i + 1}PatternRateBeats` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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
    paramKey = `modulator${i + 1}PatternRateSemis` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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
    paramKey = `modulator${i + 1}Rotation` as ParameterKey;
    params = {
      ...params,
      ...createParameter(
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

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set) => {
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
          ...createParameter(
            set,
            "sourceOffsetBeats",
            {
              name: "Offset Beats",
              label: "Offset H",
              description: "Offsets the source horizontally by a number of beats.",
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
            "sourceOffsetSemis",
            {
              name: "Offset Semis",
              label: "Offset V",
              description: "Offsets the source vertically by a number of semitones.",
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
            "sourceOffsetLock",
            {
              name: "Offset Lock",
              label: "Lock",
              description: "Locks the source offset to the brush position.",
              value: false as boolean,
            },
            false,
          ),
          ...createParameter(
            set,
            "brushType",
            {
              name: "Brush Type",
              label: "Brush",
              description: "The type of brush to use.",
              value: "gain",
              options: [
                { value: "gain", label: "Gain" },
                { value: "restore", label: "Restore" },
                { value: "transform", label: "Transform" },
                { value: "harmonics", label: "Harmonics" },
                { value: "blur", label: "Smooth" },
                { value: "synthesize", label: "Synthesize" },
                // { value: "sharpen", label: "Sharpen" },
              ],
            },
            false,
          ),
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
              value: true as boolean,
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
              name: "Bands Per Octave",
              label: "Bands",
              description: "The number of frequency bands per octave.",
              value: 24,
              values: BANDS_PER_OCTAVE_VALUES.map((value) => ({ value: value.value, label: value.label })),
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
          openFile: (file) =>
            set((state) => {
              if (openFiles[file.filePath]) {
                return state;
              }
              openFiles[file.filePath] = file;
              set({ activeFilePath: file.filePath });
              return { openFilePaths: [...state.openFilePaths, file.filePath] };
            }),
          closeFile: (filePath) =>
            set((state) => {
              if (openFiles[filePath]) {
                delete openFiles[filePath];
                return { openFilePaths: state.openFilePaths.filter((path) => path !== filePath) };
              }
              return state;
            }),
          closeAllFiles: () => {
            for (const key in openFiles) {
              delete openFiles[key];
            }
            return set({ openFilePaths: [] });
          },
          audioBuffers: {},
          setAudioBuffers: (audioBuffers) => set({ audioBuffers }),
          filesBpm: {},
          setFileBpm: (filePath, bpm) =>
            set((state) => {
              if (!openFiles[filePath]) return state;
              if (bpm) {
                state.filesBpm[filePath] = bpm;
              } else {
                delete state.filesBpm[filePath];
              }

              return state;
            }),
          activeFilePath: null,
          setActiveFilePath: (activeFilePath) => set({ activeFilePath }),
          sourceFilePath: null,
          setSourceFilePath: (sourceFilePath) => set({ sourceFilePath }),
          isPlaying: false,
          setIsPlaying: (isPlaying) => set({ isPlaying }),
          loop: false,
          setLoop: (loop) => set({ loop }),
          playbackTime: 0,
          setPlaybackTime: (playbackTime) => set({ playbackTime }),
          isSynthesizing: false,
          setIsSynthesizing: (isSynthesizing) => set({ isSynthesizing }),
          mousePos: null,
          setMousePos: (mousePos) => set({ mousePos }),
        };
        return initialState as unknown as State;
      },
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (typeof value === "object" && value !== null && "value" in value) {
                acc[key] = { value: (value as Parameter<unknown>).value };
              } else if (["filesBpm"].includes(key)) {
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
