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
  PATTERN_SHAPES,
  PITCH_VALUES,
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

export type State = {
  // Brush Parameters
  brushIntensity: ContinuousNumberParameter;
  brushIterations: ContinuousNumberParameter;
  brushIntensityMod: ContinuousNumberParameter;
  brushPan: ContinuousNumberParameter;
  brushPanMod: ContinuousNumberParameter;
  brushFeatherTime: ContinuousNumberParameter;
  brushFeatherPitch: ContinuousNumberParameter;
  brushFeatherSlopeTime: ContinuousNumberParameter;
  brushFeatherSlopePitch: ContinuousNumberParameter;
  sourceOffsetBeats: DiscreteNumberParameter;
  sourceOffsetBeatsMod: ContinuousNumberParameter;
  sourceOffsetSemis: DiscreteNumberParameter;
  sourceOffsetSemisMod: ContinuousNumberParameter;
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
  modulatorMode: OptionsParameter<number>;
  modulatorPatternShape: OptionsParameter<number>;
  modulatorPatternRateBeats: DiscreteNumberParameter;
  modulatorPatternRateSemis: DiscreteNumberParameter;
  modulatorPatternRadial: BooleanParameter;
  modulatorStrength: ContinuousNumberParameter;
  modulatorRotation: ContinuousNumberParameter;

  // Gain Brush
  gainDb: ContinuousNumberParameter;
  gainDbMod: ContinuousNumberParameter;

  // Transform Brush
  transformShiftBeats: DiscreteNumberParameter;
  transformShiftBeatsMod: ContinuousNumberParameter;
  transformShiftSemis: DiscreteNumberParameter;
  transformShiftSemisMod: ContinuousNumberParameter;
  transformScaleTime: DiscreteNumberParameter;
  transformScaleTimeMod: ContinuousNumberParameter;
  transformScalePitch: DiscreteNumberParameter;
  transformScalePitchMod: ContinuousNumberParameter;
  transformRotation: ContinuousNumberParameter;
  transformRotationMod: ContinuousNumberParameter;
  transformEdgeMode: OptionsParameter<number>;

  // Blur Brush
  blurAmountTime: ContinuousNumberParameter;
  blurAmountTimeMod: ContinuousNumberParameter;
  blurAmountPitch: ContinuousNumberParameter;
  blurAmountPitchMod: ContinuousNumberParameter;
  blurNoiseTime: ContinuousNumberParameter;
  blurNoiseTimeMod: ContinuousNumberParameter;
  blurNoisePitch: ContinuousNumberParameter;
  blurNoisePitchMod: ContinuousNumberParameter;
  blurBleed: BooleanParameter;

  // Sharpen Brush
  sharpenAmountTime: ContinuousNumberParameter;
  sharpenAmountTimeMod: ContinuousNumberParameter;
  sharpenAmountPitch: ContinuousNumberParameter;
  sharpenAmountPitchMod: ContinuousNumberParameter;

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

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set) => {
        const createSetters = <K extends ParameterKey>(key: K, initialValue: State[K]["value"]) => ({
          setValue: (value: State[K]["value"]) => set((state) => ({ [key]: { ...state[key], value } })),
          resetValue: () => set((state) => ({ [key]: { ...state[key], value: initialValue } })),
        });

        const createModulator = ({ name, key }: { name: string; key: ParameterKey }) => ({
          name,
          label: "Mod",
          value: 0,
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
          description:
            "The amount of modulation to apply. 0% is no modulation and only the value of the parameter is used, 100% is full modulation and the current value of the modulated parameter is ignored.",
          ...createSetters(key, 0),
        });

        return {
          brushIntensity: {
            name: "Brush Intensity",
            label: "Amount",
            description: "Controls the strength of the brush.",
            value: 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "brushIntensityMod",
            ...createSetters("brushIntensity", 100),
          },
          brushIntensityMod: createModulator({ name: "Brush Intensity Mod Amount", key: "brushIntensityMod" }),
          brushIterations: {
            name: "Brush Iterations",
            label: "Iterations",
            description: "How many times to apply the brush effect.",
            value: 1,
            min: 1,
            max: 20,
            step: 1,
            ...createSetters("brushIterations", 1),
          },
          brushPan: {
            name: "Pan",
            label: "Pan",
            description: "Pans the brush effect left or right.",
            value: 0.0,
            min: -100,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "brushPanMod",
            ...createSetters("brushPan", 0.0),
          },
          brushPanMod: createModulator({ name: "Pan Mod Amount", key: "brushPanMod" }),
          brushFeatherTime: {
            name: "Feather Time",
            label: "Amount H",
            description: "Softens the brush effect at the edges of the time selection.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("brushFeatherTime", 0),
          },
          brushFeatherPitch: {
            name: "Feather Pitch",
            label: "Amount V",
            description: "Softens the brush effect at the edges of the pitch selection.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("brushFeatherPitch", 0),
          },
          brushFeatherSlopeTime: {
            name: "Feather Slope Time",
            label: "Slope H",
            description:
              "Controls the slope of the time feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
            value: 0,
            min: -100,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("brushFeatherSlopeTime", 0),
          },
          brushFeatherSlopePitch: {
            name: "Feather Slope Pitch",
            label: "Slope V",
            description:
              "Controls the slope of the pitch feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
            value: 0,
            min: -100,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("brushFeatherSlopePitch", 0),
          },
          sourceOffsetBeats: {
            name: "Offset Beats",
            label: "Offset H",
            description: "Offsets the source horizontally by a number of beats.",
            value: 0,
            values: [
              ...BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 beats", value: 0 },
              ...BEAT_VALUES,
            ],
            modulatorParamKey: "sourceOffsetBeatsMod",
            ...createSetters("sourceOffsetBeats", 0),
          },
          sourceOffsetBeatsMod: createModulator({ name: "Offset Beats Mod Amount", key: "sourceOffsetBeatsMod" }),
          sourceOffsetSemis: {
            name: "Offset Semis",
            label: "Offset V",
            description: "Offsets the source vertically by a number of semitones.",
            value: 0.0,
            values: [
              ...PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 semis", value: 0 },
              ...PITCH_VALUES,
            ],
            modulatorParamKey: "sourceOffsetSemisMod",
            ...createSetters("sourceOffsetSemis", 0),
          },
          sourceOffsetSemisMod: createModulator({ name: "Offset Semis Mod Amount", key: "sourceOffsetSemisMod" }),
          sourceOffsetLock: {
            name: "Offset Lock",
            label: "Lock",
            description: "Locks the source offset to the brush position.",
            value: false,
            ...createSetters("sourceOffsetLock", false),
          },
          brushType: {
            name: "Brush Type",
            label: "Type",
            description: "The type of brush to use.",
            value: "gain",
            options: [
              { value: "gain", label: "Gain" },
              { value: "restore", label: "Restore" },
              { value: "transform", label: "Transform" },
              { value: "blur", label: "Smooth" },
              // { value: "sharpen", label: "Sharpen" },
            ],
            ...createSetters("brushType", "gain"),
          },
          brushWidthBeats: {
            name: "Brush Width",
            label: "Width",
            description: "The width of the brush in beats.",
            value: 1,
            values: [...BEAT_VALUES, { value: 0, label: "Full" }].map((value) => ({
              value: value.value,
              label: value.label,
            })),
            ...createSetters("brushWidthBeats", 1),
          },
          brushHeightSemis: {
            name: "Brush Height",
            label: "Height",
            description: "The height of the brush in semitones.",
            value: 12,
            values: [...PITCH_VALUES, { value: 0, label: "Full" }].map((value) => ({
              value: value.value,
              label: value.label,
            })),
            ...createSetters("brushHeightSemis", 12),
          },
          brushSizeLockedToGrid: {
            name: "Lock Brush Size to Grid",
            label: "Grid",
            description: "Locks the brush size to the grid size.",
            value: true,
            ...createSetters("brushSizeLockedToGrid", true),
          },
          zoomPower: {
            name: "Zoom",
            label: "Zoom",
            description: "Controls the zoom level of the spectrogram.",
            value: 0,
            min: -10,
            max: 10,
            step: 1,
            ...createSetters("zoomPower", 0),
          },
          scroll: {
            name: "Scroll",
            label: "Scroll",
            description: "Scrolls the spectrogram horizontally.",
            value: 0,
            min: 0,
            max: 1,
            step: 0.01,
            ...createSetters("scroll", 0),
          },
          gridSizeBeats: {
            name: "Grid Size Beats",
            label: "Beats",
            description: "The horizontal grid size in beats.",
            value: 0.25,
            values: [{ value: 0, label: "Off" }, ...BEAT_VALUES].map((value) => ({
              value: value.value,
              label: value.label,
            })),
            ...createSetters("gridSizeBeats", 0.25),
          },
          gridSizeSemis: {
            name: "Grid Size Semis",
            label: "Semis",
            description: "The vertical grid size in semitones.",
            value: 1,
            values: [{ value: 0, label: "Off" }, ...PITCH_VALUES].map((value) => ({
              value: value.value,
              label: value.label,
            })),
            ...createSetters("gridSizeSemis", 1),
          },

          normalize: {
            name: "Normalize",
            label: "Normalize",
            description: "Normalizes the audio output.",
            value: true,
            ...createSetters("normalize", true),
          },
          scaleTonic: {
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
            ...createSetters("scaleTonic", "C"),
          },
          scaleType: {
            name: "Scale Type",
            label: "Type",
            description: "The type of scale to use.",
            value: "major",
            options: ScaleType.all().map(({ name }) => ({
              value: name,
              label: startCase(name),
            })),
            ...createSetters("scaleType", "major"),
          },
          bandsPerOctave: {
            name: "Bands Per Octave",
            label: "Bands",
            description: "The number of frequency bands per octave.",
            value: 24,
            values: BANDS_PER_OCTAVE_VALUES.map((value) => ({ value: value.value, label: value.label })),
            ...createSetters("bandsPerOctave", 24),
          },
          minFreq: {
            name: "Minimum Frequency",
            label: "Min. Freq.",
            description: "The minimum frequency of the spectrogram.",
            value: 16.3516,
            min: 10,
            max: 100,
            step: 0.01,
            unit: "Hz",
            ...createSetters("minFreq", 16.3516),
          },
          blendMode: {
            name: "Blend Mode",
            label: "Blend",
            description: "The blend mode to use when applying the brush.",
            value: 0,
            options: BLEND_MODES,
            ...createSetters("blendMode", 0),
          },
          modulatorMode: {
            name: "Modulator Mode",
            label: "Mode",
            description: "The mode of the modulator.",
            value: 0,
            options: MODULATOR_MODES,
            ...createSetters("modulatorMode", 0),
          },

          modulatorPatternShape: {
            name: "Modulator Pattern Shape",
            label: "Shape",
            description: "The shape of the modulator pattern.",
            value: 0,
            options: PATTERN_SHAPES,
            ...createSetters("modulatorPatternShape", 0),
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
            ...createSetters("modulatorPatternRateBeats", 1),
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
            ...createSetters("modulatorPatternRateSemis", 0),
          },
          modulatorPatternRadial: {
            name: "Modulator Radial",
            label: "Radial",
            description: "If true, the modulator pattern is applied radially.",
            value: false,
            ...createSetters("modulatorPatternRadial", false),
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
            ...createSetters("modulatorStrength", 100),
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
            ...createSetters("modulatorRotation", 0),
          },

          gainDb: {
            name: "Gain",
            label: "Gain",
            description: "The amount of gain to apply in decibels.",
            value: 0.0,
            min: -24,
            max: 24,
            step: 0.1,
            unit: "dB",
            modulatorParamKey: "gainDbMod",
            ...createSetters("gainDb", 0.0),
          },
          gainDbMod: createModulator({ name: "Gain Mod Amount", key: "gainDbMod" }),
          blurAmountTime: {
            name: "Blur Amount Time",
            label: "Blur H",
            description: "The amount of blur to apply over time.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "blurAmountTimeMod",
            ...createSetters("blurAmountTime", 0),
          },
          blurAmountTimeMod: createModulator({ name: "Blur Amount Time Mod Amount", key: "blurAmountTimeMod" }),
          blurAmountPitch: {
            name: "Blur Amount Pitch",
            label: "Blur V",
            description: "The amount of blur to apply over pitch.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "blurAmountPitchMod",
            ...createSetters("blurAmountPitch", 0),
          },
          blurAmountPitchMod: createModulator({ name: "Blur Amount Pitch Mod Amount", key: "blurAmountPitchMod" }),
          blurNoiseTime: {
            name: "Blur Noise Time",
            label: "Noise H",
            description: "The amount of noise to apply over time.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "blurNoiseTimeMod",
            ...createSetters("blurNoiseTime", 0),
          },
          blurNoiseTimeMod: createModulator({ name: "Blur Noise Time Mod Amount", key: "blurNoiseTimeMod" }),
          blurNoisePitch: {
            name: "Blur Noise Pitch",
            label: "Noise V",
            description: "The amount of noise to apply over pitch.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "blurNoisePitchMod",
            ...createSetters("blurNoisePitch", 0),
          },
          blurNoisePitchMod: createModulator({ name: "Blur Noise Pitch Mod Amount", key: "blurNoisePitchMod" }),
          blurBleed: {
            name: "Blur Bleed",
            label: "Bleed",
            description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
            value: true,
            ...createSetters("blurBleed", true),
          },
          sharpenAmountTime: {
            name: "Sharpen Time",
            label: "Sharpen H",
            description: "The amount of sharpening to apply over time.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "sharpenAmountTimeMod",
            ...createSetters("sharpenAmountTime", 0),
          },
          sharpenAmountTimeMod: createModulator({ name: "Sharpen Time Mod Amount", key: "sharpenAmountTimeMod" }),
          sharpenAmountPitch: {
            name: "Sharpen Pitch",
            label: "Sharpen V",
            description: "The amount of sharpening to apply over pitch.",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "sharpenAmountPitchMod",
            ...createSetters("sharpenAmountPitch", 0),
          },
          sharpenAmountPitchMod: createModulator({ name: "Sharpen Pitch Mod Amount", key: "sharpenAmountPitchMod" }),
          transformShiftBeats: {
            name: "Shift Beats",
            label: "Shift H",
            description: "Shifts the content horizontally by a number of beats.",
            value: 0,
            values: [
              ...BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 beats", value: 0 },
              ...BEAT_VALUES,
            ],
            modulatorParamKey: "transformShiftBeatsMod",
            ...createSetters("transformShiftBeats", 0.0),
          },
          transformShiftBeatsMod: createModulator({ name: "Shift Beats Mod Amount", key: "transformShiftBeatsMod" }),
          transformShiftSemis: {
            name: "Shift Semis",
            label: "Shift V",
            description: "Shifts the content vertically by a number of semitones.",
            value: 0.0,
            values: [
              ...PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 semis", value: 0 },
              ...PITCH_VALUES,
            ],
            modulatorParamKey: "transformShiftSemisMod",
            ...createSetters("transformShiftSemis", 0.0),
          },
          transformShiftSemisMod: createModulator({ name: "Shift Semis Mod Amount", key: "transformShiftSemisMod" }),
          transformScaleTime: {
            name: "Scale Time",
            label: "Scale H",
            description: "Scales the content horizontally.",
            value: 1.0,
            values: [
              ...MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              ...MULTIPLIER_VALUES,
            ],
            modulatorParamKey: "transformScaleTimeMod",
            ...createSetters("transformScaleTime", 1.0),
          },
          transformScaleTimeMod: createModulator({ name: "Scale Time Mod Amount", key: "transformScaleTimeMod" }),
          transformScalePitch: {
            name: "Scale Pitch",
            label: "Scale V",
            description: "Scales the content vertically.",
            value: 1.0,
            values: [
              ...MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              ...MULTIPLIER_VALUES,
            ],
            modulatorParamKey: "transformScalePitchMod",
            ...createSetters("transformScalePitch", 1.0),
          },
          transformScalePitchMod: createModulator({ name: "Scale Pitch Mod Amount", key: "transformScalePitchMod" }),
          transformRotation: {
            name: "Rotation",
            label: "Rotation",
            description: "Rotates the content.",
            value: 0.0,
            min: -180,
            max: 180,
            step: 1,
            unit: "°",
            modulatorParamKey: "transformRotationMod",
            ...createSetters("transformRotation", 0.0),
          },
          transformRotationMod: createModulator({ name: "Rotation Mod Amount", key: "transformRotationMod" }),
          transformEdgeMode: {
            name: "Edge Mode",
            label: "Edge",
            description: "How to handle edges when transforming.",
            value: 1,
            options: EDGE_MODE,
            ...createSetters("transformEdgeMode", 1),
          },
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
