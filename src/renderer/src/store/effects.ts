import { EffectType } from "../effects";
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
import type { EffectsState, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

// helpers to mirror constants into negative/zero/positive marks
const negBeatMarks = BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroBeatMark = { value: 0, label: "0" };
const posBeatMarks = BEAT_VALUES;

const negPitchMarks = PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroPitchMark = { value: 0, label: "0" };
const posPitchMarks = PITCH_VALUES;

const negMultMarks = MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const posMultMarks = MULTIPLIER_VALUES;

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
        min: -60,
        max: 0,
        step: 0.1,
        unit: "dB",
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
        min: -8.0,
        max: 8.0,
        step: 0.1,
        unit: "×",
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
        min: -8.0,
        max: 8.0,
        step: 0.1,
        unit: "×",
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
        min: 0.0,
        max: 48.0,
        step: 0.5,
        unit: "dB",
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
        min: -80,
        max: 24,
        step: 0.1,
        unit: "dB",
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
        min: -32,
        max: 32,
        step: 0.01,
        scale: "logBipolar",
        unit: BEAT_UNIT,
        marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
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
        min: -96,
        max: 96,
        step: 0.01,
        unit: SEMITONE_UNIT,
        marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
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
        min: -256,
        max: 256,
        step: 0.001,
        scale: "logBipolar",
        unit: MULTIPLIER_UNIT,
        marks: [...negMultMarks, ...posMultMarks],
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
        min: -256,
        max: 256,
        step: 0.001,
        scale: "logBipolar",
        unit: MULTIPLIER_UNIT,
        marks: [...negMultMarks, ...posMultMarks],
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
        min: -180,
        max: 180,
        step: 0.1,
        unit: "°",
      },
      { modulatable: true },
    ),

    ...param("transformEdgeMode", {
      kind: "options",
      name: "Edge Mode",
      label: "Edge",
      description: "How to handle edges when transforming.",
      value: 1,
      options: EDGE_MODE,
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      { modulatable: true },
    ),

    ...param("blurBleed", {
      kind: "boolean",
      name: "Blur Bleed",
      label: "Bleed",
      description: "Allows the blur to sample from outside the brush bounds making a more smoothing.",
      value: true,
    }),

    ...param("blurOrigin", {
      kind: "options",
      name: "Blur Origin",
      label: "Origin",
      description: "Controls where the convolution starts. Left is useful for reverbs to blur forward in time.",
      value: 0,
      options: [
        { value: 0, label: "Left" },
        { value: 1, label: "Middle" },
        { value: 2, label: "Right" },
      ],
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
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
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      { modulatable: true },
    ),

    // ---------------- Harmonics ----------------
    ...param(
      "harmonicsPower",
      {
        kind: "number",
        name: "Harmonic Power",
        label: "Power",
        description: "Controls the spacing of harmonics.",
        value: 1.0,
        min: 0.1,
        max: 4.0,
        step: 0.01,
      },
      { modulatable: true },
    ),

    ...param(
      "harmonicsFalloff",
      {
        kind: "number",
        name: "Harmonic Falloff",
        label: "Falloff",
        description: "Controls the amplitude falloff of harmonics.",
        value: 10.0,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      { modulatable: true },
    ),

    // ---------------- Synthesize ----------------
    ...param("synthesizeBrushType", {
      kind: "options",
      name: "Synthesize Type",
      label: "Type",
      description: "The type of synthesis to use.",
      value: 0,
      options: SYNTHESIZE_TYPES,
    }),

    // ---------------- Effect order & toggles ----------------
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
  };
};
