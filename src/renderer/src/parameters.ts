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
  CONTEXTUAL_MOD_SOURCES,
  EDGE_MODE,
  MODULATOR_MODES,
  MULTIPLIER_UNIT,
  MULTIPLIER_VALUES,
  NUM_MODULATORS,
  PATTERN_SHAPES,
  PITCH_VALUES,
  PITCH_VALUES_NO_FRACTIONS,
  SEMITONE_UNIT,
  SYNTHESIZE_TYPES,
  WRAP_MODES,
} from "./lib/constants";
import { ParameterKey } from "./store/types";

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
const semitoneMarksWithZero = [{ value: 0, label: "0" }, ...PITCH_VALUES];

// --- Modulator Definitions ---
// Nested modulation (modulating modulator parameters) is disabled on Windows
// due to shader compilation performance issues with unrolled loops
const isWindows = typeof window !== "undefined" && window.platform === "win32";
const modulatorDefs: Record<string, ParameterDefInput> = {};
for (let i = 0; i < NUM_MODULATORS; i++) {
  const idx = i + 1;
  modulatorDefs[`modulator${idx}Mode`] = {
    kind: "options",
    name: `Modulator Mode ${idx}`,
    label: "Mode",
    description: "The mode of the modulator.",
    default: 0,
    options: MODULATOR_MODES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PatternShape`] = {
    kind: "options",
    name: `Modulator Pattern Shape ${idx}`,
    label: "Shape",
    description: "The shape of the modulator pattern.",
    default: 0,
    options: PATTERN_SHAPES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}Strength`] = {
    kind: "number",
    name: `Modulator Depth ${idx}`,
    label: "Depth",
    description: "The depth of the modulator.",
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
    description: "The rate of the modulator pattern (horizontal).",
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
    description: "The rate of the modulator pattern (vertical).",
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
    description: "The rotation of the modulator pattern.",
    default: 0,
    min: 0,
    max: 360,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PhaseMode`] = {
    kind: "options",
    name: `Modulator Phase Mode ${idx}`,
    label: "Phase Mode",
    description: "Whether the phase is anchored to the canvas or the brush position.",
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
    description: "The horizontal phase offset of the modulator pattern.",
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
    description: "The vertical phase offset of the modulator pattern.",
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
    description: "The signal property the envelope follower tracks.",
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
    description: "The minimum gain in dB for the envelope follower.",
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
    description: "The maximum gain in dB for the envelope follower.",
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
    description: "The texture path for the modulator.",
    default: "",
    includeInStep: true,
  };
  // Sequencer mode parameters
  modulatorDefs[`modulator${idx}SeqStepsX`] = {
    kind: "number",
    name: `Sequencer Steps X ${idx}`,
    label: "Steps ↔",
    description: "Number of horizontal steps per row.",
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
    description: "Number of vertical rows (pitch bands).",
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
    description: "Loop length in beats for horizontal wrapping.",
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
    description: "Pitch range in semitones for vertical wrapping.",
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
    description: "Swing amount for odd steps (time axis).",
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
    description: "Serialized sequencer grid data (values 0 or 1).",
    default: JSON.stringify({
      values: Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => 1)),
    }),
    includeInStep: true,
  };
}

// --- Base Definitions (Brush, Effects, App) ---
const baseParameterDefs: Partial<Record<ParameterKey, ParameterDefInput>> = {
  // --- Brush Parameters ---
  brushWrapMode: {
    kind: "options",
    name: "Wrap Mode",
    label: "Wrap",
    description: "Controls whether the brush wraps around the edges of the canvas.",
    default: 0,
    options: WRAP_MODES,
    includeInStep: true,
  },
  brushIntensity: {
    kind: "number",
    name: "Brush Strength",
    label: "Strength",
    description: "Controls the strength of the brush.",
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
    description: "How many times to apply the brush effect.",
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
    description: "Pans the brush effect left or right.",
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
    description: "Horizontal brush size (in beats).",
    default: 1,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
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
    description: "Vertical brush size (in semitones).",
    default: 48,
    min: 0,
    max: 128,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: semitoneMarksWithZero,
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
  blendMode: {
    kind: "options",
    name: "Blend Mode",
    label: "Blend mode",
    description: "The blend mode to use when applying the brush.",
    default: 0,
    options: BLEND_MODES,
    includeInStep: true,
  },
  algorithm: {
    kind: "options",
    name: "Warp Algorithm",
    label: "Warp algo",
    description: "The algorithm to use when warping the spectrogram.",
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
  },
  sourcePositionMode: {
    kind: "options",
    name: "Source Position Mode",
    label: "Tracking",
    description: "How the source position is used when painting.",
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
    description: "Time position in the source file (0-100%).",
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
    description: "Pitch position in the source file (0-100%).",
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
    description: "The threshold level for dynamics processing in decibels.",
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
    description: "The amount of gain to apply in decibels.",
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
    description: "Shifts the content horizontally by a number of beats.",
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
    description: "Shifts the content vertically by a number of semitones.",
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
    description: "Scales the content horizontally.",
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
    description: "Scales the content vertically.",
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
    description: "Rotates the content.",
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
    description: "How to handle edges when transforming.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "transform",
  },
  sortDirection: {
    kind: "options",
    name: "Sort Direction",
    label: "Direction",
    description: "The direction to sort the pixels.",
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
    description: "The order to sort the pixels.",
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
    description: "What to sort the pixels by.",
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
    description: "How to handle stereo channels when sorting.",
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
    description: "The amount of blur to apply over time.",
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
    description: "The amount of blur to apply over pitch.",
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
    description: "The amount of noise to apply over time.",
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
    description: "The amount of noise to apply over pitch.",
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
    description: "Number of samples for the horizontal blur pass.",
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
    description: "Number of samples for the vertical blur pass.",
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
    description: "How to handle edges when blurring (at brush boundary).",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "blur",
  },
  blurOrigin: {
    kind: "options",
    name: "Blur Origin",
    label: "Origin",
    description: "Controls where the convolution starts. Left is useful for reverbs to blur forward in time.",
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
    description: "Spacing between copies in beats. Modulate by Iteration for self-similar fractal subdivisions.",
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
    description: "Spacing between copies in semitones.",
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
    description: "Number of copies along the time axis.",
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
    description: "Number of copies along the pitch axis.",
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
    description: "Direction copies extend along time.",
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
    description: "Direction copies extend along pitch.",
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
    description: "How copies that extend past the brush boundary are handled.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "clone",
  },
  overtonesCount: {
    kind: "number",
    name: "Overtones Count",
    label: "Count",
    description: "Controls the number of overtones.",
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
    description: "Scalees the overtones vertically.",
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
    description: "Controls the amplitude decay of overtones.",
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
    description: "Controls the shape of the overtones.",
    default: "logarithmic",
    options: Object.entries(shapes).map(([key, shape]) => ({ value: key, label: shape.label })),
    includeInStep: true,
    effectType: "overtones",
  },
  synthesizeBrushType: {
    kind: "options",
    name: "Synthesize Type",
    label: "Type",
    description: "The type of synthesis to use.",
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
    default: 0,
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
    default: 0,
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
    description: "Adds rotational component to flow (CW/CCW).",
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
    description: "Horizontal drift bias (time direction).",
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
    description: "Vertical drift bias (pitch direction).",
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
    description: "Entropy/death rate - negative boosts instead.",
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
    description: "Horizontal kernel size (time).",
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
    description: "Vertical kernel size (pitch).",
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
    description: "How to handle edges when evolving (at brush boundary).",
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
    description: "The spectral transformation algorithm.",
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

  effects: {
    kind: "options",
    name: "Effects",
    label: "Effects",
    description: "The effects to apply and their order.",
    default: DEFAULT_EFFECTS,
    options: [],
    includeInStep: true,
  },

  // --- App/UI Parameters ---
  displayMinDb: {
    kind: "number",
    name: "Display Min dB",
    label: "Min dB",
    description: "The minimum decibel level displayed in the spectrogram.",
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
    description: "The maximum decibel level displayed in the spectrogram.",
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
    description: "The maximum magnitude limit for the spectrogram.",
    default: 1.0,
    min: 0.0,
    max: 2.0,
    step: 0.01,
    unit: "x",
  },
  gridSizeBeats: {
    kind: "number",
    name: "Grid Size Beats",
    label: "Beats",
    description: "The horizontal grid size in beats.",
    default: 1,
    min: 0,
    max: 32,
    step: 0.0001,
    marks: [{ value: 0, label: "Off" }, ...BEAT_VALUES],
    scale: "log",
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
    description: "The vertical grid size in semitones.",
    default: 24,
    min: 0,
    max: 96,
    step: 1,
    marks: [{ value: 0, label: "Off" }, ...PITCH_VALUES],
  },
  minFreq: {
    kind: "number",
    name: "Minimum Frequency",
    label: "Min. Freq.",
    description: "The minimum frequency of the spectrogram.",
    default: 16.3516, // C0
    min: 10,
    max: 100,
    step: 0.01,
    unit: "Hz",
  },
  normalize: {
    kind: "boolean",
    name: "Normalize",
    label: "Normalize",
    description: "Normalizes the audio output.",
    default: true,
  },
  scaleTonic: {
    kind: "options",
    name: "Scale Tonic",
    label: "Tonic",
    description: "The root note of the scale.",
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
    description: "The type of scale to use.",
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
};

const finalParameterDefs: Partial<Record<ParameterKey, ParameterDef>> = { ...combinedDefs };

for (const [key, def] of Object.entries(combinedDefs)) {
  if (def.kind === "number" && def.modulatable) {
    const modKeys: ParameterKey[] = [];

    // Generate pattern modulator amounts (Mod1, Mod2, Mod3)
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
  lockedOffset?: { beats: number; pitch: number } | null;
  sourceFile?: FileParameterValue;
} & {
  [K in Exclude<ParameterKey, "sourceFile">]?: (typeof parameterDefs)[K] extends { default: infer D } ? D : never;
};

/** Creates a default step with all step parameter defaults */
export const createDefaultStep = (name = "Step 1"): BrushStep => {
  const step: any = {
    id: crypto.randomUUID(),
    name,
  };
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
