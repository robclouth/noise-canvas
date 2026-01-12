import { startCase } from "lodash-es";
import { ScaleType } from "tonal";
import { effects, EffectType } from "./effects";
import { shapes } from "./effects/overtones-shapes";
import {
  ALGORITHMS,
  BANDS_PER_OCTAVE_VALUES,
  BEAT_UNIT,
  BEAT_VALUES,
  BLEND_MODES,
  EDGE_MODE,
  MODULATOR_MODES,
  MULTIPLIER_UNIT,
  MULTIPLIER_VALUES,
  NUM_MODULATORS,
  PATTERN_SHAPES,
  PITCH_VALUES,
  SEMITONE_UNIT,
  SYNTHESIZE_TYPES,
  WRAP_MODES,
} from "./lib/constants";
import { ParameterKey } from "./store/types";

// --- Base Interfaces ---

export interface ParameterBase {
  kind: "number" | "boolean" | "options" | "string";
  name: string;
  label: string;
  description: string;
  includeInPresets?: boolean;
  includeInStep?: boolean;
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

export type ParameterDef = NumberParameter | BooleanParameter | OptionsParameter | StringParameter;

type ParameterDefInput = NumberParameter | BooleanParameter | OptionsParameter | StringParameter;

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
const DEFAULT_EFFECT_ORDER = Object.keys(effects)
  .filter((key) => key !== "passthrough")
  .map((k) => ({ effect: k as EffectType, enabled: false }));

// --- Modulator Definitions ---
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
    includeInPresets: true,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PatternShape`] = {
    kind: "options",
    name: `Modulator Pattern Shape ${idx}`,
    label: "Shape",
    description: "The shape of the modulator pattern.",
    default: 0,
    options: PATTERN_SHAPES,
    includeInPresets: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
  };
  modulatorDefs[`modulator${idx}PhaseMode`] = {
    kind: "options",
    name: `Modulator Phase Mode ${idx}`,
    label: "Phase",
    description: "Whether the phase is anchored to the canvas or the brush position.",
    default: 0,
    options: [
      { value: 0, label: "Canvas" },
      { value: 1, label: "Brush" },
    ],
    includeInPresets: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
  };
  modulatorDefs[`modulator${idx}TexturePath`] = {
    kind: "string",
    name: `Modulator Texture Path ${idx}`,
    label: "Texture",
    description: "The texture path for the modulator.",
    default: "",
    includeInPresets: true,
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
    includeInPresets: true,
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
    includeInPresets: true,
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
    includeInPresets: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
  },
  brushEnvelopeDelayTime: {
    kind: "number",
    name: "Envelope Delay Time",
    label: "Delay ↔",
    description: "Delay time before the attack phase begins (horizontal, in beats).",
    default: 0,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeAttackTime: {
    kind: "number",
    name: "Envelope Attack Time",
    label: "Attack ↔",
    description: "Attack time to reach full gain (horizontal, in beats).",
    default: 0,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeSustainTime: {
    kind: "number",
    name: "Envelope Sustain Time",
    label: "Sustain ↔",
    description: "Sustain time at full gain (horizontal, in beats).",
    default: 1,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeReleaseTime: {
    kind: "number",
    name: "Envelope Release Time",
    label: "Release ↔",
    description: "Release time to fade to zero (horizontal, in beats).",
    default: 0,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeDelayPitch: {
    kind: "number",
    name: "Envelope Delay Pitch",
    label: "Delay ↕",
    description: "Delay pitch before the attack phase begins (vertical, in semitones).",
    default: 0,
    min: 0,
    max: 96,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: semitoneMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeAttackPitch: {
    kind: "number",
    name: "Envelope Attack Pitch",
    label: "Attack ↕",
    description: "Attack pitch to reach full gain (vertical, in semitones).",
    default: 0,
    min: 0,
    max: 96,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: semitoneMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeSustainPitch: {
    kind: "number",
    name: "Envelope Sustain Pitch",
    label: "Sustain ↕",
    description: "Sustain pitch at full gain (vertical, in semitones).",
    default: 48,
    min: 0,
    max: 128,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: semitoneMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  brushEnvelopeReleasePitch: {
    kind: "number",
    name: "Envelope Release Pitch",
    label: "Release ↕",
    description: "Release pitch to fade to zero (vertical, in semitones).",
    default: 0,
    min: 0,
    max: 96,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: semitoneMarksWithZero,
    includeInPresets: true,
    includeInStep: true,
  },
  blendMode: {
    kind: "options",
    name: "Blend Mode",
    label: "Blend mode",
    description: "The blend mode to use when applying the brush.",
    default: 0,
    options: BLEND_MODES,
    includeInPresets: true,
    includeInStep: true,
  },
  algorithm: {
    kind: "options",
    name: "Warp Algorithm",
    label: "Warp algo",
    description: "The algorithm to use when warping the spectrogram.",
    default: 3,
    options: ALGORITHMS,
    includeInPresets: true,
    includeInStep: true,
  },
  sourcePositionMode: {
    kind: "options",
    name: "Source Position Mode",
    label: "Mode",
    description: "How the source position is used when painting.",
    default: "anchored" as const,
    options: [
      { value: "fixed", label: "Fixed" },
      { value: "anchored", label: "Anchored" },
      { value: "offset", label: "Offset" },
    ],
    includeInPresets: true,
  },
  sourceDataMode: {
    kind: "options",
    name: "Source Data Mode",
    label: "Source",
    description: "Whether to use the current (modified) or original (unmodified) data from the source file.",
    default: "current" as const,
    options: [
      { value: "current", label: "Current" },
      { value: "original", label: "Original" },
    ],
    includeInPresets: true,
    includeInStep: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
  },
  transformEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description: "How to handle edges when transforming.",
    default: 1,
    options: EDGE_MODE,
    includeInPresets: true,
    includeInStep: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
  },
  blurBleed: {
    kind: "boolean",
    name: "Blur Bleed",
    label: "Bleed",
    description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
    default: true,
    includeInPresets: true,
    includeInStep: true,
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
    includeInPresets: true,
    includeInStep: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: false,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
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
    includeInPresets: true,
    includeInStep: true,
    modulatable: true,
  },
  overtonesShape: {
    kind: "options",
    name: "Overtones Shape",
    label: "Shape",
    description: "Controls the shape of the overtones.",
    default: "logarithmic",
    options: Object.entries(shapes).map(([key, shape]) => ({ value: key, label: shape.label })),
    includeInPresets: true,
    includeInStep: true,
  },
  synthesizeBrushType: {
    kind: "options",
    name: "Synthesize Type",
    label: "Type",
    description: "The type of synthesis to use.",
    default: 0,
    options: SYNTHESIZE_TYPES,
    includeInPresets: true,
    includeInStep: true,
  },
  effectOrder: {
    kind: "options",
    name: "Effect Order",
    label: "Order",
    description: "The order in which effects are applied.",
    default: DEFAULT_EFFECT_ORDER,
    options: [],
    includeInPresets: true,
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
    includeInPresets: false,
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
    includeInPresets: false,
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
    includeInPresets: false,
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
    includeInPresets: false,
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
    includeInPresets: false,
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
    includeInPresets: false,
  },
  normalize: {
    kind: "boolean",
    name: "Normalize",
    label: "Normalize",
    description: "Normalizes the audio output.",
    default: true,
    includeInPresets: false,
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
    includeInPresets: false,
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
    includeInPresets: false,
  },
  bandsPerOctave: {
    kind: "options",
    name: "Resolution Mode",
    label: "Resolution",
    description:
      "Balance between time and frequency resolution. Time resolution gives sharper transients, frequency resolution gives more precise pitch detail.",
    default: 36,
    options: BANDS_PER_OCTAVE_VALUES,
    includeInPresets: false,
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
        includeInPresets: true,
        includeInStep: true,
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

// --- Step Parameter Helpers ---

/** Returns all parameter keys where includeInStep is true */
export const getStepParameterKeys = (): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.includeInStep)
    .map(([key]) => key as ParameterKey);
};

/** Type for a brush step - contains only step-scoped parameters */
export type BrushStep = {
  [K in ParameterKey]?: (typeof parameterDefs)[K] extends { default: infer D } ? D : never;
};

/** Creates a default step with all step parameter defaults */
export const createDefaultStep = (): BrushStep => {
  const step: BrushStep = {};
  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.includeInStep) {
      step[key as ParameterKey] = def.default;
    }
  }
  return step;
};

/** Check if a parameter key is a step parameter */
export const isStepParameter = (key: ParameterKey): boolean => {
  const def = parameterDefs[key];
  return def?.includeInStep === true;
};
