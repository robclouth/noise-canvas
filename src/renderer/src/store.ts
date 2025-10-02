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
} from "./lib/constants";
import {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  OpenFile,
  OptionsParameter,
  Parameter,
} from "./types";

export const openFiles: Record<string, OpenFile> = {};

export type ModulatorParameters = {
  modulatorMode: OptionsParameter<number>;
  modulatorPatternShape: OptionsParameter<number>;
  modulatorPatternRateBeats: DiscreteNumberParameter;
  modulatorPatternRateSemis: DiscreteNumberParameter;
  modulatorPatternRadial: BooleanParameter;
  modulatorStrength: ContinuousNumberParameter;
  modulatorRotation: ContinuousNumberParameter;
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

  // Modulator
  modulators: ModulatorParameters[];

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
  synthesizeBrushType: OptionsParameter<string>;

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
};

// Helper type to extract keys of state that are parameters
type ParameterKey = keyof {
  [K in keyof State as State[K] extends { value: unknown } ? K : never]: State[K];
};

type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;

function createParameter<T extends { value: unknown }>(
  set: ZustandSet,
  key: ParameterKey,
  parameter: T,
  initialValue: T["value"],
  modulatable: boolean,
) {
  return {
    ...parameter,
    setValue: (value: T["value"]) => set((state) => ({ [key]: { ...state[key], value } })),
    resetValue: () => set((state) => ({ [key]: { ...state[key], value: initialValue } })),
    modulators: modulatable ? createModulators(set, key) : undefined,
  };
}

function createModulators(set: ZustandSet, key: ParameterKey) {
  return Array.from({ length: NUM_MODULATORS }).map((_, i) => ({
    name: `Mod ${i + 1} Amount`,
    label: `Mod ${i + 1}`,
    value: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    description:
      "The amount of modulation to apply. 0% is no modulation and only the value of the parameter is used, 100% is full modulation and the current value of the modulated parameter is ignored.",
    setValue: (value: number) =>
      set((state) => {
        const param = state[key];
        const newModulators = param.modulators?.map((m, idx) => (idx === i ? { ...m, value } : m));
        return { [key]: { ...param, modulators: newModulators } };
      }),
    resetValue: () =>
      set((state) => {
        const param = state[key];
        const newModulators = param.modulators?.map((m, idx) => (idx === i ? { ...m, value: 0 } : m));
        return { [key]: { ...param, modulators: newModulators } };
      }),
  }));
}

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set) => {
        return {
          brushIntensity: createParameter(
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
            100,
            true,
          ),
          brushIterations: createParameter(
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
            1,
            false,
          ),
          brushPan: createParameter(
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
            0.0,
            true,
          ),
          brushFeatherTime: createParameter(
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
            0,
            false,
          ),
          brushFeatherPitch: createParameter(
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
            0,
            false,
          ),
          brushFeatherSlopeTime: createParameter(
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
            0,
            false,
          ),
          brushFeatherSlopePitch: createParameter(
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
            0,
            false,
          ),
          sourceOffsetBeats: createParameter(
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
            0,
            true,
          ),
          sourceOffsetSemis: createParameter(
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
            0,
            true,
          ),
          sourceOffsetLock: createParameter(
            set,
            "sourceOffsetLock",
            {
              name: "Offset Lock",
              label: "Lock",
              description: "Locks the source offset to the brush position.",
              value: false as boolean,
            },
            false,
            false,
          ),
          brushType: createParameter(
            set,
            "brushType",
            {
              name: "Brush Type",
              label: "Type",
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
            "gain",
            false,
          ),
          brushWidthBeats: createParameter(
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
            1,
            false,
          ),
          brushHeightSemis: createParameter(
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
            12,
            false,
          ),
          brushSizeLockedToGrid: createParameter(
            set,
            "brushSizeLockedToGrid",
            {
              name: "Lock Brush Size to Grid",
              label: "Grid",
              description: "Locks the brush size to the grid size.",
              value: true as boolean,
            },
            true,
            false,
          ),
          zoomPower: createParameter(
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
            0,
            false,
          ),
          scroll: createParameter(
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
            0,
            false,
          ),
          gridSizeBeats: createParameter(
            set,
            "gridSizeBeats",
            {
              name: "Grid Size Beats",
              label: "Beats",
              description: "The horizontal grid size in beats.",
              value: 0.25,
              values: [{ value: 0, label: "Off" }, ...BEAT_VALUES].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },
            0.25,
            false,
          ),
          gridSizeSemis: createParameter(
            set,
            "gridSizeSemis",
            {
              name: "Grid Size Semis",
              label: "Semis",
              description: "The vertical grid size in semitones.",
              value: 1,
              values: [{ value: 0, label: "Off" }, ...PITCH_VALUES].map((value) => ({
                value: value.value,
                label: value.label,
              })),
            },
            1,
            false,
          ),

          normalize: createParameter(
            set,
            "normalize",
            {
              name: "Normalize",
              label: "Normalize",
              description: "Normalizes the audio output.",
              value: true as boolean,
            },
            true,
            false,
          ),
          scaleTonic: createParameter(
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
            "C",
            false,
          ),
          scaleType: createParameter(
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
            "major",
            false,
          ),
          bandsPerOctave: createParameter(
            set,
            "bandsPerOctave",
            {
              name: "Bands Per Octave",
              label: "Bands",
              description: "The number of frequency bands per octave.",
              value: 24,
              values: BANDS_PER_OCTAVE_VALUES.map((value) => ({ value: value.value, label: value.label })),
            },
            24,
            false,
          ),
          minFreq: createParameter(
            set,
            "minFreq",
            {
              name: "Minimum Frequency",
              label: "Min. Freq.",
              description: "The minimum frequency of the spectrogram.",
              value: 16.3516,
              min: 10,
              max: 100,
              step: 0.01,
              unit: "Hz",
            },
            16.3516,
            false,
          ),
          blendMode: createParameter(
            set,
            "blendMode",
            {
              name: "Blend Mode",
              label: "Blend",
              description: "The blend mode to use when applying the brush.",
              value: 0,
              options: BLEND_MODES,
            },
            0,
            false,
          ),
          modulators: Array.from({ length: NUM_MODULATORS }).map((_, i) => ({
            modulatorMode: {
              name: "Modulator Mode",
              label: "Mode",
              description: "The mode of the modulator.",
              value: 0,
              options: MODULATOR_MODES,
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorMode: {
                      ...modulator.modulatorMode,
                      value: index === i ? value : modulator.modulatorMode.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorMode: {
                      ...modulator.modulatorMode,
                      value: index === i ? 0 : modulator.modulatorMode.value,
                    },
                  })),
                })),
            },

            modulatorPatternShape: {
              name: "Modulator Pattern Shape",
              label: "Shape",
              description: "The shape of the modulator pattern.",
              value: 0,
              options: PATTERN_SHAPES,
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternShape: {
                      ...modulator.modulatorPatternShape,
                      value: index === i ? value : modulator.modulatorPatternShape.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternShape: {
                      ...modulator.modulatorPatternShape,
                      value: index === i ? 0 : modulator.modulatorPatternShape.value,
                    },
                  })),
                })),
            },
            modulatorPatternRateBeats: {
              name: "Modulator Rate Beats",
              label: "Rate H",
              description: "The rate of the modulator pattern in beats.",
              value: 1,
              values: [
                { value: 0, label: "0 beats" },
                ...BEAT_VALUES.map((value) => ({ value: value.value, label: value.label })),
              ],
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRateBeats: {
                      ...modulator.modulatorPatternRateBeats,
                      value: index === i ? value : modulator.modulatorPatternRateBeats.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRateBeats: {
                      ...modulator.modulatorPatternRateBeats,
                      value: index === i ? 1 : modulator.modulatorPatternRateBeats.value,
                    },
                  })),
                })),
            },
            modulatorPatternRateSemis: {
              name: "Modulator Rate Semis",
              label: "Rate V",
              description: "The rate of the modulator pattern in semitones.",
              value: 0,
              values: [
                { value: 0, label: "0 semis" },
                ...PITCH_VALUES.map((value) => ({ value: value.value, label: value.label })),
              ],
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRateSemis: {
                      ...modulator.modulatorPatternRateSemis,
                      value: index === i ? value : modulator.modulatorPatternRateSemis.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRateSemis: {
                      ...modulator.modulatorPatternRateSemis,
                      value: index === i ? 0 : modulator.modulatorPatternRateSemis.value,
                    },
                  })),
                })),
            },
            modulatorPatternRadial: {
              name: "Modulator Radial",
              label: "Radial",
              description: "If true, the modulator pattern is applied radially.",
              value: false,
              setValue: (value: boolean) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRadial: {
                      ...modulator.modulatorPatternRadial,
                      value: index === i ? value : modulator.modulatorPatternRadial.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorPatternRadial: {
                      ...modulator.modulatorPatternRadial,
                      value: index === i ? false : modulator.modulatorPatternRadial.value,
                    },
                  })),
                })),
            },
            modulatorStrength: {
              name: "Modulator Strength",
              label: "Strength",
              description: "The strength of the modulator.",
              value: 100,
              min: -100,
              max: 100,
              step: 1,
              unit: "%",
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorStrength: {
                      ...modulator.modulatorStrength,
                      value: index === i ? value : modulator.modulatorStrength.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorStrength: {
                      ...modulator.modulatorStrength,
                      value: index === i ? 100 : modulator.modulatorStrength.value,
                    },
                  })),
                })),
            },
            modulatorRotation: {
              name: "Modulator Rotation",
              label: "Rotation",
              description: "The rotation of the modulator pattern.",
              value: 0,
              min: 0,
              max: 360,
              step: 1,
              unit: "°",
              setValue: (value: number) =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorRotation: {
                      ...modulator.modulatorRotation,
                      value: index === i ? value : modulator.modulatorRotation.value,
                    },
                  })),
                })),
              resetValue: () =>
                set((state) => ({
                  modulators: state.modulators.map((modulator, index) => ({
                    ...modulator,
                    modulatorRotation: {
                      ...modulator.modulatorRotation,
                      value: index === i ? 0 : modulator.modulatorRotation.value,
                    },
                  })),
                })),
            },
          })),
          gainDb: createParameter(
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
            0.0,
            true,
          ),
          blurAmountTime: createParameter(
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
            0,
            true,
          ),
          blurAmountPitch: createParameter(
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
            0,
            true,
          ),
          blurNoiseTime: createParameter(
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
            0,
            true,
          ),
          blurNoisePitch: createParameter(
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
            0,
            true,
          ),
          blurBleed: createParameter(
            set,
            "blurBleed",
            {
              name: "Blur Bleed",
              label: "Bleed",
              description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
              value: true as boolean,
            },
            true,
            false,
          ),
          sharpenAmountTime: createParameter(
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
            0,
            true,
          ),
          sharpenAmountPitch: createParameter(
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
            0,
            true,
          ),
          harmonicsPower: createParameter(
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
            1.0,
            true,
          ),
          harmonicsFalloff: createParameter(
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
            10.0,
            true,
          ),
          harmonicsOddEven: createParameter(
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
            0,
            true,
          ),
          transformShiftBeats: createParameter(
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
            0.0,
            true,
          ),
          transformShiftSemis: createParameter(
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
            0.0,
            true,
          ),
          transformScaleTime: createParameter(
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
            1.0,
            true,
          ),
          transformScalePitch: createParameter(
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
            1.0,
            true,
          ),
          transformRotation: createParameter(
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
            0.0,
            true,
          ),
          transformEdgeMode: createParameter(
            set,
            "transformEdgeMode",
            {
              name: "Edge Mode",
              label: "Edge",
              description: "How to handle edges when transforming.",
              value: 1,
              options: EDGE_MODE,
            },
            1,
            false,
          ),
          synthesizeBrushType: createParameter(
            set,
            "synthesizeBrushType",
            {
              name: "Synthesize Type",
              label: "Type",
              description: "The type of synthesis to use.",
              value: "noise",
              options: [
                { value: "noise", label: "Noise" },
                { value: "sine", label: "Sine" },
              ],
            },
            "noise",
            false,
          ),
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
      },
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (key === "modulators") {
                acc[key] = (value as ModulatorParameters[]).map((modulator) => {
                  const persistedModulator: Record<string, { value: unknown }> = {};
                  for (const [paramKey, paramValue] of Object.entries(modulator)) {
                    persistedModulator[paramKey] = { value: (paramValue as { value: unknown }).value };
                  }
                  return persistedModulator;
                });
              } else if (typeof value === "object" && value !== null && "value" in value) {
                const param = value as Parameter<unknown> & { modulators?: { value: number }[] };
                const persistedParam: { value: unknown; modulators?: { value: number }[] } = { value: param.value };
                if (param.modulators) {
                  persistedParam.modulators = param.modulators.map((m) => ({ value: m.value }));
                }
                acc[key] = persistedParam;
              } else if (["filesBpm"].includes(key)) {
                acc[key] = value;
              }
              return acc;
            },
            {} as Record<string, any>,
          );
        },
        merge: (persistedState, currentState) => {
          const customMerge = (current: any, persisted: any): any => {
            const result = { ...current };
            for (const key in persisted) {
              if (Object.prototype.hasOwnProperty.call(persisted, key)) {
                const currentValue = current[key];
                const persistedValue = persisted[key];

                if (
                  typeof currentValue === "object" &&
                  currentValue !== null &&
                  !Array.isArray(currentValue) &&
                  typeof persistedValue === "object" &&
                  persistedValue !== null &&
                  !Array.isArray(persistedValue)
                ) {
                  result[key] = customMerge(currentValue, persistedValue);
                } else if (Array.isArray(currentValue) && Array.isArray(persistedValue)) {
                  result[key] = currentValue.map((item, index) => {
                    const persistedItem = persistedValue[index];
                    if (
                      typeof item === "object" &&
                      item !== null &&
                      typeof persistedItem === "object" &&
                      persistedItem !== null
                    ) {
                      return customMerge(item, persistedItem);
                    }
                    return persistedItem ?? item;
                  });
                } else {
                  result[key] = persistedValue;
                }
              }
            }
            return result;
          };

          return customMerge(currentState, persistedState as State);
        },
      },
    ),
  ),
);
