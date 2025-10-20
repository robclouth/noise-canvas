import { EffectType } from "../effects";
import { BEAT_VALUES, EDGE_MODE, MULTIPLIER_VALUES, PITCH_VALUES, SYNTHESIZE_TYPES } from "../lib/constants";
import type { EffectsState, ZustandSet } from "./types";
import { createParameter } from "./utils";

export const createEffectsSlice = (set: ZustandSet): EffectsState => ({
  // Dynamics
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
      description: "Gain multiplier for signals above threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
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
      description: "Gain multiplier for signals below threshold. 1=unity, 0.5=compress, 2=expand, 0=gate, -1=invert.",
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
      description: "Width of the transition zone around the threshold. 0 = hard/sharp, higher = softer/smoother.",
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

  // Transform
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

  // Blur
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

  // Sharpen
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

  // Harmonics
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

  // Synthesize
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

  // Effect order and enabled states
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
});
