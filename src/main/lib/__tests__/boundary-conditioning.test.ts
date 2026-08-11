import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GaboratorAnalysisResult } from "../types";

// Exercises the boundary conditioner (ConditionBoundaryWorker) end to end: a
// hard coefficient-domain erase leaves the surviving atoms' cross-boundary
// tails audible (a pre-tail before the audio comes back in, a tail after it
// cuts); the conditioner rewrites the margin coefficients to the analysis of
// the time-domain-exact gate, so the synthesized boundary must match a
// time-domain gate closely and the tails must drop far below the plain erase.

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
  ) => Promise<{ channels: Float32Array[] }>;
  conditionBoundary: (
    packedData: Float32Array,
    meta: {
      numFrames: number;
      numChannels: number;
      numBands: number;
      bandOffsets: Uint32Array;
      bandLengths: Uint32Array;
      bandStepLog2s: Int32Array;
    },
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
    footprint: { startFrame: number; endFrame: number; bandLo: number; bandHi: number },
  ) => Promise<{ ranges: Uint32Array; pixels: Float32Array }>;
};

const SR = 48000;
const DUR = 3;
const N = SR * DUR;
const PARAMS = { bandsPerOctave: 36, minFreq: 27.5 };
const T0 = 1.5;
const T1 = 2.0;
const F0 = Math.round(T0 * SR);
const F1 = Math.round(T1 * SR);
const TIMEOUT = 120_000;

function makeNoise(): Float32Array {
  const sig = new Float32Array(N);
  let seed = 987654321;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    sig[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
  }
  return sig;
}

function rmsDb(audio: Float32Array, fromSec: number, toSec: number): number {
  const a = Math.max(0, Math.round(fromSec * SR));
  const b = Math.min(audio.length, Math.round(toSec * SR));
  let sum = 0;
  for (let i = a; i < b; i++) sum += audio[i] * audio[i];
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20);
}

function metaOf(analysis: GaboratorAnalysisResult) {
  return {
    numFrames: analysis.numFrames,
    numChannels: analysis.numChannels,
    numBands: analysis.numBands,
    bandOffsets: analysis.bandOffsets,
    bandLengths: analysis.bandLengths,
    bandStepLog2s: analysis.bandStepLog2s,
  };
}

// Zero every coefficient whose bin edge falls in [F0, F1) — the same
// edge-membership rule the brush uses.
function erase(analysis: GaboratorAnalysisResult): Float32Array {
  const data = new Float32Array(analysis.data);
  for (let b = 0; b < analysis.numBands; b++) {
    const s = 1 << analysis.bandStepLog2s[b];
    const off = analysis.bandOffsets[b];
    for (let k = 0; k < analysis.bandLengths[b]; k++) {
      const t = k * s;
      if (t >= F0 && t < F1) {
        data[(off + k) * 4] = 0;
        data[(off + k) * 4 + 2] = 0;
      }
    }
  }
  return data;
}

function applyPatch(
  data: Float32Array,
  analysis: GaboratorAnalysisResult,
  patch: { ranges: Uint32Array; pixels: Float32Array },
): Float32Array {
  const out = new Float32Array(data);
  let src = 0;
  for (let i = 0; i < patch.ranges.length; i += 3) {
    const band = patch.ranges[i];
    const k0 = patch.ranges[i + 1];
    const count = patch.ranges[i + 2];
    out.set(patch.pixels.subarray(src, src + count * 4), (analysis.bandOffsets[band] + k0) * 4);
    src += count * 4;
  }
  return out;
}

describe("boundary conditioning", () => {
  it(
    "kills the erase boundary tails and matches the time-domain gate",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);

      const condStart = performance.now();
      const patch = await addon.conditionBoundary(erased, metaOf(analysis), SR, PARAMS, {
        startFrame: F0,
        endFrame: F1,
        bandLo: 0,
        bandHi: analysis.numBands - 1,
      });
      const condMs = performance.now() - condStart;
      expect(patch.ranges.length).toBeGreaterThan(0);

      const conditioned = applyPatch(erased, analysis, patch);

      const plain = (await addon.synthesize(erased, analysis, SR, PARAMS, false, [])).channels[0];
      const cond = (await addon.synthesize(conditioned, analysis, SR, PARAMS, false, [])).channels[0];

      // The comeback's pre-tail and the cut's tail must both drop well below
      // the plain erase without dulling the content around the boundary.
      const plainPre = rmsDb(plain, T1 - 0.15, T1 - 0.005);
      const condPre = rmsDb(cond, T1 - 0.15, T1 - 0.005);
      const plainCut = rmsDb(plain, T0 + 0.005, T0 + 0.15);
      const condCut = rmsDb(cond, T0 + 0.005, T0 + 0.15);
      expect(condPre).toBeLessThan(plainPre - 12);
      expect(condPre).toBeLessThan(-58);
      expect(condCut).toBeLessThan(plainCut - 12);
      const plainComeback = rmsDb(plain, T1, T1 + 0.03);
      const condComeback = rmsDb(cond, T1, T1 + 0.03);
      expect(Math.abs(condComeback - plainComeback)).toBeLessThan(1.5);

      // Against the ideal: gate the round-tripped audio in the time domain.
      const full = (await addon.synthesize(analysis.data, analysis, SR, PARAMS, false, [])).channels[0];
      const ideal = Float32Array.from(full, (v, i) => {
        const t = i / SR;
        return t >= T0 && t < T1 ? 0 : v;
      });
      let err = 0;
      let ref = 0;
      for (let i = 0; i < N; i++) {
        const e = cond[i] - ideal[i];
        err += e * e;
        ref += ideal[i] * ideal[i];
      }
      expect(10 * Math.log10(err / ref)).toBeLessThan(-30);

      console.log(
        `conditioning: ${condMs.toFixed(0)}ms | pre-tail ${plainPre.toFixed(1)} -> ${condPre.toFixed(1)} dB | ` +
          `cut-tail ${plainCut.toFixed(1)} -> ${condCut.toFixed(1)} dB`,
      );
    },
    TIMEOUT,
  );

  it(
    "leaves coefficients outside the returned ranges untouched and no-ops on full-file footprints",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);

      const patch = await addon.conditionBoundary(erased, metaOf(analysis), SR, PARAMS, {
        startFrame: F0,
        endFrame: F1,
        bandLo: 0,
        bandHi: analysis.numBands - 1,
      });
      // The worker must not mutate its input; the patch alone carries changes.
      expect(erase(analysis)).toEqual(erased);

      const conditioned = applyPatch(erased, analysis, patch);
      const patchedPixels = new Set<number>();
      for (let i = 0; i < patch.ranges.length; i += 3) {
        const start = analysis.bandOffsets[patch.ranges[i]] + patch.ranges[i + 1];
        for (let p = 0; p < patch.ranges[i + 2]; p++) patchedPixels.add(start + p);
      }
      for (let px = 0; px < erased.length / 4; px += 997) {
        if (patchedPixels.has(px)) continue;
        expect(conditioned[px * 4]).toBe(erased[px * 4]);
        expect(conditioned[px * 4 + 1]).toBe(erased[px * 4 + 1]);
      }

      // A footprint spanning the whole file has no interior edges.
      const noop = await addon.conditionBoundary(erased, metaOf(analysis), SR, PARAMS, {
        startFrame: 0,
        endFrame: analysis.numFrames,
        bandLo: 0,
        bandHi: analysis.numBands - 1,
      });
      expect(noop.ranges.length).toBe(0);
    },
    TIMEOUT,
  );
});
