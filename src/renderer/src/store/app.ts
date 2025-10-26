import { startCase } from "lodash-es";
import { Vector2 } from "three";
import { ScaleType } from "tonal";
import { BANDS_PER_OCTAVE_VALUES, BEAT_VALUES, PITCH_VALUES } from "../lib/constants";
import type { BooleanParameter, NumberParameter, OptionsParameter, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

export interface AppState {
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

  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (section: string, collapsed: boolean) => void;
}

export const createAppSlice = (set: ZustandSet, get: ZustandGet): AppState => {
  const param = makeCreateParameter<AppState>(set, get);

  return {
    ...param("displayMinDb", {
      kind: "number",
      name: "Display Min dB",
      label: "Min dB",
      description: "The minimum decibel level displayed in the spectrogram.",
      value: -70.0,
      default: -70.0,
      min: -120,
      max: 0,
      step: 1,
      unit: "dB",
      includeInPresets: false,
    }),

    ...param("displayMaxDb", {
      kind: "number",
      name: "Display Max dB",
      label: "Max dB",
      description: "The maximum decibel level displayed in the spectrogram.",
      value: 0.0,
      default: 0.0,
      min: -120,
      max: 24,
      step: 1,
      unit: "dB",
      includeInPresets: false,
    }),

    ...param("magnitudeLimit", {
      kind: "number",
      name: "Magnitude Limit",
      label: "Mag. Limit",
      description: "The maximum magnitude limit for the spectrogram.",
      value: 1.0,
      default: 1.0,
      min: 0.0,
      max: 2.0,
      step: 0.01,
      unit: "x",
      includeInPresets: false,
    }),

    ...param("gridSizeBeats", {
      kind: "number",
      name: "Grid Size Beats",
      label: "Beats",
      description: "The horizontal grid size in beats.",
      value: 1,
      default: 1,
      min: 0,
      max: 32,
      step: 0.0001,
      marks: [{ value: 0, label: "Off" }, ...BEAT_VALUES],
      scale: "log",
      includeInPresets: false,
    }),
    ...param("gridSizeSemis", {
      kind: "number",
      name: "Grid Size Semis",
      label: "Semis",
      description: "The vertical grid size in semitones.",
      value: 24,
      default: 24,
      min: 0,
      max: 96,
      step: 1,
      marks: [{ value: 0, label: "Off" }, ...PITCH_VALUES],
      includeInPresets: false,
    }),

    ...param("minFreq", {
      kind: "number",
      name: "Minimum Frequency",
      label: "Min. Freq.",
      description: "The minimum frequency of the spectrogram.",
      value: 16.3516, // C0
      default: 16.3516,
      min: 10,
      max: 100,
      step: 0.01,
      unit: "Hz",
      includeInPresets: false,
    }),

    ...param("normalize", {
      kind: "boolean",
      name: "Normalize",
      label: "Normalize",
      description: "Normalizes the audio output.",
      value: true,
      default: true,
      includeInPresets: false,
    }),

    ...param("scaleTonic", {
      kind: "options",
      name: "Scale Tonic",
      label: "Tonic",
      description: "The root note of the scale.",
      value: "C",
      default: "C",
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
      includeInPresets: false,
    }),

    ...param("scaleType", {
      kind: "options",
      name: "Scale Type",
      label: "Type",
      description: "The type of scale to use.",
      value: "major",
      default: "major",
      options: ScaleType.all().map(({ name }) => ({
        value: name,
        label: startCase(name),
      })),
      includeInPresets: false,
    }),

    ...param("bandsPerOctave", {
      kind: "options",
      name: "Resolution Mode",
      label: "Resolution",
      description:
        "Balance between time and frequency resolution. Time resolution gives sharper transients, frequency resolution gives more precise pitch detail.",
      value: 36,
      default: 36,
      options: BANDS_PER_OCTAVE_VALUES,
      includeInPresets: false,
    }),

    // ---------------- Plain state fields ----------------
    mousePos: null,
    setMousePos: (mousePos) => set({ mousePos }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
    sectionCollapsed: {},
    setSectionCollapsed: (section, collapsed) =>
      set((state) => ({
        sectionCollapsed: { ...state.sectionCollapsed, [section]: collapsed },
      })),
  };
};
