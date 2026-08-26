import { describe, expect, it } from "vitest";

import { analyseChannels, spliceAnalyseChannels, spliceQuantSamples } from "../audio-analysis";
import { insertSpan, insertSpanPieces, removeSpan, removeSpanPieces } from "../ripple-edits";
import type { PackedLayout } from "../types";

// spliceAnalyse rebuilds a spliced file's coefficients from its old analysis
// plus windows of fresh analysis. Its contract is equivalence: the result must
// match a full analysis of the same audio, band for band, wherever a full
// analysis would be the reference.

const SR = 44100;
const PARAMS = { bandsPerOctave: 12, minFreq: 40 };
const FADE = Math.round(0.005 * SR);
const N = SR * 6;

function material(n: number, seed: number, phase = 0): Float32Array {
  const x = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = (s / 4294967296 - 0.5) * 0.25;
    x[i] += 0.35 * Math.sin((2 * Math.PI * 55 * i) / SR + phase);
    x[i] += 0.25 * Math.sin((2 * Math.PI * 330 * i) / SR + 1.3 + phase);
    x[i] += 0.15 * Math.sin((2 * Math.PI * 2100 * i) / SR + 0.4);
    if (i % (SR >> 1) < 30) x[i] += 0.6 * Math.exp(-(i % (SR >> 1)) / 6);
  }
  return x;
}

type Analysis = Awaited<ReturnType<typeof analyseChannels>>;

function layoutOf(a: Analysis): PackedLayout {
  return {
    numFrames: a.numFrames,
    numChannels: a.numChannels,
    numBands: a.numBands,
    bandOffsets: a.bandOffsets,
    bandStepLog2s: a.bandStepLog2s,
    bandLengths: a.bandLengths,
  };
}

async function expectEquivalent(
  oldAnalysis: Analysis,
  newChannels: Float32Array[],
  pieces: Parameters<typeof spliceAnalyseChannels>[5],
) {
  const ref = await analyseChannels(newChannels, SR, { ...PARAMS, detectOnsets: false });
  const spliced = await spliceAnalyseChannels(newChannels, SR, PARAMS, oldAnalysis.data, layoutOf(oldAnalysis), pieces);

  expect(spliced.numFrames).toBe(ref.numFrames);
  expect(spliced.textureWidth).toBe(ref.textureWidth);
  expect(spliced.textureHeight).toBe(ref.textureHeight);
  expect(Array.from(spliced.bandOffsets)).toEqual(Array.from(ref.bandOffsets));
  expect(Array.from(spliced.bandLengths)).toEqual(Array.from(ref.bandLengths));
  expect(spliced.inverseMap).toEqual(ref.inverseMap);
  expect(spliced.metadata).toEqual(ref.metadata);

  let worstMag = 0;
  let worstPhase = 0;
  let invariantBreaks = 0;
  for (let b = 0; b < ref.numBands; b++) {
    const off = ref.bandOffsets[b];
    const len = ref.bandLengths[b];
    let peak = 1e-9;
    for (let k = 0; k < len; k++) {
      for (let c = 0; c < ref.numChannels; c++) peak = Math.max(peak, ref.data[(off + k) * 4 + c * 2]);
    }
    for (let c = 0; c < ref.numChannels; c++) {
      let prev = 0;
      let havePrev = false;
      for (let k = 0; k < len; k++) {
        const magRef = ref.data[(off + k) * 4 + c * 2];
        const magSp = spliced.data[(off + k) * 4 + c * 2];
        const phaseSp = spliced.data[(off + k) * 4 + c * 2 + 1];
        worstMag = Math.max(worstMag, Math.abs(magSp - magRef) / peak);
        if (magRef > peak * 1e-2) {
          const phaseRef = ref.data[(off + k) * 4 + c * 2 + 1];
          let d = (phaseSp - phaseRef) % (2 * Math.PI);
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          worstPhase = Math.max(worstPhase, Math.abs(d));
        }
        if (havePrev && Math.abs(phaseSp - prev) > Math.PI + 1e-3) invariantBreaks++;
        prev = phaseSp;
        havePrev = true;
      }
    }
  }
  expect(worstMag).toBeLessThan(5e-4);
  expect(worstPhase).toBeLessThan(2e-2);
  expect(invariantBreaks).toBe(0);
  const energyRel = Math.abs(spliced.magnitudeEnergy - ref.magnitudeEnergy) / ref.magnitudeEnergy;
  expect(energyRel).toBeLessThan(1e-6);
}

describe("spliceAnalyse equivalence with a full analysis", () => {
  it("matches on a quantised ripple cut", async () => {
    const old = [material(N, 11)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const quant = spliceQuantSamples(SR);
    const a = 2 * SR;
    const b = a + Math.round((1.23 * SR) / quant) * quant;
    await expectEquivalent(oldAnalysis, removeSpan(old, a, b, FADE), removeSpanPieces(N, a, b, FADE));
  }, 60000);

  it("matches on an unquantised odd-length cut, only slower", async () => {
    const old = [material(N, 12)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const a = 2 * SR;
    const b = a + 60001;
    await expectEquivalent(oldAnalysis, removeSpan(old, a, b, FADE), removeSpanPieces(N, a, b, FADE));
  }, 60000);

  it("matches on a cut that reaches the start of the file", async () => {
    const old = [material(N, 13)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const quant = spliceQuantSamples(SR);
    const b = Math.round((0.8 * SR) / quant) * quant;
    await expectEquivalent(oldAnalysis, removeSpan(old, 0, b, FADE), removeSpanPieces(N, 0, b, FADE));
  }, 60000);

  it("matches on an insertion, silence and noise, mid-file", async () => {
    const old = [material(N, 14)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const quant = spliceQuantSamples(SR);
    const at = 3 * SR;
    const len = Math.round((0.9 * SR) / quant) * quant;
    await expectEquivalent(
      oldAnalysis,
      insertSpan(old, at, [new Float32Array(len)], FADE),
      insertSpanPieces(N, at, len, FADE),
    );
    await expectEquivalent(
      oldAnalysis,
      insertSpan(old, at, [material(len, 77)], FADE),
      insertSpanPieces(N, at, len, FADE),
    );
  }, 120000);

  it("matches on a stereo cut", async () => {
    const old = [material(N, 21), material(N, 22, 0.7)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const quant = spliceQuantSamples(SR);
    const a = 2 * SR;
    const b = a + Math.round((1.0 * SR) / quant) * quant;
    await expectEquivalent(oldAnalysis, removeSpan(old, a, b, FADE), removeSpanPieces(N, a, b, FADE));
  }, 60000);

  it("matches on a doubling and a halving of the file", async () => {
    const old = [material(N, 31)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const doubled = [new Float32Array(N * 2)];
    doubled[0].set(old[0], 0);
    doubled[0].set(old[0], N);
    await expectEquivalent(oldAnalysis, doubled, [
      { newStart: 0, oldStart: 0, length: N },
      { newStart: N, oldStart: 0, length: N },
    ]);
    const half = Math.floor(N / 2);
    await expectEquivalent(oldAnalysis, [old[0].slice(0, half)], [{ newStart: 0, oldStart: 0, length: half }]);
  }, 120000);
});

describe("spliceAnalyse rejections", () => {
  it("rejects a band layout that is not the analyzer's own", async () => {
    const old = [material(SR, 41)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    const layout = layoutOf(oldAnalysis);
    const brokenSteps = layout.bandStepLog2s.slice();
    brokenSteps[0] += 1;
    await expect(
      spliceAnalyseChannels(old, SR, PARAMS, oldAnalysis.data, { ...layout, bandStepLog2s: brokenSteps }, [
        { newStart: 0, oldStart: 0, length: SR },
      ]),
    ).rejects.toThrow(/layout mismatch/);
  }, 60000);

  it("rejects overlapping pieces", async () => {
    const old = [material(SR, 42)];
    const oldAnalysis = await analyseChannels(old, SR, { ...PARAMS, detectOnsets: false });
    await expect(
      spliceAnalyseChannels(old, SR, PARAMS, oldAnalysis.data, layoutOf(oldAnalysis), [
        { newStart: 0, oldStart: 0, length: SR },
        { newStart: SR >> 1, oldStart: 0, length: SR >> 1 },
      ]),
    ).rejects.toThrow(/disjoint/);
  }, 60000);
});
