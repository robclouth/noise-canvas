import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ClipAnalysisLayout } from "../../../renderer/src/lib/clip-analysis";
import { computeClipAttribution, findOverloads } from "../../../renderer/src/lib/clip-analysis";
import type { GaboratorAnalysisResult } from "../types";

// Exercises clipping detection against the real analysis and synthesis rather
// than a hand-built spectrogram. The baked limiter's release outlasts the peak
// that triggers it, so on dense material its gain-reduction envelope never
// returns to zero — which a mock envelope does not reproduce.

const require = createRequire(import.meta.url);
const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
  synthesize: (
    data: Float32Array,
    analysis: GaboratorAnalysisResult,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
    applyLimiter: boolean,
    existingAudio: Float32Array[],
  ) => Promise<{ channels: Float32Array[]; gainReductionDb?: Float32Array; maxGainReductionDb?: number }>;
};

const SR = 48000;
const DUR = 4;
const N = SR * DUR;
const PARAMS = { bandsPerOctave: 36, minFreq: 27.5 };
const OVERLAP = 0.7;
const FULL_TINT_DB = 6;
const TIMEOUT = 120_000;

/** Loud sustained tone plus a transient every 250 ms — ordinary loud material. */
function makeLoudSignal(): Float32Array {
  const sig = new Float32Array(N);
  let seed = 12345;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff) * 2 - 1;
    let v = 0.55 * Math.sin(2 * Math.PI * 110 * t) + 0.45 * Math.sin(2 * Math.PI * 277 * t + 0.4);
    const phase = t % 0.25;
    if (phase < 0.01) v += 1.2 * Math.exp(-phase * 400) * noise;
    sig[i] = v;
  }
  return sig;
}

function toLayout(analysis: GaboratorAnalysisResult): ClipAnalysisLayout {
  return {
    metadata: analysis.metadata,
    textureWidth: analysis.textureWidth,
    textureHeight: analysis.textureHeight,
    numBands: analysis.numBands,
    numChannels: analysis.numChannels,
    sampleRate: SR,
    bandsPerOctave: PARAMS.bandsPerOctave,
    synthesisMetadata: {
      bandOffsets: analysis.bandOffsets,
      bandStepLog2s: analysis.bandStepLog2s,
      bandLengths: analysis.bandLengths,
    },
  };
}

describe("clip detection against real synthesis", () => {
  it(
    "finds overloads across the file, not one for the whole limited stretch",
    async () => {
      const analysis = await addon.analyze([makeLoudSignal()], 1, SR, PARAMS);
      const limited = await addon.synthesize(analysis.data, analysis, SR, PARAMS, true, []);
      const raw = await addon.synthesize(analysis.data, analysis, SR, PARAMS, false, []);

      const gainReductionDb = limited.gainReductionDb ?? null;
      expect(gainReductionDb).not.toBeNull();

      // The material is loud enough that the limiter is working almost everywhere.
      const reduced = Array.from(gainReductionDb!).filter((db) => db > 0.1).length;
      expect(reduced / gainReductionDb!.length).toBeGreaterThan(0.5);

      // Ground truth: distinct excursions past full scale without the limiter.
      let excursions = 0;
      let inExcursion = false;
      for (const sample of raw.channels[0]) {
        const over = Math.abs(sample) >= 1;
        if (over && !inExcursion) excursions++;
        inExcursion = over;
      }
      expect(excursions).toBeGreaterThan(50);

      const overloads = findOverloads(limited.channels, SR, gainReductionDb);

      // The whole point: many overloads, spread over the file.
      expect(overloads.length).toBeGreaterThan(50);
      const times = overloads.map((o) => o.sample / SR);
      expect(Math.min(...times)).toBeLessThan(1);
      expect(Math.max(...times)).toBeGreaterThan(DUR - 1);

      // Every reported overload sits at a peak the limiter is holding to the
      // ceiling, and carries the reduction there as its severity.
      let ceiling = 0;
      for (const sample of limited.channels[0]) ceiling = Math.max(ceiling, Math.abs(sample));
      for (const overload of overloads) {
        expect(Math.abs(limited.channels[0][overload.sample])).toBeGreaterThan(ceiling * 0.5);
        expect(overload.excessDb).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    "marks only coefficients worth attenuating, and marks them visibly",
    async () => {
      const analysis = await addon.analyze([makeLoudSignal()], 1, SR, PARAMS);
      const limited = await addon.synthesize(analysis.data, analysis, SR, PARAMS, true, []);
      const overloads = findOverloads(limited.channels, SR, limited.gainReductionDb ?? null);
      expect(overloads.length).toBeGreaterThan(0);

      const attribution = computeClipAttribution(toLayout(analysis), analysis.data, overloads, OVERLAP, FULL_TINT_DB);

      let marked = 0;
      let peak = 0;
      for (const value of attribution) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        if (value > 0) marked++;
        peak = Math.max(peak, value);
      }

      expect(marked).toBeGreaterThan(0);
      expect(peak).toBeGreaterThan(0.5);
      // Blaming everything would be no answer at all.
      expect(marked).toBeLessThan(attribution.length * 0.5);
    },
    TIMEOUT,
  );

  it(
    "fades as the coefficients it blames are attenuated",
    async () => {
      const analysis = await addon.analyze([makeLoudSignal()], 1, SR, PARAMS);
      const layout = toLayout(analysis);

      const before = await addon.synthesize(analysis.data, analysis, SR, PARAMS, true, []);
      const overloads = findOverloads(before.channels, SR, before.gainReductionDb ?? null);
      const blame = computeClipAttribution(layout, analysis.data, overloads, OVERLAP, FULL_TINT_DB);

      let blameTotal = 0;
      for (const value of blame) blameTotal += value;
      expect(blameTotal).toBeGreaterThan(0);

      // Turn the blamed coefficients down in proportion to how hard they are
      // blamed, leave everything else alone, and re-run the whole chain.
      const quieter = Float32Array.from(analysis.data);
      for (let pixel = 0; pixel < blame.length; pixel++) {
        const gain = 1 - 0.9 * blame[pixel];
        quieter[pixel * 4] *= gain;
        quieter[pixel * 4 + 2] *= gain;
      }

      const after = await addon.synthesize(quieter, analysis, SR, PARAMS, true, []);
      const overloadsAfter = findOverloads(after.channels, SR, after.gainReductionDb ?? null);
      const blameAfter = computeClipAttribution(layout, quieter, overloadsAfter, OVERLAP, FULL_TINT_DB);

      let blameTotalAfter = 0;
      for (const value of blameAfter) blameTotalAfter += value;

      // The point of the overlay: painting the red down clears the red.
      expect(after.maxGainReductionDb ?? 0).toBeLessThan(before.maxGainReductionDb ?? 0);
      expect(blameTotalAfter).toBeLessThan(blameTotal);
    },
    TIMEOUT,
  );

  it(
    "finds and attributes the overshoot with the limiter bypassed",
    async () => {
      const analysis = await addon.analyze([makeLoudSignal()], 1, SR, PARAMS);
      const raw = await addon.synthesize(analysis.data, analysis, SR, PARAMS, false, []);

      // Bypassed, the addon returns an empty envelope rather than none at all,
      // so the overshoot has to be read from the samples.
      const gainReductionDb = raw.gainReductionDb ?? null;
      expect(gainReductionDb === null || gainReductionDb.length === 0).toBe(true);

      let peakSample = 0;
      for (const sample of raw.channels[0]) peakSample = Math.max(peakSample, Math.abs(sample));
      expect(peakSample).toBeGreaterThan(1);

      const overloads = findOverloads(raw.channels, SR, gainReductionDb);
      expect(overloads.length).toBeGreaterThan(50);

      // Each one names a sample that is genuinely past full scale.
      for (const overload of overloads) {
        expect(Math.abs(raw.channels[0][overload.sample])).toBeGreaterThanOrEqual(1);
        expect(Math.sign(raw.channels[0][overload.sample])).toBe(overload.sign);
        expect(overload.excessDb).toBeGreaterThan(0);
      }

      const attribution = computeClipAttribution(toLayout(analysis), analysis.data, overloads, OVERLAP, FULL_TINT_DB);

      let marked = 0;
      let peak = 0;
      for (const value of attribution) {
        if (value > 0) marked++;
        peak = Math.max(peak, value);
      }
      expect(marked).toBeGreaterThan(0);
      expect(peak).toBeGreaterThan(0.5);
    },
    TIMEOUT,
  );
});
