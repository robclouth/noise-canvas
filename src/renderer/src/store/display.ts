import { startCase } from "lodash-es";
import { ScaleType } from "tonal";
import { BANDS_PER_OCTAVE_VALUES, BEAT_VALUES, PITCH_VALUES } from "../lib/constants";
import type { DisplayState, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

export const createDisplaySlice = (set: ZustandSet, get: ZustandGet): DisplayState => {
  const param = makeCreateParameter<DisplayState>(set, get);

  return {
    ...param("displayMinDb", {
      kind: "number",
      name: "Display Min dB",
      label: "Min dB",
      description: "The minimum decibel level displayed in the spectrogram.",
      value: -70.0,
      min: -120,
      max: 0,
      step: 1,
      unit: "dB",
    }),

    ...param("displayMaxDb", {
      kind: "number",
      name: "Display Max dB",
      label: "Max dB",
      description: "The maximum decibel level displayed in the spectrogram.",
      value: 0.0,
      min: -120,
      max: 24,
      step: 1,
      unit: "dB",
    }),

    ...param("magnitudeLimit", {
      kind: "number",
      name: "Magnitude Limit",
      label: "Mag. Limit",
      description: "The maximum magnitude limit for the spectrogram.",
      value: 1.0,
      min: 0.0,
      max: 2.0,
      step: 0.01,
      unit: "x",
    }),

    ...param("gridSizeBeats", {
      kind: "number",
      name: "Grid Size Beats",
      label: "Beats",
      description: "The horizontal grid size in beats.",
      value: 1,
      min: 0,
      max: 32,
      step: 0.0001,
      marks: [{ value: 0, label: "Off" }, ...BEAT_VALUES],
      scale: "log",
    }),
    ...param("gridSizeSemis", {
      kind: "number",
      name: "Grid Size Semis",
      label: "Semis",
      description: "The vertical grid size in semitones.",
      value: 24,
      min: 0,
      max: 96,
      step: 1,
      marks: [{ value: 0, label: "Off" }, ...PITCH_VALUES],
    }),

    ...param("minFreq", {
      kind: "number",
      name: "Minimum Frequency",
      label: "Min. Freq.",
      description: "The minimum frequency of the spectrogram.",
      value: 16.3516, // C0
      min: 10,
      max: 100,
      step: 0.01,
      unit: "Hz",
    }),

    ...param("normalize", {
      kind: "boolean",
      name: "Normalize",
      label: "Normalize",
      description: "Normalizes the audio output.",
      value: true,
    }),

    ...param("scaleTonic", {
      kind: "options",
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
    }),

    ...param("scaleType", {
      kind: "options",
      name: "Scale Type",
      label: "Type",
      description: "The type of scale to use.",
      value: "major",
      options: ScaleType.all().map(({ name }) => ({
        value: name,
        label: startCase(name),
      })),
    }),

    ...param("bandsPerOctave", {
      kind: "options",
      name: "Resolution Mode",
      label: "Resolution",
      description:
        "Balance between time and frequency resolution. Time resolution gives sharper transients, frequency resolution gives more precise pitch detail.",
      value: 36,
      options: BANDS_PER_OCTAVE_VALUES,
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
