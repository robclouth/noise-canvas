import { deepMerge } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { produce } from "immer";
import { isEqual, startCase } from "lodash-es";
import { Vector2 } from "three";
import { ScaleType } from "tonal";
import * as Tone from "tone";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import { effects, EffectType } from "./effects";
import {
  ALGORITHMS,
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
  WRAP_MODES,
} from "./lib/constants";
import { getPresetManager } from "./lib/preset-manager";
import { BrushPresetType } from "./lib/preset-schema";
import { defaultPresets, PRESET_KEYS } from "./lib/presets";
import { getUndoManager } from "./lib/undo-manager";
import {
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  FileSettings,
  OpenFile,
  OptionsParameter,
  Parameter,
} from "./types";

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<Enumerate<T>, Enumerate<F>>;

type ModulatableParameterKey =
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
} & {
  [K in Range<1, 4> as `modulator${K}ImagePath`]: string | null;
} & {
  [K in Range<1, 4> as `setModulator${K}ImagePath`]: (path: string | null) => void;
} & {
  [K in Range<1, 4> as `modulator${K}PhaseMode`]: OptionsParameter<number>;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMinDb`]: ContinuousNumberParameter;
} & {
  [K in Range<1, 4> as `modulator${K}EnvelopeMaxDb`]: ContinuousNumberParameter;
};

const persistedKeys: (keyof State)[] = [
  "fileSettings",
  "effectOrder",
  "effectsEnabled",
  "sectionCollapsed",
  "presetHotkeys",
  "loop",
];

// Helper to generate unique file IDs
function generateFileId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

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
  sourcePosition: { beats: number; pitch: number; fileId: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) => void;
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
  brushWrapMode: OptionsParameter<number>;

  // Effect Order and Enabled States
  effectOrder: EffectType[];
  setEffectOrder: (effectOrder: EffectType[]) => void;
  effectsEnabled: Record<EffectType, boolean>;
  setEffectEnabled: (effect: EffectType, enabled: boolean) => void;

  // Section Collapse States
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (section: string, collapsed: boolean) => void;

  setFileZoom: (fileId: string, zoom: number) => void;
  setFileOffset: (fileId: string, offset: number) => void;

  // Per-file Dirty State (not persisted, keyed by file ID)
  filesDirty: Record<string, boolean>;
  setFileDirty: (fileId: string, dirty: boolean) => void;

  // Display Controls
  displayMinDb: ContinuousNumberParameter;
  displayMaxDb: ContinuousNumberParameter;

  // Magnitude Limit
  magnitudeLimit: ContinuousNumberParameter;

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
  algorithm: OptionsParameter<number>;

  // Dynamics Brush
  dynamicsThresholdDb: ContinuousNumberParameter;
  dynamicsUpperRatio: ContinuousNumberParameter;
  dynamicsLowerRatio: ContinuousNumberParameter;
  dynamicsKnee: ContinuousNumberParameter;
  dynamicsGainDb: ContinuousNumberParameter;

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
  blurOrigin: OptionsParameter<number>;

  // Sharpen Brush
  sharpenAmountTime: ContinuousNumberParameter;
  sharpenAmountPitch: ContinuousNumberParameter;

  // Harmonics Brush
  harmonicsPower: ContinuousNumberParameter;
  harmonicsFalloff: ContinuousNumberParameter;

  // UI State
  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;

  // Files (keyed by file ID)
  openFileIds: string[];
  openFilePath: (filePath: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
  saveActiveFileAs: () => Promise<void>;
  saveActiveFileVersion: () => Promise<void>;
  closeFile: (fileId: string) => void;
  closeAllFiles: () => void;
  reanalyzeActiveFile: () => Promise<void>;
  synthesizeFile: (fileId: string) => Promise<void>;
  fileSettings: Record<string, FileSettings>;
  getFileSettings: (fileId: string) => FileSettings | null;
  setFileBpm: (fileId: string, bpm: number) => void;
  setFileResolution: (fileId: string, resolution: number) => void;
  activeFileId: string | null;
  setActiveFileId: (activeFileId: string | null) => void;
  sourceFile: { id: string; mode: "current" | "original" } | null;
  setSourceFile: (sourceFile: { id: string; mode: "current" | "original" } | null) => void;

  // Audio Playback
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  setPlaybackTime: (playbackTime: number) => void;
  togglePlayback: () => Promise<void>;
  stopAudio: () => void;
} & ModulatorAmountParameters &
  ModulatorParameters & {
    // Presets
    currentPresetId: string | null;
    availablePresets: BrushPresetType[];
    setCurrentPresetId: (presetId: string | null) => void;
    loadPresets: () => Promise<void>;
    loadPreset: (presetId: string) => void;
    savePreset: (name: string, presetId?: string) => Promise<void>;
    deletePreset: (presetId: string) => Promise<void>;
    assignHotkeyToPreset: (presetId: string, hotkey: string) => void;
    presetHotkeys: Record<string, string>;
  };

// Helpproduce(er type to extract keys of state that are parameters
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
          name: `Modulator Depth ${i + 1}`,
          label: "Depth",
          description: "The depth of the modulator.",
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
    // Add image path as plain string (not a parameter)
    const imagePathKey = `modulator${i + 1}ImagePath`;
    const setterKey = `setModulator${i + 1}ImagePath`;
    params = {
      ...params,
      [imagePathKey]: "",
      [setterKey]: (path: string) => set({ [imagePathKey]: path }),
    };
    paramKey = `modulator${i + 1}PhaseMode`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Phase Mode ${i + 1}`,
          label: "Phase",
          description: "Whether the phase is anchored to the canvas or the brush position.",
          value: 0,
          options: [
            { value: 0, label: "Canvas" },
            { value: 1, label: "Brush" },
          ],
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}EnvelopeMinDb`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Envelope Min ${i + 1}`,
          label: "Min dB",
          description: "The minimum gain in dB for the envelope follower.",
          value: -60,
          min: -120,
          max: 0,
          step: 1,
          unit: "dB",
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}EnvelopeMaxDb`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Envelope Max ${i + 1}`,
          label: "Max dB",
          description: "The maximum gain in dB for the envelope follower.",
          value: 0,
          min: -120,
          max: 0,
          step: 1,
          unit: "dB",
        },
        true,
      ),
    };
  }
  return params;
}

// Open files keyed by file ID
export const openFiles: Record<string, OpenFile> = {};

// Helper to get file by ID
export function getFileById(fileId: string): OpenFile | undefined {
  return openFiles[fileId];
}

// Helper to find file ID by path
export function getFileIdByPath(filePath: string): string | undefined {
  return Object.keys(openFiles).find((id) => openFiles[id].filePath === filePath);
}

export const player = new Tone.Player().toDestination();

// Set up event listener for when playback ends
player.onstop = () => {
  const state = useStore.getState();
  if (state.isPlaying && !state.loop) {
    state.stopAudio();
  }
};

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => {
        const initialState = {
          ...createParameter(
            set,
            "brushIntensity",
            {
              name: "Brush Strength",
              label: "Strength",
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
              label: "Feather H",
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
              label: "Feather V",
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
          setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) =>
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
              label: "Lock size",
              description: "Locks the brush size to the grid size.",
              value: false as boolean,
            },

            false,
          ),
          ...createParameter(
            set,
            "brushWrapMode",
            {
              name: "Wrap Mode",
              label: "Wrap",
              description: "Controls whether the brush wraps around the edges of the canvas.",
              value: 0,
              options: WRAP_MODES,
            },
            false,
          ),
          // Per-file zoom and offset state
          filesZoom: {},
          filesOffset: {},
          setFileZoom: (fileId: string, zoom: number) =>
            set(
              produce((state: State) => {
                const file = openFiles[fileId];
                if (file) {
                  state.fileSettings[file.filePath].zoom = zoom;
                }
              }),
            ),
          setFileOffset: (fileId: string, offset: number) =>
            set(
              produce((state: State) => {
                const file = openFiles[fileId];
                if (file) {
                  state.fileSettings[file.filePath].offset = offset;
                }
              }),
            ),
          // Per-file dirty state (not persisted)
          filesDirty: {},
          setFileDirty: (fileId: string, dirty: boolean) => {
            set((state) => ({
              filesDirty: { ...state.filesDirty, [fileId]: dirty },
            }));
          },
          ...createParameter(
            set,
            "displayMinDb",
            {
              name: "Display Min dB",
              label: "Min dB",
              description: "The minimum decibel level displayed in the spectrogram.",
              value: -70.0,
              min: -120,
              max: 0,
              step: 1,
              unit: "dB",
            },
            false,
          ),
          ...createParameter(
            set,
            "displayMaxDb",
            {
              name: "Display Max dB",
              label: "Max dB",
              description: "The maximum decibel level displayed in the spectrogram.",
              value: 0.0,
              min: -120,
              max: 24,
              step: 1,
              unit: "dB",
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
              options: BANDS_PER_OCTAVE_VALUES,
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
            "magnitudeLimit",
            {
              name: "Magnitude Limit",
              label: "Mag. Limit",
              description: "The maximum magnitude limit for the spectrogram.",
              value: 1.0,
              min: 0.0,
              max: 2.0,
              step: 0.01,
              unit: "x",
            },
            false,
          ),
          ...createParameter(
            set,
            "algorithm",
            {
              name: "Warp Algorithm",
              label: "Warp algo",
              description: "The algorithm to use when warping the spectrogram.",
              value: 3,
              options: ALGORITHMS,
            },
            false,
          ),
          ...createParameter(
            set,
            "blendMode",
            {
              name: "Blend Mode",
              label: "Blend mode",
              description: "The blend mode to use when applying the brush.",
              value: 0,
              options: BLEND_MODES,
            },
            false,
          ),

          ...createParameter(
            set,
            "dynamicsThresholdDb",
            {
              name: "Threshold",
              label: "Threshold",
              description: "The threshold level for dynamics processing in decibels.",
              value: -20.0,
              min: -60,
              max: 0,
              step: 0.1,
              unit: "dB",
            },
            true,
          ),
          ...createParameter(
            set,
            "dynamicsUpperRatio",
            {
              name: "Upper Ratio",
              label: "Upper",
              description:
                "Gain multiplier for signals above threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
              value: 1.0,
              min: -8.0,
              max: 8.0,
              step: 0.1,
              unit: "×",
            },
            true,
          ),
          ...createParameter(
            set,
            "dynamicsLowerRatio",
            {
              name: "Lower Ratio",
              label: "Lower",
              description:
                "Gain multiplier for signals below threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
              value: 1.0,
              min: -8.0,
              max: 8.0,
              step: 0.1,
              unit: "×",
            },
            true,
          ),
          ...createParameter(
            set,
            "dynamicsKnee",
            {
              name: "Knee",
              label: "Knee",
              description:
                "Width of the transition zone around the threshold. 0 = hard/sharp, higher = softer/smoother.",
              value: 6.0,
              min: 0.0,
              max: 48.0,
              step: 0.5,
              unit: "dB",
            },
            true,
          ),
          ...createParameter(
            set,
            "dynamicsGainDb",
            {
              name: "Gain",
              label: "Gain",
              description: "The amount of gain to apply in decibels.",
              value: 0.0,
              min: -80,
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
            "blurOrigin",
            {
              name: "Blur Origin",
              label: "Origin",
              description: "Controls where the convolution starts. Left is useful for reverbs to blur forward in time.",
              value: 0,
              options: [
                { value: 0, label: "Left" },
                { value: 1, label: "Middle" },
                { value: 2, label: "Right" },
              ],
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
              min: 0,
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
          openFileIds: [],
          openFilePath: async (filePath: string) => {
            const state = get();
            // Check if file is already open by path
            const existingFileId = getFileIdByPath(filePath);
            if (existingFileId) {
              // File already open, just activate it
              set({ activeFileId: existingFileId });
              return state;
            }

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

            // Generate unique file ID
            const fileId = generateFileId();
            openFiles[fileId] = {
              id: fileId,
              filePath,
              spectrogramData,
            };

            console.log(openFiles);

            return set(
              produce((state: State) => {
                state.openFileIds.push(fileId);
                const fileSettings = state.fileSettings[filePath] || {};

                if (!fileSettings.bpm) fileSettings.bpm = 120;
                if (!fileSettings.bandsPerOctave) fileSettings.bandsPerOctave = state.bandsPerOctave.value;
                if (!fileSettings.zoom) fileSettings.zoom = 0;
                if (!fileSettings.offset) fileSettings.offset = 0;

                state.fileSettings[filePath] = fileSettings;

                if (!state.sourceFile) state.sourceFile = { id: fileId, mode: "current" };
                state.activeFileId = fileId;
              }),
            );
          },
          saveActiveFile: async () => {
            const state = get();
            if (!state.activeFileId) return;
            const file = openFiles[state.activeFileId];
            if (!file || !file.audioBuffer) return;

            const filePath = file.filePath;
            const fileName = window.nodePath.basename(filePath);

            // Show confirmation modal
            return new Promise<void>((resolve) => {
              modals.openConfirmModal({
                title: "Overwrite File",
                children: `Do you want to overwrite "${fileName}"?`,
                labels: { confirm: "Overwrite", cancel: "Cancel" },
                confirmProps: { color: "red", size: "xs" },
                cancelProps: { size: "xs" },
                styles: {
                  title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
                  body: { fontSize: "var(--mantine-font-size-sm)" },
                },
                onConfirm: async () => {
                  try {
                    // Extract audio channels from AudioBuffer
                    const numChannels = file.audioBuffer!.numberOfChannels;
                    const audioChannels: Float32Array[] = [];
                    for (let i = 0; i < numChannels; i++) {
                      audioChannels.push(file.audioBuffer!.getChannelData(i));
                    }

                    // Determine format from file extension
                    const ext = window.nodePath.extname(filePath).slice(1).toLowerCase();
                    const format = ext || "wav";

                    // Export the audio
                    await window.audioAnalysis.exportAudio(
                      audioChannels,
                      filePath,
                      file.audioBuffer!.sampleRate,
                      format,
                    );

                    // Mark as not dirty
                    get().setFileDirty(state.activeFileId!, false);
                    console.log("File saved successfully:", filePath);

                    // Show success notification
                    notifications.show({
                      title: "File saved",
                      message: `Successfully saved ${fileName}`,
                    });
                  } catch (error) {
                    console.error("Error saving file:", error);
                    // Show error notification
                    notifications.show({
                      title: "Save failed",
                      message: `Failed to save ${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`,
                      color: "red",
                    });
                  }
                  resolve();
                },
                onCancel: () => resolve(),
              });
            });
          },
          saveActiveFileAs: async () => {
            const state = get();
            if (!state.activeFileId) return;
            const file = openFiles[state.activeFileId];
            if (!file || !file.audioBuffer) return;

            const currentFilePath = file.filePath;
            const currentFileName = window.nodePath.basename(currentFilePath);
            const currentDir = window.nodePath.dirname(currentFilePath);

            // Show save dialog (we'll need to add this to IPC)
            const result = await window.ipcRenderer.invoke("show-save-dialog", {
              defaultPath: window.nodePath.join(currentDir, currentFileName),
              filters: [
                { name: "Audio Files", extensions: ["wav", "flac", "mp3"] },
                { name: "All Files", extensions: ["*"] },
              ],
            });

            if (result.canceled || !result.filePath) return;

            const outputPath = result.filePath;

            try {
              // Extract audio channels from AudioBuffer
              const numChannels = file.audioBuffer.numberOfChannels;
              const audioChannels: Float32Array[] = [];
              for (let i = 0; i < numChannels; i++) {
                audioChannels.push(file.audioBuffer.getChannelData(i));
              }

              // Determine format from file extension
              const ext = window.nodePath.extname(outputPath).slice(1).toLowerCase();
              const format = ext || "wav";

              // Export the audio
              await window.audioAnalysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

              // Update file path in openFiles
              file.filePath = outputPath;

              // Mark as not dirty
              get().setFileDirty(state.activeFileId!, false);
              console.log("File saved as:", outputPath);

              // Show success notification
              const savedFileName = window.nodePath.basename(outputPath);
              notifications.show({
                title: "File saved",
                message: `Successfully saved as ${savedFileName}`,
              });
            } catch (error) {
              console.error("Error saving file as:", error);
              // Show error notification
              notifications.show({
                title: "Save failed",
                message: `Failed to save file: ${error instanceof Error ? error.message : "Unknown error"}`,
                color: "red",
              });
            }
          },
          saveActiveFileVersion: async () => {
            const state = get();
            if (!state.activeFileId) return;
            const file = openFiles[state.activeFileId];
            if (!file || !file.audioBuffer) return;

            const currentFilePath = file.filePath;
            const dir = window.nodePath.dirname(currentFilePath);
            const ext = window.nodePath.extname(currentFilePath);
            const baseName = window.nodePath.basename(currentFilePath, ext);

            // Check if filename ends with _NUMBER
            const versionMatch = baseName.match(/^(.+)_(\d+)$/);
            let newFileName: string;

            if (versionMatch) {
              // Increment existing version number
              const nameWithoutVersion = versionMatch[1];
              const currentVersion = parseInt(versionMatch[2], 10);
              const newVersion = currentVersion + 1;
              newFileName = `${nameWithoutVersion}_${newVersion}${ext}`;
            } else {
              // Add _1 to the filename
              newFileName = `${baseName}_1${ext}`;
            }

            const outputPath = window.nodePath.join(dir, newFileName);

            try {
              // Extract audio channels from AudioBuffer
              const numChannels = file.audioBuffer.numberOfChannels;
              const audioChannels: Float32Array[] = [];
              for (let i = 0; i < numChannels; i++) {
                audioChannels.push(file.audioBuffer.getChannelData(i));
              }

              // Determine format from file extension
              const format = ext.slice(1).toLowerCase() || "wav";

              // Export the audio
              await window.audioAnalysis.exportAudio(audioChannels, outputPath, file.audioBuffer.sampleRate, format);

              // Update file path in openFiles
              file.filePath = outputPath;

              // Mark as not dirty
              get().setFileDirty(state.activeFileId!, false);
              console.log("File version saved:", outputPath);

              // Show success notification
              notifications.show({
                title: "Version saved",
                message: `Successfully saved as ${newFileName}`,
              });
            } catch (error) {
              console.error("Error saving file version:", error);
              // Show error notification
              notifications.show({
                title: "Save failed",
                message: `Failed to save version: ${error instanceof Error ? error.message : "Unknown error"}`,
                color: "red",
              });
            }
          },
          closeFile: (fileId: string) =>
            set(
              produce((state: State) => {
                const openFile = openFiles[fileId];
                if (openFile) {
                  state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
                  delete state.fileSettings[openFile.filePath];
                  delete state.filesDirty[fileId];
                  delete openFiles[fileId];

                  const nextFileId = state.openFileIds[state.openFileIds.length - 1] || null;
                  state.activeFileId = nextFileId || null;

                  // If the file being closed is the source file, set the source file to the next file
                  if (!nextFileId) state.sourceFile = null;
                  else if (state.sourceFile?.id === fileId) {
                    state.sourceFile = {
                      id: nextFileId,
                      mode: "current",
                    };
                  }
                }
              }),
            ),
          closeAllFiles: () => {
            // Clear the openFiles object
            Object.keys(openFiles).forEach((fileId) => {
              delete openFiles[fileId];
            });

            return set({
              openFileIds: [],
              filesDirty: {},
              activeFileId: null,
              sourceFile: null,
            });
          },
          synthesizeFile: async (fileId: string) => {
            const state = get();
            if (!state.activeFileId) return;

            try {
              const totalStart = performance.now();
              console.log("runSynthesis");
              const { normalize, bandsPerOctave, minFreq, isPlaying } = useStore.getState();
              const file = openFiles[fileId];
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

              // Mark file as dirty after synthesis
              get().setFileDirty(fileId, true);

              if (isPlaying && state.activeFileId && state.activeFileId === fileId) {
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
            if (!state.activeFileId) return;
            const file = openFiles[state.activeFileId];

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
                if (!state.activeFileId) return;
                const audioBuffer = file?.audioBuffer;
                console.log(window.audioAnalysis);
                const result = audioBuffer
                  ? await window.audioAnalysis.analyseBuffer(audioBuffer, {
                      bandsPerOctave: state.bandsPerOctave.value,
                      minFreq: state.minFreq.value,
                    })
                  : await window.audioAnalysis.analyze(file.filePath, {
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

                const undoManager = getUndoManager(state.activeFileId);
                undoManager.clear();

                return set(
                  produce((state: State) => {
                    const file = state.activeFileId && openFiles[state.activeFileId];
                    if (file) {
                      state.fileSettings[file.filePath].bandsPerOctave = state.bandsPerOctave.value;
                    }
                  }),
                );
              },
            });
          },
          fileSettings: {},
          getFileSettings: (fileId: string) => {
            const file = openFiles[fileId];
            if (file) return get().fileSettings[file.filePath];
            return null;
          },
          setFileBpm: (fileId, bpm) =>
            set(
              produce((state: State) => {
                if (state.activeFileId === fileId && bpm) {
                  Tone.getTransport().bpm.value = bpm;
                }

                const file = openFiles[fileId];
                if (file) state.fileSettings[file.filePath].bpm = bpm;
              }),
            ),
          setFileResolution: (fileId, resolution) =>
            set(
              produce((state: State) => {
                const file = openFiles[fileId];
                if (file) {
                  state.fileSettings[file.filePath].bandsPerOctave = resolution;
                }
              }),
            ),
          activeFileId: null,
          setActiveFileId: (activeFileId) => {
            if (activeFileId && openFiles[activeFileId]) {
              const file = openFiles[activeFileId];
              const { fileSettings } = get();
              const transport = Tone.getTransport();
              transport.bpm.value = fileSettings[file.filePath].bpm;

              if (file.audioBuffer) {
                transport.setLoopPoints(0, file.audioBuffer.duration);
                player.buffer = new Tone.ToneAudioBuffer(file.audioBuffer);
              }

              get().stopAudio();
            }
            set({ activeFileId });
          },
          sourceFile: null,
          setSourceFile: (sourceFile) => set({ sourceFile }),
          togglePlayback: async () => {
            const { isPlaying, activeFileId, loop, fileSettings } = get();
            if (isPlaying) {
              const transport = Tone.getTransport();
              transport.stop();
              transport.cancel(0);

              return set({ isPlaying: false });
            }
            const file = activeFileId ? openFiles[activeFileId] : undefined;
            const audioBuffer = file?.audioBuffer;

            if (audioBuffer) {
              if (Tone.getContext().rawContext.state !== "running") {
                await Tone.start();
              }
              player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
              player.fadeIn = 0.01;
              player.fadeOut = 0.01;
              player.sync().start(0);

              const transport = Tone.getTransport();
              transport.bpm.value = fileSettings[file.filePath].bpm;
              transport.setLoopPoints(0, audioBuffer.duration);
              transport.loop = loop;
              transport.start();

              return set({ isPlaying: true });
            } else {
              console.error("No audio buffer available to play.");
              return;
            }
          },
          isPlaying: false,
          setIsPlaying: (isPlaying) => set({ isPlaying }),
          loop: false,
          setLoop: (loop) => {
            Tone.getTransport().loop = loop;
            set({ loop });
          },
          setPlaybackTime: (playbackTime) => {
            const transport = Tone.getTransport();
            transport.seconds = playbackTime;
          },
          stopAudio: () => {
            const transport = Tone.getTransport();
            transport.stop();
            player.stop();
            set({ isPlaying: false });
          },

          mousePos: null,
          setMousePos: (mousePos) => set({ mousePos }),
          hoveredFile: null,
          setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
          effectOrder: ["synthesize", "dynamics", "transform", "harmonics", "blur"] satisfies EffectType[],
          setEffectOrder: (effectOrder) => set({ effectOrder }),
          effectsEnabled: {
            dynamics: false,
            transform: false,
            harmonics: false,
            blur: false,
            synthesize: false,
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

            if (presetId === state.currentPresetId) {
              return;
            }

            const preset = state.availablePresets.find((p) => p.id === presetId);
            if (!preset) {
              notifications.show({
                title: "Preset not found",
                message: `Preset ${presetId} not found`,
                color: "red",
              });
              set({ currentPresetId: "default" });
              return;
            }

            // Dynamically build the update object from preset keys
            const updates: any = { currentPresetId: presetId };

            for (const key of PRESET_KEYS) {
              const stateValue = state[key];
              const presetValue = preset[key];

              // For parameters (objects with .value), compare the actual values
              if (stateValue && typeof stateValue === "object" && "value" in stateValue) {
                if (stateValue.value !== presetValue) {
                  updates[key] = { ...stateValue, value: presetValue };
                }
              } else {
                // For non-parameter values, use deep comparison for objects
                if (!isEqual(stateValue, presetValue)) {
                  updates[key] = presetValue;
                }
              }
            }

            set(updates);
          },
          savePreset: async (name: string, presetId?: string) => {
            try {
              const state = get();
              const presetManager = getPresetManager();

              // Save preset from state (preset manager handles all the logic)
              const id = await presetManager.savePresetFromState(state, name, presetId);

              // Reload presets
              await state.loadPresets();

              // Set as current preset
              set({ currentPresetId: id });
            } catch (error) {
              console.error("Error saving preset:", error);
              notifications.show({
                title: "Save failed",
                message: `${error instanceof Error ? error.message : "Unknown error"}`,
                color: "red",
              });
            }
          },
          deletePreset: async (presetId: string) => {
            try {
              const state = get();
              const presetManager = getPresetManager();

              await presetManager.deletePreset(presetId);

              // Reload presets
              await state.loadPresets();

              // If we deleted the current preset, switch to default
              if (state.currentPresetId === presetId) {
                set({ currentPresetId: "default" });
              }
            } catch (error) {
              console.error("Error deleting preset:", error);
              notifications.show({
                title: "Delete failed",
                message: `${error instanceof Error ? error.message : "Unknown error"}`,
                color: "red",
              });
            }
          },
          presetHotkeys: {},
          assignHotkeyToPreset: async (presetId: string, hotkey: string) => {
            const preset = get().availablePresets.find((p) => p.id === presetId);
            if (!preset) return;

            set(
              produce((state: State) => {
                Object.entries(state.presetHotkeys).forEach(([key, id]) => {
                  if (id === presetId) {
                    delete state.presetHotkeys[key];
                  }
                });
                state.presetHotkeys[hotkey] = presetId;
              }),
            );

            notifications.show({
              title: "Hotkey assigned",
              message: `Hotkey ${hotkey} assigned to ${preset.name}`,
            });
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
        onRehydrateStorage: () => (state) => {
          if (state) {
            // Get all available effect types (excluding passthrough which is internal)
            const allEffects = (Object.keys(effects) as EffectType[]).filter((key) => key !== "passthrough");
            const currentOrder = state.effectOrder;
            const missingEffects = allEffects.filter((effect) => !currentOrder.includes(effect));

            if (missingEffects.length > 0) {
              // Add missing effects to the end
              const newOrder = [...currentOrder, ...missingEffects];
              state.setEffectOrder(newOrder);

              // Initialize missing effects as disabled in effectsEnabled
              const updatedEnabled = { ...state.effectsEnabled };
              missingEffects.forEach((effect) => {
                if (!(effect in updatedEnabled)) {
                  updatedEnabled[effect] = false;
                }
              });
              state.effectsEnabled = updatedEnabled;
            }
          }
        },
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
    modulatorRateMode: useStore.getState()[`modulator${index}RateMode` as ParameterKey],
    modulatorPhaseMode: useStore.getState()[`modulator${index}PhaseMode` as ParameterKey],
  };
}
