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
  BOUNDARY_MODES,
  MODULATOR_MODES,
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
  brushIntensityMod: ContinuousNumberParameter;
  pan: ContinuousNumberParameter;
  panMod: ContinuousNumberParameter;
  featherTime: ContinuousNumberParameter;
  featherPitch: ContinuousNumberParameter;
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
  modulatorMode: OptionsParameter<number>;
  modulatorPatternShape: OptionsParameter<number>;
  modulatorPatternRateBeats: DiscreteNumberParameter;
  modulatorPatternRateSemis: DiscreteNumberParameter;
  modulatorPatternRadial: BooleanParameter;

  // Gain Brush
  gainDb: ContinuousNumberParameter;
  gainDbMod: ContinuousNumberParameter;

  // Blur Brush
  blurTime: ContinuousNumberParameter; // in beats
  blurPitch: ContinuousNumberParameter; // in cents

  // Transform Brush
  shiftX: ContinuousNumberParameter;
  shiftYCents: ContinuousNumberParameter;
  scaleX: ContinuousNumberParameter;
  scaleY: ContinuousNumberParameter;
  rotation: ContinuousNumberParameter;
  boundaryMode: OptionsParameter<number>;

  // Dynamics Brush
  dynamicsThreshold: ContinuousNumberParameter;
  dynamicsRatio: ContinuousNumberParameter;
  dynamicsMakeupGain: ContinuousNumberParameter;
  dynamicsAttack: ContinuousNumberParameter;
  dynamicsRelease: ContinuousNumberParameter;
  dynamicsKnee: ContinuousNumberParameter;

  // Scale Brush
  scaleAmount: ContinuousNumberParameter;

  // Transient Shaper Brush
  transientIntensity: ContinuousNumberParameter;
  transientThreshold: ContinuousNumberParameter;
  alignPhases: BooleanParameter;

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
          ...createSetters(key, 0),
        });

        return {
          brushIntensity: {
            name: "Brush Intensity",
            label: "Intensity",
            value: 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "brushIntensityMod",
            ...createSetters("brushIntensity", 100),
          },
          brushIntensityMod: createModulator({ name: "Brush Intensity Mod Amount", key: "brushIntensityMod" }),
          pan: {
            name: "Pan",
            label: "Pan",
            value: 0.0,
            min: -100,
            max: 100,
            step: 1,
            unit: "%",
            modulatorParamKey: "panMod",
            ...createSetters("pan", 0.0),
          },
          panMod: createModulator({ name: "Pan Mod Amount", key: "panMod" }),
          featherTime: {
            name: "Feather Time",
            label: "Time",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("featherTime", 0),
          },
          featherPitch: {
            name: "Feather Pitch",
            label: "Pitch",
            value: 0,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("featherPitch", 0),
          },
          sourceOffsetBeats: {
            name: "Offset Beats",
            label: "Beats",
            value: 0,
            values: [
              ...BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 beats", value: 0 },
              ...BEAT_VALUES,
            ],
            unit: " beats",
            ...createSetters("sourceOffsetBeats", 0),
          },
          sourceOffsetSemis: {
            name: "Offset Semis",
            label: "Semis",
            value: 0.0,
            values: [
              ...PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
              { label: "0 semis", value: 0 },
              ...PITCH_VALUES,
            ],
            unit: " semi",
            ...createSetters("sourceOffsetSemis", 0),
          },
          sourceOffsetLock: {
            name: "Offset Lock",
            label: "Lock",
            value: false,
            ...createSetters("sourceOffsetLock", false),
          },
          brushType: {
            name: "Brush Type",
            label: "Type",
            value: "gain",
            options: [
              { value: "gain", label: "Gain" },
              { value: "restore", label: "Restore" },
              { value: "blur", label: "Blur" },
              { value: "transform", label: "Transform" },
              { value: "transient shaper", label: "Transient Shaper" },
              { value: "dynamics", label: "Dynamics" },
              { value: "scale", label: "Scale" },
            ],
            ...createSetters("brushType", "gain"),
          },
          brushWidthBeats: {
            name: "Brush Width",
            label: "Width",
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
            value: true,
            ...createSetters("brushSizeLockedToGrid", true),
          },
          zoomPower: {
            name: "Zoom",
            label: "Zoom",
            value: 0,
            min: -10,
            max: 10,
            step: 1,
            ...createSetters("zoomPower", 0),
          },
          scroll: {
            name: "Scroll",
            label: "Scroll",
            value: 0,
            min: 0,
            max: 1,
            step: 0.01,
            ...createSetters("scroll", 0),
          },
          gridSizeBeats: {
            name: "Grid Size Beats",
            label: "Beats",
            value: 0.25,
            values: BEAT_VALUES.map((value) => ({ value: value.value, label: value.label })),
            ...createSetters("gridSizeBeats", 0.25),
          },
          gridSizeSemis: {
            name: "Grid Size Semis",
            label: "Semis",
            value: 1,
            values: PITCH_VALUES.map((value) => ({ value: value.value, label: value.label })),
            ...createSetters("gridSizeSemis", 1),
          },

          normalize: {
            name: "Normalize",
            label: "Normalize",
            value: true,
            ...createSetters("normalize", true),
          },
          scaleTonic: {
            name: "Scale Tonic",
            label: "Tonic",
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
            value: 24,
            values: BANDS_PER_OCTAVE_VALUES.map((value) => ({ value: value.value, label: value.label })),
            ...createSetters("bandsPerOctave", 24),
          },
          minFreq: {
            name: "Minimum Frequency",
            label: "Min. Freq.",
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
            value: 0,
            options: BLEND_MODES,
            ...createSetters("blendMode", 0),
          },
          modulatorMode: {
            name: "Modulator Mode",
            label: "Mode",
            value: 0,
            options: MODULATOR_MODES,
            ...createSetters("modulatorMode", 0),
          },

          modulatorPatternShape: {
            name: "Modulator Pattern Shape",
            label: "Shape",
            value: 0,
            options: PATTERN_SHAPES,
            ...createSetters("modulatorPatternShape", 0),
          },
          modulatorPatternRateBeats: {
            name: "Modulator Rate Beats",
            label: "Beats",
            value: 1,
            values: [
              { value: 0, label: "0 beats" },
              ...BEAT_VALUES.map((value) => ({ value: value.value, label: value.label })),
            ],
            ...createSetters("modulatorPatternRateBeats", 1),
          },
          modulatorPatternRateSemis: {
            name: "Modulator Rate Semis",
            label: "Semis",
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
            value: false,
            ...createSetters("modulatorPatternRadial", false),
          },
          gainDb: {
            name: "Gain",
            label: "Gain",
            value: 0.0,
            min: -24,
            max: 24,
            step: 0.1,
            unit: "dB",
            modulatorParamKey: "gainDbMod",
            ...createSetters("gainDb", 0.0),
          },
          gainDbMod: createModulator({ name: "Gain Mod Amount", key: "gainDbMod" }),
          blurTime: {
            name: "Blur Time",
            label: "Time",
            value: 1 / 64,
            min: 0,
            max: 1,
            step: 0.001,
            unit: "beats",
            ...createSetters("blurTime", 1 / 64),
          },
          blurPitch: {
            name: "Blur Pitch",
            label: "Pitch",
            value: 100,
            min: 0,
            max: 1200,
            step: 1,
            unit: "cents",
            ...createSetters("blurPitch", 100),
          },
          shiftX: {
            name: "Shift X",
            label: "X",
            value: 0.0,
            min: -4,
            max: 4,
            step: 0.01,
            unit: "beats",
            ...createSetters("shiftX", 0.0),
          },
          shiftYCents: {
            name: "Shift Y",
            label: "Y",
            value: 0.0,
            min: -1200,
            max: 1200,
            step: 1,
            unit: "cents",
            ...createSetters("shiftYCents", 0.0),
          },
          scaleX: {
            name: "Scale X",
            label: "X",
            value: 1.0,
            min: 0,
            max: 4,
            step: 0.01,
            ...createSetters("scaleX", 1.0),
          },
          scaleY: {
            name: "Scale Y",
            label: "Y",
            value: 1.0,
            min: 0,
            max: 4,
            step: 0.01,
            ...createSetters("scaleY", 1.0),
          },
          rotation: {
            name: "Rotation",
            label: "Rotation",
            value: 0.0,
            min: -180,
            max: 180,
            step: 1,
            unit: "°",
            ...createSetters("rotation", 0.0),
          },
          boundaryMode: {
            name: "Boundary Mode",
            label: "Boundary",
            value: 1,
            options: BOUNDARY_MODES,
            ...createSetters("boundaryMode", 1),
          },
          dynamicsThreshold: {
            name: "Dynamics Threshold",
            label: "Threshold",
            value: -20.0,
            min: -100,
            max: 0,
            step: 0.1,
            unit: "dB",
            ...createSetters("dynamicsThreshold", -20.0),
          },
          dynamicsRatio: {
            name: "Dynamics Ratio",
            label: "Ratio",
            value: 4.0,
            min: 1,
            max: 20,
            step: 0.1,
            ...createSetters("dynamicsRatio", 4.0),
          },
          dynamicsMakeupGain: {
            name: "Dynamics Makeup Gain",
            label: "Makeup Gain",
            value: 0.0,
            min: 0,
            max: 20,
            step: 0.1,
            unit: "dB",
            ...createSetters("dynamicsMakeupGain", 0.0),
          },
          dynamicsAttack: {
            name: "Dynamics Attack",
            label: "Attack",
            value: 0.01,
            min: 0,
            max: 1,
            step: 0.001,
            unit: "s",
            ...createSetters("dynamicsAttack", 0.01),
          },
          dynamicsRelease: {
            name: "Dynamics Release",
            label: "Release",
            value: 0.1,
            min: 0,
            max: 1,
            step: 0.001,
            unit: "s",
            ...createSetters("dynamicsRelease", 0.1),
          },
          dynamicsKnee: {
            name: "Dynamics Knee",
            label: "Knee",
            value: 10.0,
            min: 0,
            max: 40,
            step: 0.1,
            unit: "dB",
            ...createSetters("dynamicsKnee", 10.0),
          },
          scaleAmount: {
            name: "Scale Amount",
            label: "Scale Amount",
            value: 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            ...createSetters("scaleAmount", 100),
          },
          transientIntensity: {
            name: "Transient Intensity",
            label: "Transient Intensity",
            value: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
            ...createSetters("transientIntensity", 0.5),
          },
          transientThreshold: {
            name: "Transient Threshold",
            label: "Transient Threshold",
            value: 0.01,
            min: 0,
            max: 1,
            step: 0.001,
            ...createSetters("transientThreshold", 0.01),
          },
          alignPhases: {
            name: "Align Phases",
            label: "Align Phases",
            value: false,
            ...createSetters("alignPhases", false),
          },
          openFilePaths: [],
          openFile: (file) =>
            set((state) => {
              if (openFiles[file.filePath]) {
                return state;
              }
              openFiles[file.filePath] = file;
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
