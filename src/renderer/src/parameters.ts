import { startCase } from "lodash-es";
import { ScaleType } from "tonal";
import { shapes } from "./effects/overtones-shapes";
import { DEFAULT_EFFECTS, EffectParams, EffectType } from "./effects/types";
import {
  ALGORITHMS,
  BANDS_PER_OCTAVE_VALUES,
  BEAT_UNIT,
  BEAT_VALUES,
  BLEND_MODES,
  BRUSH_ANCHOR_MODES,
  CONTEXTUAL_MOD_SOURCES,
  EDGE_MODE,
  MODULATOR_MODES,
  MULTIPLIER_UNIT,
  MULTIPLIER_VALUES,
  NUM_MACROS,
  NUM_MODULATORS,
  PATTERN_SHAPES,
  PITCH_VALUES,
  PITCH_VALUES_NO_FRACTIONS,
  SEMITONE_UNIT,
  SYNTHESIZE_TYPES,
  WRAP_MODES,
} from "./lib/constants";
import { host } from "./lib/host";
import { BrushColor, ParameterKey } from "./store/types";

// --- Base Interfaces ---

/** File parameter value. Just the path — position is in separate modulatable params. */
export type FileParameterValue = { path: string } | null;

export interface ParameterBase {
  kind: "number" | "boolean" | "options" | "string" | "file";
  name: string;
  label: string;
  description: string;
  includeInStep?: boolean;
  effectType?: EffectType;
}

export interface NumberParameter extends ParameterBase {
  kind: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  scale?: string;
  leftValue?: { value: number; label: string };
  rightValue?: { value: number; label: string };
  marks?: Array<{ value: number; label: string }>;
  modulatable?: boolean;
  modulationSourcesAllowed?: "all" | "contextualOnly";
}
export interface BooleanParameter extends ParameterBase {
  kind: "boolean";
  default: boolean;
}

export interface StringParameter extends ParameterBase {
  kind: "string";
  default: string;
}

export interface OptionsParameter<T = any> extends ParameterBase {
  kind: "options";
  default: T;
  options: { value: T; label: string }[];
}

export interface FileParameter extends ParameterBase {
  kind: "file";
  default: FileParameterValue;
  /**
   * How the user picks a file for this param.
   * - "canvas" — hijack clicks on open file canvases; the click position seeds companion
   *   offset params (time/pitch). Used by sourceFile for spatial sampling pick.
   * - "modal"  — open a list of currently-open files and pick by name. Companion offset
   *   params are controlled only via their sliders.
   */
  pickMode: "canvas" | "modal";
  /** Canvas-mode only: param to receive click x. */
  timeOffsetParam?: ParameterKey;
  /** Canvas-mode only: param to receive click y. */
  pitchOffsetParam?: ParameterKey;
  /** Canvas-mode only: what indicator to draw while picking. */
  previewMode?: "brushRect";
  /** Canvas-mode only: whether Shift-held activates the picker. */
  enableShortcut?: boolean;
}

export type ParameterDef = NumberParameter | BooleanParameter | OptionsParameter | StringParameter | FileParameter;

type ParameterDefInput = NumberParameter | BooleanParameter | OptionsParameter | StringParameter | FileParameter;

const negBeatMarks = BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroBeatMark = { value: 0, label: "0" };
const posBeatMarks = BEAT_VALUES;
const negPitchMarks = PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroPitchMark = { value: 0, label: "0" };
const posPitchMarks = PITCH_VALUES;
const negMultMarks = MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const posMultMarks = MULTIPLIER_VALUES;
const beatMarksWithOff = [{ value: 0, label: "Off" }, ...BEAT_VALUES];
const beatMarksWithZero = [{ value: 0, label: "0" }, ...BEAT_VALUES];
const semitoneMarksWithOff = [{ value: 0, label: "Off" }, ...PITCH_VALUES];

// --- Modulator Definitions ---
// Nested modulation (modulating modulator parameters) is disabled on Windows
// due to shader compilation performance issues with unrolled loops
const isWindows = typeof window !== "undefined" && host.env.platform === "win32";
const modulatorDefs: Record<string, ParameterDefInput> = {};
for (let i = 0; i < NUM_MODULATORS; i++) {
  const idx = i + 1;
  modulatorDefs[`modulator${idx}Mode`] = {
    kind: "options",
    name: `Modulator Mode ${idx}`,
    label: "Mode",
    description:
      "What drives this modulator. Off: unused. Pattern: a 2D shape scrolled across time and pitch. Envelope: follows the amplitude, phase or pan of the audio under the brush. Sequencer: a step grid you draw by hand.",
    default: 0,
    options: MODULATOR_MODES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PatternShape`] = {
    kind: "options",
    name: `Modulator Pattern Shape ${idx}`,
    label: "Shape",
    description:
      "The 2D shape the pattern draws — waveforms (sine, triangle, square, saw, pulse, random), procedural textures (clouds, cells, ripples, marble and more), the selected scale, or any image dropped into Documents/Noise Canvas/Textures.",
    default: 0,
    options: PATTERN_SHAPES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}Strength`] = {
    kind: "number",
    name: `Modulator Depth ${idx}`,
    label: "Depth",
    description:
      "How far this modulator swings. It scales the pattern before the per-parameter modulation amounts, so it thins out or exaggerates every destination at once. Negative values invert the shape.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PatternRateBeats`] = {
    kind: "number",
    name: `Modulator Pattern Rate Beats ${idx}`,
    label: "Rate ↔",
    description:
      'How long one cycle of the pattern lasts along time. Short values repeat many times across a stroke; "Off" freezes the pattern so it stops varying with time.',
    default: 1,
    min: 0,
    max: 32,
    step: 0.0001,
    marks: beatMarksWithOff,
    scale: "log",
    unit: BEAT_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PatternRateSemis`] = {
    kind: "number",
    name: `Modulator Pattern Rate Semis ${idx}`,
    label: "Rate ↕",
    description:
      'How many semitones one cycle of the pattern spans along pitch. "Off" freezes the pattern so it stops varying with pitch.',
    default: 12,
    min: 0,
    max: 96,
    step: 1,
    marks: semitoneMarksWithOff,
    unit: SEMITONE_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}Rotation`] = {
    kind: "number",
    name: `Modulator Rotation ${idx}`,
    label: "Rotation",
    description: "Rotates the pattern in the time/pitch plane, so its cycles run diagonally instead of along the axes.",
    default: 0,
    min: 0,
    max: 360,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}StereoSpread`] = {
    kind: "number",
    name: `Modulator Stereo Spread ${idx}`,
    label: "Stereo",
    description:
      "Decorrelates the modulator's left and right outputs by offsetting the sample position along the time axis. Negative values swap channels.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PhaseMode`] = {
    kind: "options",
    name: `Modulator Phase Mode ${idx}`,
    label: "Phase Mode",
    description:
      "Whether the pattern is pinned to the file — so the same spot always gets the same value — or to the brush, so it starts from the same place on every stroke.",
    default: 0,
    options: [
      { value: 0, label: "Canvas" },
      { value: 1, label: "Brush" },
    ],
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PhaseX`] = {
    kind: "number",
    name: `Modulator Phase X ${idx}`,
    label: "Phase ↔",
    description:
      "Slides the pattern along time without changing its rate. Use it to offset one modulator against another.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PhaseY`] = {
    kind: "number",
    name: `Modulator Phase Y ${idx}`,
    label: "Phase ↕",
    description:
      "Slides the pattern along pitch without changing its rate. Use it to offset one modulator against another.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}EnvelopeSmoothingBeats`] = {
    kind: "number",
    name: `Modulator Envelope Smoothing ${idx}`,
    label: "Smooth",
    description: "Averages the envelope signal over this window of time to reduce fast transients.",
    default: 0,
    min: 0,
    max: 4,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}EnvelopeSource`] = {
    kind: "options",
    name: `Modulator Envelope Source ${idx}`,
    label: "Source",
    description:
      "Which property of the audio under the brush the follower reads: amplitude, phase, or stereo position.",
    default: 0,
    options: [
      { value: 0, label: "Amplitude" },
      { value: 1, label: "Phase" },
      { value: 2, label: "Panning" },
    ],
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}EnvelopeMinDb`] = {
    kind: "number",
    name: `Modulator Envelope Min ${idx}`,
    label: "Min dB",
    description:
      "The level that maps to zero modulation. Audio quieter than this leaves the parameter at its slider value.",
    default: -60,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}EnvelopeMaxDb`] = {
    kind: "number",
    name: `Modulator Envelope Max ${idx}`,
    label: "Max dB",
    description:
      "The level that maps to full modulation. Audio louder than this drives the parameter as far as the amount allows.",
    default: 0,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}TexturePath`] = {
    kind: "string",
    name: `Modulator Texture Path ${idx}`,
    label: "Texture",
    description:
      "Image file used as the pattern. Drop your own images into Documents/Noise Canvas/Textures to have them appear in the shape list.",
    default: "",
    includeInStep: true,
  };
  // Sequencer mode parameters
  modulatorDefs[`modulator${idx}SeqStepsX`] = {
    kind: "number",
    name: `Sequencer Steps X ${idx}`,
    label: "Steps ↔",
    description: "How many steps the sequencer grid has along time. Each column is one step of the loop.",
    default: 8,
    min: 1,
    max: 16,
    step: 1,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}SeqStepsY`] = {
    kind: "number",
    name: `Sequencer Steps Y ${idx}`,
    label: "Rows ↕",
    description: "How many rows the sequencer grid has along pitch. Each row covers an equal slice of the pitch range.",
    default: 4,
    min: 1,
    max: 8,
    step: 1,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}SeqLoopBeats`] = {
    kind: "number",
    name: `Sequencer Loop Beats ${idx}`,
    label: "Loop ↔",
    description: "How many beats the sequencer grid covers before it repeats along time.",
    default: 1,
    min: 1 / 64,
    max: 32,
    step: 0.0001,
    marks: beatMarksWithOff,
    scale: "log",
    unit: BEAT_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqLoopSemis`] = {
    kind: "number",
    name: `Sequencer Loop Semis ${idx}`,
    label: "Loop ↕",
    description: "How many semitones the sequencer grid covers before it repeats along pitch.",
    default: 12,
    min: 1,
    max: 96,
    step: 1,
    marks: PITCH_VALUES_NO_FRACTIONS,
    unit: SEMITONE_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqSwing`] = {
    kind: "number",
    name: `Sequencer Swing ${idx}`,
    label: "Swing",
    description: "Delays every other step along time for a swung feel. 0% is straight.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqData`] = {
    kind: "string",
    name: `Sequencer Data ${idx}`,
    label: "Seq Data",
    description:
      "The on/off state of every cell in the sequencer grid. Edit it by clicking cells in the grid rather than through this control.",
    default: JSON.stringify({
      values: Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => 1)),
    }),
    includeInStep: true,
  };
}

// --- Macro Definitions ---
// Macros are brush-level modulation sources with user-editable names.
// Their values live on the Brush (macroValues); the parameter def is only
// used so the existing ParameterControl / ParamMenu UI can render them.
const macroDefs: Record<string, ParameterDefInput> = {};
for (let i = 0; i < NUM_MACROS; i++) {
  const idx = i + 1;
  macroDefs[`macro${idx}Value`] = {
    kind: "number",
    name: `Macro ${idx}`,
    label: `Macro ${idx}`,
    description: "User-defined brush macro. Modulates any parameter; renamable via the label menu.",
    default: 50,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    modulatable: true,
    modulationSourcesAllowed: "contextualOnly",
  };
}

// --- Base Definitions (Brush, Effects, App) ---
const baseParameterDefs: Partial<Record<ParameterKey, ParameterDefInput>> = {
  // --- Brush Parameters ---
  brushWrapMode: {
    kind: "options",
    name: "Wrap Mode",
    label: "Wrap",
    description:
      "What happens when a stroke runs off the edge of the file. Off clips it, Time wraps it round to the other end, Pitch wraps it top to bottom, and Time & Pitch does both.",
    default: 0,
    options: WRAP_MODES,
    includeInStep: true,
  },
  brushIntensity: {
    kind: "number",
    name: "Brush Strength",
    label: "Strength",
    description:
      "How much of the effect each stroke applies. At 0% the stroke does nothing; at 100% the effect chain applies in full within the brush envelope.",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushIterations: {
    kind: "number",
    name: "Brush Iterations",
    label: "Iterations",
    description:
      "How many times the effect chain is re-applied to its own output per stroke. This is what turns a single-pass effect into a feedback loop — echoes, spectral delays, and runaway textures.",
    default: 1,
    min: 1,
    max: 20,
    step: 1,
    includeInStep: true,
  },
  brushPan: {
    kind: "number",
    name: "Pan",
    label: "Pan",
    description:
      "Where in the stereo field the stroke lands. -100% is hard left, 0% keeps the source's own placement, +100% is hard right.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSizeTime: {
    kind: "number",
    name: "Brush Size Time",
    label: "Size ↔",
    description:
      'Horizontal brush size. At the minimum ("Grid") it tracks the time grid; at the maximum ("Full") it fills the full file width and anchors to the left edge regardless of cursor position.',
    default: 1,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: [{ value: 0, label: "Grid" }, ...BEAT_VALUES.filter((m) => m.value !== 32), { value: 32, label: "Full" }],
    includeInStep: true,
  },
  brushCurveTime: {
    kind: "number",
    name: "Brush Curve Time",
    label: "Curve ↔",
    description: "Horizontal envelope curve. -100% = sharp spike, 0% = linear triangle, +100% = hard rectangle.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSkewTime: {
    kind: "number",
    name: "Brush Skew Time",
    label: "Skew ↔",
    description:
      "Horizontal position of the envelope peak. -100% = start (pluck), 0% = centered, +100% = end (delayed hit). Contextual Time modulation collapses the envelope to a flat rectangle; use pattern modulators with a period larger than the brush footprint for a sliding peak.",
    default: -100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSizePitch: {
    kind: "number",
    name: "Brush Size Pitch",
    label: "Size ↕",
    description:
      'Vertical brush size. At the minimum ("Grid") it tracks the pitch grid; at the maximum ("Full") it fills the full file height and anchors to the bottom regardless of cursor position.',
    default: 48,
    min: 0,
    max: 128,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: [{ value: 0, label: "Grid" }, ...PITCH_VALUES, { value: 128, label: "Full" }],
    includeInStep: true,
  },
  brushCurvePitch: {
    kind: "number",
    name: "Brush Curve Pitch",
    label: "Curve ↕",
    description: "Vertical envelope curve. -100% = sharp spike, 0% = linear triangle, +100% = hard rectangle.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSkewPitch: {
    kind: "number",
    name: "Brush Skew Pitch",
    label: "Skew ↕",
    description:
      "Vertical position of the envelope peak. -100% = bottom, 0% = centered, +100% = top. Contextual Pitch modulation collapses the envelope to a flat rectangle; use pattern modulators with a period larger than the brush footprint for a sliding peak.",
    default: -100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushAnchorMode: {
    kind: "options",
    name: "Brush Anchor",
    label: "Anchor",
    description:
      "Where the cursor sits on the brush. Corner: cursor is the bottom-left/onset corner — snap locks onsets to the beat grid (best for rhythmic strokes). Center: cursor is the brush center — snap puts the envelope peak on the grid (best for soft/ambient strokes where onset timing doesn't matter).",
    default: 0,
    options: BRUSH_ANCHOR_MODES,
    includeInStep: true,
  },
  blendMode: {
    kind: "options",
    name: "Blend Mode",
    label: "Blend mode",
    description:
      "How the processed result is combined with what was already there. Mix crossfades, Add and Subtract sum and remove, Maximum and Minimum keep the louder or quieter of the two, Mask gates by relative energy.",
    default: 0,
    options: BLEND_MODES,
    includeInStep: true,
  },
  algorithm: {
    kind: "options",
    name: "Warp Algorithm",
    label: "Warp algo",
    description:
      "How audio is resynthesized from the edited spectrogram. Each option trades phase coherence for a different artifact — Neutral is the cleanest, Percussive sharpens transients, Flangey and Noisey smear them. Pick whichever sounds best.",
    default: 4,
    options: ALGORITHMS,
    includeInStep: true,
  },
  sourceFile: {
    kind: "file",
    name: "Source File",
    label: "Source",
    description: "File and position to use as the source for this step. When null, paints from self.",
    default: null,
    includeInStep: true,
    pickMode: "canvas",
    timeOffsetParam: "sourceTimeOffset" as ParameterKey,
    pitchOffsetParam: "sourcePitchOffset" as ParameterKey,
    previewMode: "brushRect",
    enableShortcut: true,
  },
  sourcePositionMode: {
    kind: "options",
    name: "Source Position Mode",
    label: "Tracking",
    description:
      "Whether the source region tracks the brush as you paint (Follow) or stays pinned to the position you picked (Fixed), like a clone-stamp anchor.",
    default: "follow" as const,
    options: [
      { value: "follow", label: "Follow" },
      { value: "fixed", label: "Fixed" },
      { value: "anchored", label: "Anchored" },
    ],
    includeInStep: true,
  },
  sourceDataMode: {
    kind: "options",
    name: "Source Data Mode",
    label: "Read From",
    description: "Whether to use the current (modified) or original (unmodified) data from the source file.",
    default: "current" as const,
    options: [
      { value: "current", label: "Current" },
      { value: "original", label: "Original" },
    ],
    includeInStep: true,
  },
  sourceTimeOffset: {
    kind: "number",
    name: "Source Time",
    label: "Time ↔",
    description: "Where along the source file material is read from, as a percentage of its length.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  sourcePitchOffset: {
    kind: "number",
    name: "Source Pitch",
    label: "Pitch ↕",
    description: "Where in the source file's pitch range material is read from, as a percentage of its height.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },

  // --- Effect Parameters ---
  dynamicsThresholdDb: {
    kind: "number",
    name: "Threshold",
    label: "Threshold",
    description:
      "The level that separates loud from quiet. Bins above it get the Upper Ratio, bins below get the Lower Ratio.",
    default: -20.0,
    min: -60,
    max: 0,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsUpperRatio: {
    kind: "number",
    name: "Upper Ratio",
    label: "Upper",
    description: "Gain multiplier for signals above threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.1,
    unit: "×",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsLowerRatio: {
    kind: "number",
    name: "Lower Ratio",
    label: "Lower",
    description: "Gain multiplier for signals below threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.1,
    unit: "×",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsKnee: {
    kind: "number",
    name: "Knee",
    label: "Knee",
    description: "Width of the transition zone around the threshold. 0 = hard/sharp, higher = softer/smoother.",
    default: 6.0,
    min: 0.0,
    max: 48.0,
    step: 0.5,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsGainDb: {
    kind: "number",
    name: "Gain",
    label: "Gain",
    description: "Output level applied after the ratios. Pull it down to -80 dB to erase the painted region entirely.",
    default: 0.0,
    min: -80,
    max: 24,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  transformShiftBeats: {
    kind: "number",
    name: "Shift Beats",
    label: "Shift ↔",
    description: "Moves the painted region forwards or backwards in time by this many beats.",
    default: 0,
    min: -32,
    max: 32,
    step: 0.01,
    scale: "logBipolar",
    unit: BEAT_UNIT,
    marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformShiftSemis: {
    kind: "number",
    name: "Shift Semis",
    label: "Shift ↕",
    description:
      "Moves the painted region up or down in pitch by this many semitones — a transpose that leaves timing untouched.",
    default: 0.0,
    min: -96,
    max: 96,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformScaleTime: {
    kind: "number",
    name: "Scale Time",
    label: "Scale ↔",
    description:
      "Stretches or squeezes the painted region along time. Above 1x slows it down, below 1x speeds it up, without changing pitch.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformScalePitch: {
    kind: "number",
    name: "Scale Pitch",
    label: "Scale ↕",
    description:
      "Stretches or squeezes the painted region along pitch, spreading its harmonics apart or packing them together.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformRotation: {
    kind: "number",
    name: "Rotation",
    label: "Rotation",
    description: "Rotates the painted region in the time/pitch plane, turning sustained tones into sweeps.",
    default: 0.0,
    min: -180,
    max: 180,
    step: 0.1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description:
      "What fills the space when content is moved out of the brush. Cut discards it, Bleed pulls in the surroundings, Wrap brings it back on the opposite side, Clamp holds the edge value, Reflect folds it back, Invert negates it.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "transform",
  },
  sortDirection: {
    kind: "options",
    name: "Sort Direction",
    label: "Direction",
    description:
      "Which axis the sort runs along. Horizontal smears across time, Vertical across pitch, Both applies each in turn.",
    default: 0,
    options: [
      { value: 0, label: "Horizontal" },
      { value: 1, label: "Vertical" },
      { value: 2, label: "Both" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortOrder: {
    kind: "options",
    name: "Sort Order",
    label: "Order",
    description: "Whether bins are ordered ascending (Forwards) or descending (Backwards) along the sort direction.",
    default: 0,
    options: [
      { value: 0, label: "Forwards" },
      { value: 1, label: "Backwards" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortBy: {
    kind: "options",
    name: "Sort By",
    label: "Sort By",
    description: "The property bins are ranked by: Magnitude, Phase, dB, Frequency, or Pan.",
    default: 0,
    options: [
      { value: 0, label: "Magnitude" },
      { value: 1, label: "Phase" },
      { value: 2, label: "dB" },
      { value: 3, label: "Frequency" },
      { value: 4, label: "Pan" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortStereoMode: {
    kind: "options",
    name: "Sort Stereo Mode",
    label: "Stereo",
    description:
      "Linked sorts both channels by the same ranking and keeps the stereo image intact. Independent sorts each channel on its own, which decorrelates and widens it.",
    default: 0,
    options: [
      { value: 0, label: "Linked" },
      { value: 1, label: "Independent" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  blurAmountTime: {
    kind: "number",
    name: "Blur Amount Time",
    label: "Blur ↔",
    description: "How far the blur reaches along time. Larger values smear onsets into a reverb-like tail.",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurAmountPitch: {
    kind: "number",
    name: "Blur Amount Pitch",
    label: "Blur ↕",
    description: "How far the blur reaches along pitch. Larger values wash neighbouring harmonics together into noise.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurNoiseTime: {
    kind: "number",
    name: "Blur Noise Time",
    label: "Noise ↔",
    description:
      "Randomizes where each blur sample reads from along time, breaking a smooth smear into a grainier, more diffuse tail.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurNoisePitch: {
    kind: "number",
    name: "Blur Noise Pitch",
    label: "Noise ↕",
    description:
      "Randomizes where each blur sample reads from along pitch, scattering harmonics instead of blending them evenly.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurSamplesX: {
    kind: "number",
    name: "Blur Samples Time",
    label: "Samples ↔",
    description:
      "How many samples the time blur takes. More is smoother but slower; too few give a stepped, echoey blur.",
    default: 16,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    effectType: "blur",
  },
  blurSamplesY: {
    kind: "number",
    name: "Blur Samples Pitch",
    label: "Samples ↕",
    description: "How many samples the pitch blur takes. More is smoother but slower; too few give a banded blur.",
    default: 16,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    effectType: "blur",
  },
  blurEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description:
      "What the blur reads once it reaches the brush border. Cut treats the outside as silence, Bleed pulls in the surrounding audio, Wrap reads from the opposite edge, Clamp holds the edge value, Reflect mirrors it, Invert negates it.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "blur",
  },
  blurOrigin: {
    kind: "options",
    name: "Blur Origin",
    label: "Origin",
    description:
      "Where the blur radiates from. Left blurs forward in time for reverb-like tails, Middle spreads symmetrically, Right blurs backwards for reversed swells.",
    default: 0,
    options: [
      { value: 0, label: "Left" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Right" },
    ],
    includeInStep: true,
    effectType: "blur",
  },
  cloneSpaceBeats: {
    kind: "number",
    name: "Clone Space Beats",
    label: "Space ↔",
    description:
      "How far apart successive copies sit along time. Small values give flams and comb filtering, a beat or more gives rhythmic echoes, and negative values run the copies backwards.",
    default: 0.25,
    min: -32,
    max: 32,
    step: 0.001,
    scale: "logBipolar",
    unit: BEAT_UNIT,
    marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneSpaceSemis: {
    kind: "number",
    name: "Clone Space Semis",
    label: "Space ↕",
    description:
      "How far apart successive copies sit along pitch. 12 st stacks octaves, 7 st stacks fifths, and small values give chorus-like detuning.",
    default: 0,
    min: -96,
    max: 96,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneCountX: {
    kind: "number",
    name: "Clone Count Time",
    label: "Copies ↔",
    description: "How many copies are stamped along time, including the original.",
    default: 4,
    min: 1,
    max: 32,
    step: 1,
    includeInStep: true,
    modulatable: false,
    effectType: "clone",
  },
  cloneCountY: {
    kind: "number",
    name: "Clone Count Pitch",
    label: "Copies ↕",
    description: "How many copies are stamped along pitch, including the original.",
    default: 1,
    min: 1,
    max: 32,
    step: 1,
    includeInStep: true,
    modulatable: false,
    effectType: "clone",
  },
  cloneDecay: {
    kind: "number",
    name: "Clone Decay",
    label: "Decay",
    description:
      "How much each successive copy fades. 0% = no fade, 100% = outermost copy is silent. Decays multiply across the time and pitch axes.",
    default: 50,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneDirectionX: {
    kind: "options",
    name: "Clone Direction Time",
    label: "Dir. ↔",
    description:
      "Whether copies trail after the source (Forward), spread both ways (Middle), or lead into it (Backward).",
    default: 0,
    options: [
      { value: 0, label: "Forward" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Backward" },
    ],
    includeInStep: true,
    effectType: "clone",
  },
  cloneDirectionY: {
    kind: "options",
    name: "Clone Direction Pitch",
    label: "Dir. ↕",
    description: "Whether copies stack above the source (Up), spread both ways (Middle), or below it (Down).",
    default: 1,
    options: [
      { value: 0, label: "Up" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Down" },
    ],
    includeInStep: true,
    effectType: "clone",
  },
  cloneEdgeMode: {
    kind: "options",
    name: "Clone Edge Mode",
    label: "Edge",
    description:
      "What happens to copies that land outside the brush. Cut discards them, Bleed lets them spill out, Wrap brings them back on the opposite side, Clamp holds them at the edge, Reflect folds them back, Invert negates them.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "clone",
  },
  overtonesCount: {
    kind: "number",
    name: "Overtones Count",
    label: "Count",
    description: "How many overtones are stacked above each partial in the painted region.",
    default: 32,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    modulatable: false,
    effectType: "overtones",
  },
  overtonesScale: {
    kind: "number",
    name: "Vertical Scale",
    label: "Scale",
    description:
      "Multiplies the pitch spacing of the overtone series. 1x is the natural series; higher values spread it into inharmonic, bell-like timbres.",
    default: 1,
    min: -4,
    max: 4,
    step: 0.01,
    unit: MULTIPLIER_UNIT,
    marks: Array.from({ length: 9 }, (_, i) => i - 4).map((v) => ({ value: v, label: v.toString() + "x" })),
    includeInStep: true,
    modulatable: true,
    effectType: "overtones",
  },
  overtonesDecay: {
    kind: "number",
    name: "Decay",
    label: "Decay",
    description:
      "How quickly each successive overtone gets quieter. Low values leave a bright, buzzy stack; high values keep only the first few audible.",
    default: 0.0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "overtones",
  },
  overtonesShape: {
    kind: "options",
    name: "Overtones Shape",
    label: "Shape",
    description:
      "How overtone pitches are spaced. Logarithmic follows the natural harmonic series, Exponential spreads them wider, Octaves doubles each time, and Selected Scale snaps them to the scale set in the transport bar.",
    default: "logarithmic",
    options: Object.entries(shapes).map(([key, shape]) => ({ value: key, label: shape.label })),
    includeInStep: true,
    effectType: "overtones",
  },
  synthesizeBrushType: {
    kind: "options",
    name: "Synthesize Type",
    label: "Type",
    description:
      "What material fills the brushed area: Noise for unpitched texture, Sine for pure tones, Impulse for clicks and transients.",
    default: 0,
    options: SYNTHESIZE_TYPES,
    includeInStep: true,
    effectType: "synthesize",
  },
  evolveFlow: {
    kind: "number",
    name: "Flow",
    label: "Flow",
    description: "Advection strength - uses gradients to push pixels around. Negative reverses direction.",
    default: 20,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveSpread: {
    kind: "number",
    name: "Spread",
    label: "Spread",
    description: "Diffusion strength - positive spreads, negative sharpens.",
    default: 40,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveGrow: {
    kind: "number",
    name: "Grow",
    label: "Grow",
    description: "Reaction strength - positive grows, negative shrinks.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveSwirl: {
    kind: "number",
    name: "Swirl",
    label: "Swirl",
    description:
      "Bends the flow into a rotation instead of a straight push, curling the painted region into vortices. The sign sets the direction.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDriftX: {
    kind: "number",
    name: "Drift X",
    label: "Drift ↔",
    description:
      "A constant push along time on top of the gradient-driven flow, dragging the pattern forwards or backwards as it evolves.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDriftY: {
    kind: "number",
    name: "Drift Y",
    label: "Drift ↕",
    description:
      "A constant push along pitch on top of the gradient-driven flow, dragging the pattern up or down as it evolves.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDecay: {
    kind: "number",
    name: "Decay",
    label: "Decay",
    description:
      "How fast the simulation loses energy each iteration. Positive values fade the pattern out; negative values feed it so it grows.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveScaleX: {
    kind: "number",
    name: "Scale X",
    label: "Scale ↔",
    description:
      "How far along time each cell reads its neighbours. Larger values give coarser, slower-moving structures.",
    default: 50,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveScaleY: {
    kind: "number",
    name: "Scale Y",
    label: "Scale ↕",
    description:
      "How far along pitch each cell reads its neighbours. Larger values give coarser, slower-moving structures.",
    default: 50,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description:
      "What the simulation reads beyond the brush border. Cut treats the outside as empty, Bleed pulls in the surrounding audio, Wrap reads from the opposite edge, Clamp holds the edge value, Reflect mirrors it, Invert negates it.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "evolve",
  },
  binauralAzimuth: {
    kind: "number",
    name: "Azimuth",
    label: "Azimuth",
    description: "Horizontal angle of the sound source. 0° = front, 90° = right, -90° = left, 180° = behind.",
    default: 0,
    min: -180,
    max: 180,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  binauralDistance: {
    kind: "number",
    name: "Distance",
    label: "Distance",
    description: "Distance of the sound source. Affects amplitude and high-frequency absorption.",
    default: 1,
    min: 0.1,
    max: 10,
    step: 0.1,
    unit: "m",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  binauralStereoAngle: {
    kind: "number",
    name: "Stereo Angle",
    label: "Stereo",
    description:
      "Stereo spread angle. At 0°, source is mono and panned to azimuth. At 180°, L/R channels are offset ±90° from azimuth.",
    default: 180,
    min: 0,
    max: 180,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  // --- Transmute Parameters ---
  transmuteMode: {
    kind: "options",
    name: "Transmute Mode",
    label: "Mode",
    description:
      "Which raw magnitude/phase operation runs: Swap Mag/Phase, Complex Power, Phase Rotate, Phase Quantize, Stereo Cross, or Phase Gate.",
    default: 0,
    options: [
      { value: 0, label: "Swap Mag/Phase" },
      { value: 1, label: "Complex Power" },
      { value: 2, label: "Phase Rotate" },
      { value: 3, label: "Phase Quantize" },
      { value: 4, label: "Stereo Cross" },
      { value: 5, label: "Phase Gate" },
    ],
    includeInStep: true,
    effectType: "transmute",
  },
  transmuteAmount: {
    kind: "number",
    name: "Amount",
    label: "Amount",
    description:
      "Primary parameter. Swap: blend (0–1). Complex Power: exponent. Phase Rotate: rotations. Phase Quantize: step count (×8). Stereo Cross: mag blend (0–1). Phase Gate: oscillation count.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "transmute",
  },
  transmuteCurve: {
    kind: "number",
    name: "Curve",
    label: "Curve",
    description:
      "Secondary shaping. Phase Rotate: frequency power law exponent. Stereo Cross: phase blend (0–1). Phase Gate: gate sharpness.",
    default: 1.0,
    min: -4.0,
    max: 4.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "transmute",
  },

  // --- Waveshape Parameters ---
  waveshapeMode: {
    kind: "options",
    name: "Waveshape Mode",
    label: "Shape",
    description:
      "Nonlinear function applied to rectangular spectral components. Drive controls intensity for all modes.",
    default: 0,
    options: [
      { value: 0, label: "Soft Clip" },
      { value: 1, label: "Hard Clip" },
      { value: 2, label: "Rectify" },
      { value: 3, label: "Fold" },
      { value: 4, label: "Wrap" },
      { value: 5, label: "Sine" },
    ],
    includeInStep: true,
    effectType: "waveshape" as EffectType,
  },
  waveshapeDrive: {
    kind: "number",
    name: "Drive",
    label: "Drive",
    description:
      "Gain before shaping. For Fold/Wrap/Sine this controls how many times the signal cycles through the nonlinearity.",
    default: 1.0,
    min: 0.01,
    max: 16.0,
    step: 0.01,
    unit: MULTIPLIER_UNIT,
    includeInStep: true,
    modulatable: true,
    effectType: "waveshape" as EffectType,
  },
  waveshapeTilt: {
    kind: "number",
    name: "Tilt",
    label: "Tilt",
    description:
      "Skews the real/imaginary axis ratio before shaping. Biases the phase distribution — positive toward 0°/180°, negative toward ±90°.",
    default: 0.0,
    min: -1.0,
    max: 1.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "waveshape" as EffectType,
  },

  convolveIrFile: {
    kind: "file",
    name: "Convolve IR",
    label: "IR",
    description:
      "The impulse response convolved with the painted region. Any open file can act as an IR — load a reverb tail, a room recording, or any sound with a useful shape.",
    default: null,
    includeInStep: true,
    effectType: "convolve" as EffectType,
    pickMode: "modal",
  },
  convolveIrTimeOffset: {
    kind: "number",
    name: "IR Start",
    label: "Start",
    description: "Time position in the IR file where tap 0 starts (0-100%).",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrPitchShift: {
    kind: "number",
    name: "IR Pitch Shift",
    label: "Pitch Shift",
    description:
      "Transposes the impulse response before convolving. Shifting up shortens and brightens the tail; shifting down lengthens and darkens it.",
    default: 0,
    min: -24,
    max: 24,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrSize: {
    kind: "number",
    name: "IR Size",
    label: "Taps",
    description: "Number of IR frames (taps) to apply. More taps = longer, more expensive tail.",
    default: 64,
    min: 1,
    max: 512,
    step: 1,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveGainDb: {
    kind: "number",
    name: "Gain",
    label: "Gain",
    description:
      "Level of the convolved signal. Long or dense impulse responses build up energy fast, so trim this to keep the result in range.",
    default: 0,
    min: -36,
    max: 36,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrRate: {
    kind: "number",
    name: "IR Rate",
    label: "Rate",
    description:
      "Source read rate per IR tap. 1 = forward reverb at normal speed. -1 = reverse reverb. |rate|>1 stretches the tail in time, |rate|<1 compresses it.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveEdgeMode: {
    kind: "options",
    name: "Convolve Edge Mode",
    label: "Edge",
    description:
      "What happens to tail that runs past the brush border. Cut truncates it, Bleed lets it spill into the surrounding audio, Wrap folds it back to the start, Clamp holds the edge value, Reflect mirrors it, Invert negates it.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "convolve" as EffectType,
  },

  effects: {
    kind: "options",
    name: "Effects",
    label: "Effects",
    description:
      "The effect chain for this step. Effects run top to bottom, and the order changes the result — drag them to rearrange.",
    default: DEFAULT_EFFECTS,
    options: [],
    includeInStep: true,
  },

  // --- App/UI Parameters ---
  displayMinDb: {
    kind: "number",
    name: "Display Min dB",
    label: "Min dB",
    description:
      "Level drawn as black. Raise it to hide low-level noise, lower it to reveal quiet detail. Display only — it does not change the audio.",
    default: -70.0,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
  },
  displayMaxDb: {
    kind: "number",
    name: "Display Max dB",
    label: "Max dB",
    description: "Level drawn at full brightness. Display only — it does not change the audio.",
    default: 0.0,
    min: -120,
    max: 24,
    step: 1,
    unit: "dB",
  },
  magnitudeLimit: {
    kind: "number",
    name: "Magnitude Limit",
    label: "Mag. Limit",
    description:
      "Per-bin magnitude soft-clip. 0 disables it; output is kept safe by the audio limiter. Raise it only to bound runaway feedback effects.",
    default: 0.0,
    min: 0.0,
    max: 2.0,
    step: 0.01,
    unit: "x",
  },
  gridSizeBeats: {
    kind: "number",
    name: "Grid Size Beats",
    label: "Beats",
    description: "Spacing of the time grid, and the interval the brush snaps to when Snap is on.",
    default: 1,
    min: BEAT_VALUES[0].value,
    max: 32,
    step: 0.0001,
    marks: BEAT_VALUES,
    scale: "log",
  },
  snapTime: {
    kind: "boolean",
    name: "Snap Time",
    label: "Snap Time",
    description: "When enabled, the brush snaps to the horizontal (time) grid.",
    default: true,
  },
  limiterEnabled: {
    kind: "boolean",
    name: "Limiter",
    label: "Limiter",
    description:
      "Bake a true-peak limiter into the synthesized audio so it can't clip on playback or export. Bypass to hear or print the raw synthesis.",
    default: true,
  },
  gridSwing: {
    kind: "number",
    name: "Grid Swing",
    label: "Swing",
    description:
      "Swing amount for the time grid. 0% is straight; ~67% is triplet feel; 100% shifts odd-indexed grid lines by half a cell.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
  },
  accumulate: {
    kind: "boolean",
    name: "Accumulate",
    label: "Accumulate",
    description:
      "If enabled, painting over the same area adds to the existing effect. If disabled, logic prevents self-overlap within a stroke.",
    default: false,
    includeInStep: true,
  },
  gridSizeSemis: {
    kind: "number",
    name: "Grid Size Semis",
    label: "Semis",
    description:
      "The vertical grid size in semitones. Set to 'Scale' to use the selected scale instead of a fixed semitone interval.",
    default: 24,
    min: 0,
    max: 96,
    step: 1,
    marks: [{ value: 0, label: "Scale" }, ...PITCH_VALUES],
  },
  snapPitch: {
    kind: "boolean",
    name: "Snap Pitch",
    label: "Snap Pitch",
    description:
      "When enabled, the brush snaps to the vertical (pitch) grid, or to the scale when the pitch grid is set to 'Scale'.",
    default: true,
  },
  minFreq: {
    kind: "number",
    name: "Minimum Frequency",
    label: "Min. Freq.",
    description:
      "Lowest frequency the analysis covers. Raising it spends the same detail on a narrower range. Changing this re-analyzes the file.",
    default: 16.3516, // C0
    min: 10,
    max: 100,
    step: 0.01,
    unit: "Hz",
  },
  scaleTonic: {
    kind: "options",
    name: "Scale Tonic",
    label: "Tonic",
    description:
      "Root note of the scale used by pitch snapping, the Selected Scale overtone shape, and the Selected Scale modulator.",
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
  },
  scaleType: {
    kind: "options",
    name: "Scale Type",
    label: "Type",
    description: "Scale used by pitch snapping, the Selected Scale overtone shape, and the Selected Scale modulator.",
    default: "major",
    options: ScaleType.all().map(({ name }) => ({
      value: name,
      label: startCase(name),
    })),
  },
  bandsPerOctave: {
    kind: "options",
    name: "Resolution Mode",
    label: "Resolution",
    description:
      "Balance between time and frequency resolution. Time resolution gives sharper transients, frequency resolution gives more precise pitch detail.",
    default: 36,
    options: BANDS_PER_OCTAVE_VALUES,
  },
  linkLatencyMs: {
    kind: "number",
    name: "Link Latency",
    label: "Link Latency",
    description: "Latency compensation for Ableton Link sync. Positive values shift playback ahead.",
    default: 0,
    min: -500,
    max: 500,
    step: 1,
    unit: "ms",
  },
};

// --- Final Parameter Definitions Builder ---

const combinedDefs: Partial<Record<ParameterKey, ParameterDefInput>> = {
  ...baseParameterDefs,
  ...modulatorDefs,
  ...macroDefs,
};

const finalParameterDefs: Partial<Record<ParameterKey, ParameterDef>> = { ...combinedDefs };

for (const [key, def] of Object.entries(combinedDefs)) {
  if (def.kind === "number" && def.modulatable) {
    const modKeys: ParameterKey[] = [];
    const contextualOnly = def.modulationSourcesAllowed === "contextualOnly";

    // Generate pattern modulator amounts (Mod1, Mod2, Mod3)
    if (!contextualOnly) {
      for (let i = 0; i < NUM_MODULATORS; i++) {
        const modIndex = i + 1;
        const modAmountKey = `${key}Mod${modIndex}Amount` as ParameterKey;
        modKeys.push(modAmountKey);

        finalParameterDefs[modAmountKey] = {
          kind: "number",
          name: `${def.name} Mod ${modIndex} Amount`,
          label: `Mod ${modIndex}`,
          description: `Modulation amount from Modulator ${modIndex} for ${def.name}.`,
          default: 0,
          min: -100,
          max: 100,
          step: 0.1,
          unit: "%",

          includeInStep: true,
          effectType: def.effectType, // Inherit effectType from parent parameter
        };
      }
    }

    // Generate contextual modulation amounts (Iteration, Time, Pitch, Random, Step)
    for (const source of CONTEXTUAL_MOD_SOURCES) {
      const contextModKey = `${key}Mod${source.key}` as ParameterKey;

      finalParameterDefs[contextModKey] = {
        kind: "number",
        name: `${def.name} Mod ${source.key}`,
        label: source.label,
        description: `${source.description} modulation amount for ${def.name}.`,
        default: 0,
        min: -100,
        max: 100,
        step: 0.1,
        unit: "%",

        includeInStep: true,
        effectType: def.effectType, // Inherit effectType from parent parameter
      };
    }

    // Generate macro modulation amounts (Macro1..Macro4)
    if (!contextualOnly) {
      for (let i = 0; i < NUM_MACROS; i++) {
        const macroIndex = i + 1;
        const macroAmountKey = `${key}ModMacro${macroIndex}Amount` as ParameterKey;

        finalParameterDefs[macroAmountKey] = {
          kind: "number",
          name: `${def.name} Macro ${macroIndex} Amount`,
          label: `Macro ${macroIndex}`,
          description: `Modulation amount from Macro ${macroIndex} for ${def.name}.`,
          default: 0,
          min: -100,
          max: 100,
          step: 0.1,
          unit: "%",

          includeInStep: true,
          effectType: def.effectType,
        };
      }
    }
  }
}

export const parameterDefs = finalParameterDefs;

export const getParameterDef = (key: ParameterKey): ParameterDef => {
  const parameterDef = parameterDefs[key];

  if (!parameterDef) {
    throw new Error(`Parameter ${key} is not defined.`);
  }

  return parameterDef;
};

export const getNumberParameterDef = (key: ParameterKey): NumberParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "number") {
    throw new Error(`Parameter ${key} is not a number parameter.`);
  }
  return parameterDef as NumberParameter;
};

export const getBooleanParameterDef = (key: ParameterKey): BooleanParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "boolean") {
    throw new Error(`Parameter ${key} is not a boolean parameter.`);
  }
  return parameterDef as BooleanParameter;
};

export const getOptionsParameterDef = <T>(key: ParameterKey): OptionsParameter<T> => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "options") {
    throw new Error(`Parameter ${key} is not an options parameter.`);
  }
  return parameterDef as OptionsParameter<T>;
};

export const getStringParameterDef = (key: ParameterKey): StringParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "string") {
    throw new Error(`Parameter ${key} is not a string parameter.`);
  }
  return parameterDef as StringParameter;
};

export const getFileParameterDef = (key: ParameterKey): FileParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "file") {
    throw new Error(`Parameter ${key} is not a file parameter.`);
  }
  return parameterDef as FileParameter;
};

// --- Step Parameter Helpers ---

/** Returns all parameter keys where includeInStep is true */
export const getStepParameterKeys = (): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.includeInStep)
    .map(([key]) => key as ParameterKey);
};

/** Type for a brush step - contains only step-scoped parameters */
export type BrushStep = {
  id: string;
  name: string;
  color?: BrushColor;
  lockedOffset?: { beats: number; pitch: number } | null;
  sourceFile?: FileParameterValue;
} & {
  [K in Exclude<ParameterKey, "sourceFile">]?: (typeof parameterDefs)[K] extends { default: infer D } ? D : never;
};

/** Creates a default step with all step parameter defaults */
export const createDefaultStep = (name = "Step 1", color?: BrushColor): BrushStep => {
  const step: any = {
    id: crypto.randomUUID(),
    name,
  };
  if (color) step.color = color;
  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.includeInStep) {
      step[key as ParameterKey] = def.default;
    }
  }
  return step as BrushStep;
};

/** Check if a parameter key is a step parameter */
export const isStepParameter = (key: ParameterKey): boolean => {
  const def = parameterDefs[key];
  return def?.includeInStep === true;
};

// --- File Parameter Helpers ---

/** Returns all parameter keys with kind: "file". */
export const getFileParameterKeys = (): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.kind === "file")
    .map(([key]) => key as ParameterKey);
};

// --- Effect Parameter Helpers ---

/** Check if a parameter key belongs to an effect (has effectType set) */
export const isEffectParameter = (key: ParameterKey): boolean => {
  const def = parameterDefs[key];
  return def?.effectType !== undefined;
};

/** Get the effect type a parameter belongs to, or undefined if not an effect parameter */
export const getEffectType = (key: ParameterKey): EffectType | undefined => {
  const def = parameterDefs[key];
  return def?.effectType;
};

/** Get all parameter keys for a specific effect type */
export const getEffectParameterKeys = (effectType: EffectType): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.effectType === effectType)
    .map(([key]) => key as ParameterKey);
};

/** Get default parameter values for a specific effect type */
export const getEffectParameterDefaults = (effectType: EffectType): EffectParams => {
  const keys = getEffectParameterKeys(effectType);
  const defaults: EffectParams = {};
  for (const key of keys) {
    const def = parameterDefs[key];
    if (def) {
      defaults[key] = def.default;
    }
  }
  return defaults;
};
