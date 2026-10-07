import type { EffectType } from "../effects";

/** A sine pattern on modulator 1 driving `keys` at full amount. */
const sweeping = (...keys: string[]): Record<string, unknown> => ({
  modulator1Mode: 0,
  modulator1PatternShape: 0,
  ...Object.fromEntries(keys.map((key) => [`${key}Mod1Amount`, 100])),
});

export type ReachCase = { name: string; step: Record<string, unknown>; bpm?: number; y?: number };

/** At least one brush for every effect, each set to read as far as it can. */
export const REACH_CASES: Record<EffectType, ReachCase[]> = {
  blur: [
    {
      name: "Blur at its widest",
      step: { blurAmountTime: 100, blurNoiseTime: 100, blurAmountPitch: 100, blurNoisePitch: 100, blurEdgeMode: 1 },
      bpm: 60,
    },
  ],
  clone: [
    {
      name: "Repeat forward, accelerating, both axes",
      step: {
        cloneCountX: 5,
        cloneSpaceBeats: 1,
        cloneShapeX: "geometric",
        cloneCountY: 4,
        cloneSpaceSemis: 2,
        cloneShapeY: "geometric",
        cloneEdgeMode: 1,
      },
    },
    {
      name: "Repeat up in pitch, accelerating",
      step: {
        brushSizePitch: 6,
        cloneCountY: 3,
        cloneSpaceSemis: 3,
        cloneShapeY: "geometric",
        cloneDirectionY: 2,
        cloneDecay: 0,
        cloneEdgeMode: 1,
      },
      y: 0.2,
    },
    {
      name: "Repeat backward with a negative gap",
      step: { cloneCountX: 6, cloneSpaceBeats: -2, cloneDirectionX: 2, cloneEdgeMode: 1 },
    },
    {
      name: "Repeat from the middle, harmonic in pitch",
      step: {
        cloneCountX: 7,
        cloneSpaceBeats: 1.5,
        cloneDirectionX: 1,
        cloneCountY: 6,
        cloneSpaceSemis: 5,
        cloneShapeY: "harmonic",
        cloneDirectionY: 1,
        cloneEdgeMode: 1,
      },
    },
    {
      name: "Repeat with a modulated gap",
      step: { cloneCountX: 4, cloneSpaceBeats: 1, cloneEdgeMode: 1, ...sweeping("cloneSpaceBeats") },
    },
  ],
  evolve: [
    { name: "Evolve at its defaults", step: {} },
    { name: "Evolve at its widest", step: { evolveScaleX: 100, evolveScaleY: 100, evolveFlow: 100 } },
    { name: "Evolve without flow", step: { evolveFlow: 0, evolveScaleX: 100, evolveScaleY: 100 } },
  ],
  transform: [
    {
      name: "Transform scale swept by a pattern",
      step: { transformScaleTime: 0.5, transformEdgeMode: 1, ...sweeping("transformScaleTime") },
    },
    {
      name: "Transform speed swept by a pattern",
      step: { transformSpeed: 1.5, transformEdgeMode: 1, ...sweeping("transformSpeed") },
    },
    {
      name: "Transform rotation swept by a pattern",
      step: { transformRotation: 20, transformEdgeMode: 1, ...sweeping("transformRotation") },
    },
    {
      name: "Transform shifted far",
      step: { transformShiftBeats: -6, transformShiftSemis: 30, transformEdgeMode: 1 },
    },
  ],
  convolve: [
    { name: "Convolve, long and backward", step: { convolveIrSize: 256, convolveIrRate: -2 } },
    {
      name: "Convolve with IR Start swept",
      step: { convolveIrSize: 128, convolveIrTimeOffset: 40, ...sweeping("convolveIrTimeOffset") },
    },
  ],
  attract: [
    { name: "Attract", step: { attractMap: 0, attractAmountX: 100, attractAmountY: 100 } },
    {
      name: "Attract smoothed widely across pitch",
      step: { attractMap: 0, attractAmountX: 100, attractAmountY: 100, attractSmoothY: 24 },
    },
    {
      name: "Attract toward the grid, smoothed across pitch",
      step: { attractMap: 2, attractAmountX: 0, attractAmountY: 100, attractSmoothY: 6, gridSizeSemis: 1 },
    },
    {
      name: "Attract along time only, at its widest",
      step: { attractMap: 0, attractAmountX: 100, attractAmountY: 0, attractSmoothX: 4 },
      bpm: 60,
    },
    {
      name: "Attract along time only, toward the grid",
      step: { attractMap: 2, attractAmountX: 100, attractAmountY: 0, attractSmoothX: 4 },
    },
  ],
  sort: [{ name: "Sort both ways", step: { sortDirection: 2 } }],
  transmute: [{ name: "Transmute to time", step: { transmuteTo: 2, transmuteAmount: 4 } }],
  dynamics: [
    { name: "Dynamics at its defaults", step: {} },
    {
      name: "Dynamics following the envelope",
      step: {
        dynamicsGainDb: 0,
        dynamicsGainDbMod1Amount: 100,
        modulator1Mode: 1,
        modulator1EnvelopeSmoothingBeats: 4,
        modulator1StereoSpread: 100,
      },
    },
  ],
  synthesize: [{ name: "Synthesize at its defaults", step: {} }],
  passthrough: [{ name: "Passthrough", step: {} }],
  binaural: [{ name: "Binaural at its defaults", step: {} }],
  waveshape: [{ name: "Waveshape at its defaults", step: {} }],
  align: [{ name: "Align at its defaults", step: {} }],
};
