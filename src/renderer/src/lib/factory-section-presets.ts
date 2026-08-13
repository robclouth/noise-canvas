import { pickSectionPresetColor, type SectionPreset } from "./section-presets";

/**
 * Starting points shipped with the app, one list per section. Each preset names
 * only the parameters it cares about; applying one returns every other
 * parameter in that section to its default.
 */
const presets: Omit<SectionPreset, "isFactory" | "color">[] = [
  {
    id: "effect-blur-tail",
    scope: "effect:blur",
    name: "Tail",
    description: "Trails the sound forwards into a reverb tail.",
    values: { blurAmountTime: 100, blurAmountPitch: 0, blurOrigin: 0, blurSamplesX: 32, blurSamplesY: 1 },
  },
  {
    id: "effect-blur-pre-echo",
    scope: "effect:blur",
    name: "Pre-echo",
    description: "Runs the smear backwards, so the sound arrives before it starts.",
    values: { blurAmountTime: 100, blurAmountPitch: 0, blurOrigin: 2, blurSamplesX: 32, blurSamplesY: 1 },
  },
  {
    id: "effect-blur-wash",
    scope: "effect:blur",
    name: "Wash",
    description: "Spreads both ways at once and blends the harmonics into a pad.",
    values: { blurAmountTime: 70, blurAmountPitch: 40, blurOrigin: 1, blurSamplesX: 32, blurSamplesY: 32 },
  },
  {
    id: "effect-blur-grain",
    scope: "effect:blur",
    name: "Grain",
    description: "A rough smear, with every tap scattered.",
    values: {
      blurAmountTime: 60,
      blurAmountPitch: 20,
      blurNoiseTime: 80,
      blurNoisePitch: 60,
      blurOrigin: 1,
      blurSamplesX: 24,
      blurSamplesY: 16,
    },
  },

  {
    id: "effect-dynamics-gate",
    scope: "effect:dynamics",
    name: "Gate",
    description: "Drops everything under the threshold and leaves the peaks standing.",
    values: { dynamicsThresholdDb: -30, dynamicsUpperRatio: 1, dynamicsLowerRatio: 0, dynamicsKnee: 3 },
  },
  {
    id: "effect-dynamics-squash",
    scope: "effect:dynamics",
    name: "Squash",
    description: "Flattens the loud parts towards the quiet ones.",
    values: { dynamicsThresholdDb: -30, dynamicsUpperRatio: 0.3, dynamicsLowerRatio: 1, dynamicsKnee: 12 },
  },
  {
    id: "effect-dynamics-lift-the-tails",
    scope: "effect:dynamics",
    name: "Lift Tails",
    description: "Raises the quiet detail without touching the hits.",
    values: { dynamicsThresholdDb: -40, dynamicsUpperRatio: 1, dynamicsLowerRatio: 2, dynamicsKnee: 18 },
  },
  {
    id: "effect-dynamics-invert",
    scope: "effect:dynamics",
    name: "Invert",
    description: "Turns the quiet parts loud and the loud parts quiet.",
    values: { dynamicsThresholdDb: -30, dynamicsUpperRatio: -1, dynamicsLowerRatio: -1, dynamicsKnee: 12 },
  },
  {
    id: "effect-dynamics-erase",
    scope: "effect:dynamics",
    name: "Erase",
    description: "Takes the level all the way down.",
    values: { dynamicsGainDb: -80 },
  },

  {
    id: "effect-transform-octave-up",
    scope: "effect:transform",
    name: "Octave Up",
    description: "Lifts the sound twelve semitones.",
    values: { transformShiftSemis: 12 },
  },
  {
    id: "effect-transform-octave-down",
    scope: "effect:transform",
    name: "Octave Down",
    description: "Drops the sound twelve semitones.",
    values: { transformShiftSemis: -12 },
  },
  {
    id: "effect-transform-reverse",
    scope: "effect:transform",
    name: "Reverse",
    description: "Plays the sound backwards in place.",
    values: { transformScaleTime: -1 },
  },
  {
    id: "effect-transform-half-speed",
    scope: "effect:transform",
    name: "Half Speed",
    description: "Stretches the sound to twice its length, holding its pitch.",
    values: { transformScaleTime: 2 },
  },
  {
    id: "effect-transform-harmonic-spread",
    scope: "effect:transform",
    name: "Spread",
    description: "Pushes the harmonics apart, thinning a tone into a bell.",
    values: { transformScalePitch: 1.5 },
  },
  {
    id: "effect-transform-tilt",
    scope: "effect:transform",
    name: "Tilt",
    description: "Turns the sound on the canvas, so a sweep leans towards a chord.",
    values: { transformRotation: 30, transformEdgeMode: 1 },
  },
];

/**
 * Colours are assigned by the same rule a saved preset gets one, so a section's
 * list stays spread across the palette however many are added to it.
 */
export const factorySectionPresets: SectionPreset[] = presets.reduce<SectionPreset[]>((assigned, preset) => {
  assigned.push({ ...preset, isFactory: true, color: pickSectionPresetColor(assigned, preset.scope) });
  return assigned;
}, []);
