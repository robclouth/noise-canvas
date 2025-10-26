import { effects, EffectType } from "../effects";
import { shapes } from "../effects/overtones-shapes";
import {
  BEAT_UNIT,
  BEAT_VALUES,
  EDGE_MODE,
  MULTIPLIER_UNIT,
  MULTIPLIER_VALUES,
  PITCH_VALUES,
  SEMITONE_UNIT,
  SYNTHESIZE_TYPES,
} from "../lib/constants";
import type { BooleanParameter, NumberParameter, OptionsParameter, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

export interface EffectsState {
  dynamicsThresholdDb: NumberParameter;
  dynamicsUpperRatio: NumberParameter;
  dynamicsLowerRatio: NumberParameter;
  dynamicsKnee: NumberParameter;
  dynamicsGainDb: NumberParameter;
  transformShiftBeats: NumberParameter;
  transformShiftSemis: NumberParameter;
  transformScaleTime: NumberParameter;
  transformScalePitch: NumberParameter;
  transformRotation: NumberParameter;
  transformEdgeMode: OptionsParameter<number>;
  synthesizeBrushType: OptionsParameter<number>;
  blurAmountTime: NumberParameter;
  blurAmountPitch: NumberParameter;
  blurNoiseTime: NumberParameter;
  blurNoisePitch: NumberParameter;
  blurBleed: BooleanParameter;
  blurOrigin: OptionsParameter<number>;
  sharpenAmountTime: NumberParameter;
  sharpenAmountPitch: NumberParameter;
  overtonesCount: NumberParameter;
  overtonesScale: NumberParameter;
  overtonesDecay: NumberParameter;
  overtonesShape: OptionsParameter<keyof typeof shapes>;
  effectOrder: OptionsParameter<{ effect: EffectType; enabled: boolean }[]>;
}

// helpers to mirror constants into negative/zero/positive marks
const negBeatMarks = BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroBeatMark = { value: 0, label: "0" };
const posBeatMarks = BEAT_VALUES;

const negPitchMarks = PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroPitchMark = { value: 0, label: "0" };
const posPitchMarks = PITCH_VALUES;

const negMultMarks = MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const posMultMarks = MULTIPLIER_VALUES;

const DEFAULT_EFFECT_ORDER = Object.keys(effects)
  .filter((key) => key !== "passthrough")
  .map((k) => ({ effect: k as EffectType, enabled: false }));

export const createEffectsSlice = (set: ZustandSet, get: ZustandGet): EffectsState => {
  const param = makeCreateParameter<EffectsState>(set, get);

  return {
    // ---------------- Dynamics ----------------
    ...param(
      "dynamicsThresholdDb",
      {
        kind: "number",
        name: "Threshold",
        label: "Threshold",
        description: "The threshold level for dynamics processing in decibels.",
        value: -20.0,
        default: -20.0,
        min: -60,
        max: 0,
        step: 0.1,
        unit: "dB",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "dynamicsUpperRatio",
      {
        kind: "number",
        name: "Upper Ratio",
        label: "Upper",
        description: "Gain multiplier for signals above threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
        value: 1.0,
        default: 1.0,
        min: -8.0,
        max: 8.0,
        step: 0.1,
        unit: "×",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "dynamicsLowerRatio",
      {
        kind: "number",
        name: "Lower Ratio",
        label: "Lower",
        description: "Gain multiplier for signals below threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
        value: 1.0,
        default: 1.0,
        min: -8.0,
        max: 8.0,
        step: 0.1,
        unit: "×",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "dynamicsKnee",
      {
        kind: "number",
        name: "Knee",
        label: "Knee",
        description: "Width of the transition zone around the threshold. 0 = hard/sharp, higher = softer/smoother.",
        value: 6.0,
        default: 6.0,
        min: 0.0,
        max: 48.0,
        step: 0.5,
        unit: "dB",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "dynamicsGainDb",
      {
        kind: "number",
        name: "Gain",
        label: "Gain",
        description: "The amount of gain to apply in decibels.",
        value: 0.0,
        default: 0.0,
        min: -80,
        max: 24,
        step: 0.1,
        unit: "dB",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    // ---------------- Transform ----------------
    ...param(
      "transformShiftBeats",
      {
        kind: "number",
        name: "Shift Beats",
        label: "Shift H",
        description: "Shifts the content horizontally by a number of beats.",
        value: 0,
        default: 0,
        min: -32,
        max: 32,
        step: 0.01,
        scale: "logBipolar",
        unit: BEAT_UNIT,
        marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "transformShiftSemis",
      {
        kind: "number",
        name: "Shift Semis",
        label: "Shift V",
        description: "Shifts the content vertically by a number of semitones.",
        value: 0.0,
        default: 0.0,
        min: -96,
        max: 96,
        step: 0.01,
        unit: SEMITONE_UNIT,
        marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "transformScaleTime",
      {
        kind: "number",
        name: "Scale Time",
        label: "Scale H",
        description: "Scales the content horizontally.",
        value: 1.0,
        default: 1.0,
        min: -256,
        max: 256,
        step: 0.001,
        scale: "logBipolar",
        unit: MULTIPLIER_UNIT,
        marks: [...negMultMarks, ...posMultMarks],
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "transformScalePitch",
      {
        kind: "number",
        name: "Scale Pitch",
        label: "Scale V",
        description: "Scales the content vertically.",
        value: 1.0,
        default: 1.0,
        min: -256,
        max: 256,
        step: 0.001,
        scale: "logBipolar",
        unit: MULTIPLIER_UNIT,
        marks: [...negMultMarks, ...posMultMarks],
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "transformRotation",
      {
        kind: "number",
        name: "Rotation",
        label: "Rotation",
        description: "Rotates the content.",
        value: 0.0,
        default: 0.0,
        min: -180,
        max: 180,
        step: 0.1,
        unit: "°",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param("transformEdgeMode", {
      kind: "options",
      name: "Edge Mode",
      label: "Edge",
      description: "How to handle edges when transforming.",
      value: 1,
      default: 1,
      options: EDGE_MODE,
      includeInPresets: true,
    }),

    // ---------------- Blur ----------------
    ...param(
      "blurAmountTime",
      {
        kind: "number",
        name: "Blur Amount Time",
        label: "Blur H",
        description: "The amount of blur to apply over time.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "blurAmountPitch",
      {
        kind: "number",
        name: "Blur Amount Pitch",
        label: "Blur V",
        description: "The amount of blur to apply over pitch.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "blurNoiseTime",
      {
        kind: "number",
        name: "Blur Noise Time",
        label: "Noise H",
        description: "The amount of noise to apply over time.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "blurNoisePitch",
      {
        kind: "number",
        name: "Blur Noise Pitch",
        label: "Noise V",
        description: "The amount of noise to apply over pitch.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param("blurBleed", {
      kind: "boolean",
      name: "Blur Bleed",
      label: "Bleed",
      description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
      value: true,
      default: true,
      includeInPresets: true,
    }),

    ...param("blurOrigin", {
      kind: "options",
      name: "Blur Origin",
      label: "Origin",
      description: "Controls where the convolution starts. Left is useful for reverbs to blur forward in time.",
      value: 0,
      default: 0,
      options: [
        { value: 0, label: "Left" },
        { value: 1, label: "Middle" },
        { value: 2, label: "Right" },
      ],
      includeInPresets: true,
    }),

    // ---------------- Sharpen ----------------
    ...param(
      "sharpenAmountTime",
      {
        kind: "number",
        name: "Sharpen Time",
        label: "Sharpen H",
        description: "The amount of sharpening to apply over time.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "sharpenAmountPitch",
      {
        kind: "number",
        name: "Sharpen Pitch",
        label: "Sharpen V",
        description: "The amount of sharpening to apply over pitch.",
        value: 0,
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    // ---------------- Overtones ----------------
    ...param(
      "overtonesCount",
      {
        kind: "number",
        name: "Overtones Count",
        label: "Count",
        description: "Controls the number of overtones.",
        value: 32,
        default: 32,
        min: 1,
        max: 64,
        step: 1,
        includeInPresets: true,
      },
      { modulatable: false },
    ),

    ...param(
      "overtonesScale",
      {
        kind: "number",
        name: "Vertical Scale",
        label: "Scale",
        description: "Scalees the overtones vertically.",
        value: 1,
        default: 1,
        min: -4,
        max: 4,
        step: 0.01,
        unit: MULTIPLIER_UNIT,
        marks: Array.from({ length: 9 }, (_, i) => i - 4).map((v) => ({ value: v, label: v.toString() + "x" })),
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param(
      "overtonesDecay",
      {
        kind: "number",
        name: "Decay",
        label: "Decay",
        description: "Controls the amplitude decay of overtones.",
        value: 0.0,
        default: 0.0,
        min: 0,
        max: 100,
        step: 0.1,
        unit: "%",
        includeInPresets: true,
      },
      { modulatable: true },
    ),

    ...param("overtonesShape", {
      kind: "options",
      name: "Overtones Shape",
      label: "Shape",
      description: "Controls the shape of the overtones.",
      value: "logarithmic",
      default: "logarithmic",
      options: Object.entries(shapes).map(([key, shape]) => ({ value: key, label: shape.label })),
      includeInPresets: true,
    }),

    // ---------------- Synthesize ----------------
    ...param("synthesizeBrushType", {
      kind: "options",
      name: "Synthesize Type",
      label: "Type",
      description: "The type of synthesis to use.",
      value: 0,
      default: 0,
      options: SYNTHESIZE_TYPES,
      includeInPresets: true,
    }),

    // ---------------- Effect order ----------------
    ...param("effectOrder", {
      kind: "options",
      name: "Effect Order",
      label: "Order",
      description: "The order in which effects are applied.",
      value: DEFAULT_EFFECT_ORDER,
      default: DEFAULT_EFFECT_ORDER,
      options: [],
      includeInPresets: true,
    }),
  };
};
