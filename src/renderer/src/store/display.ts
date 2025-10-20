import { startCase } from "lodash-es";
import { ScaleType } from "tonal";
import { ALGORITHMS, BANDS_PER_OCTAVE_VALUES, BEAT_VALUES, BLEND_MODES, PITCH_VALUES } from "../lib/constants";
import type { DisplayState, ZustandSet } from "./types";
import { createParameter } from "./utils";

export const createDisplaySlice = (set: ZustandSet): DisplayState => ({
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
  mousePos: null,
  setMousePos: (mousePos) => set({ mousePos }),
  hoveredFile: null,
  setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
  sectionCollapsed: {},
  setSectionCollapsed: (section, collapsed) =>
    set((state) => ({
      sectionCollapsed: { ...state.sectionCollapsed, [section]: collapsed },
    })),
});
