import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GaboratorAnalysisResult } from "../types";

// Exercises the commit pass (CommitStrokeWorker) end to end. A commit turns a
// painted canvas into the audio it means, gates its hard time edges, limits
// inside the stroke, and hands back the coefficients that audio analyses to —
// so the picture is the analysis of what is heard.

const require = createRequire(import.meta.url);

interface CommitWindow {
  startFrame: number;
  endFrame: number;
  startBand: number;
  endBand: number;
}

interface CommitStroke {
  footStartFrame: number;
  footEndFrame: number;
  hardEdgeStart: boolean;
  hardEdgeEnd: boolean;
  applyLimiter: boolean;
  project: boolean;
}

interface CommitResult {
  channels: Float32Array[];
  peak: number;
  patch: { ranges: Uint32Array; pixels: Float32Array };
  gainReductionDb: Float32Array;
  maxGainReductionDb: number;
  levels: { startHop: number; peaks: Float32Array; overDb: Float32Array };
  onsets?: Float32Array;
  onsetOdfMax?: number;
  onsetBandMax?: Float32Array;
}

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
  commitStroke: (
    packedData: Float32Array,
    analysisMetadata: {
      numFrames: number;
      numChannels: number;
      numBands: number;
      bandOffsets: Uint32Array;
      bandLengths: Uint32Array;
      bandStepLog2s: Int32Array;
    },
    sampleRate: number,
    params: {
      bandsPerOctave: number;
      minFreq: number;
      detectOnsets?: boolean;
      onsetStartSec?: number;
      onsetEndSec?: number;
      onsetOdfReference?: number;
      onsetBandMax?: Float32Array;
    },
    existingAudio: Float32Array[],
    window: CommitWindow,
    stroke: CommitStroke,
  ) => Promise<CommitResult>;
};

const SR = 48000;
const DUR = 3;
const N = SR * DUR;
const PARAMS = { bandsPerOctave: 36, minFreq: 27.5 };
const T0 = 1.5;
const T1 = 2.0;
const F0 = Math.round(T0 * SR);
const F1 = Math.round(T1 * SR);
const HOP = Math.round(SR * 0.005);
const TIMEOUT = 180_000;

function makeNoise(amplitude = 0.3, seedInit = 987654321): Float32Array {
  const sig = new Float32Array(N);
  let seed = seedInit;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    sig[i] = ((seed / 0x7fffffff) * 2 - 1) * amplitude;
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

// Zero every coefficient whose bin edge falls in [from, to) — the same
// edge-membership rule the brush uses.
function erase(analysis: GaboratorAnalysisResult, from = F0, to = F1): Float32Array {
  const data = new Float32Array(analysis.data);
  for (let b = 0; b < analysis.numBands; b++) {
    const s = 1 << analysis.bandStepLog2s[b];
    const off = analysis.bandOffsets[b];
    for (let k = 0; k < analysis.bandLengths[b]; k++) {
      const t = k * s;
      if (t >= from && t < to) {
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

function fullWindow(analysis: GaboratorAnalysisResult): CommitWindow {
  return { startFrame: F0, endFrame: F1, startBand: 0, endBand: analysis.numBands };
}

function gateStroke(overrides: Partial<CommitStroke> = {}): CommitStroke {
  return {
    footStartFrame: F0,
    footEndFrame: F1,
    hardEdgeStart: true,
    hardEdgeEnd: true,
    applyLimiter: false,
    project: true,
    ...overrides,
  };
}

async function roundTrip(analysis: GaboratorAnalysisResult, data: Float32Array): Promise<Float32Array> {
  return (await addon.synthesize(data, analysis, SR, PARAMS, false, [])).channels[0];
}

describe("commit stroke", () => {
  it(
    "gates a hard erase as exactly as the boundary conditioner did",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);
      const original = await roundTrip(analysis, analysis.data);

      const plain = await roundTrip(analysis, erased);
      const commit = await addon.commitStroke(
        erased,
        metaOf(analysis),
        SR,
        PARAMS,
        [original],
        fullWindow(analysis),
        gateStroke(),
      );
      const gated = commit.channels[0];

      // The comeback's pre-tail and the cut's tail are exterior atoms ringing
      // into the erased span; both must fall far below the plain erase without
      // dulling the content that comes back.
      const plainPre = rmsDb(plain, T1 - 0.15, T1 - 0.005);
      const gatedPre = rmsDb(gated, T1 - 0.15, T1 - 0.005);
      const plainCut = rmsDb(plain, T0 + 0.005, T0 + 0.15);
      const gatedCut = rmsDb(gated, T0 + 0.005, T0 + 0.15);
      expect(gatedPre).toBeLessThan(plainPre - 12);
      expect(gatedPre).toBeLessThan(-58);
      expect(gatedCut).toBeLessThan(plainCut - 12);
      const plainComeback = rmsDb(plain, T1, T1 + 0.03);
      const gatedComeback = rmsDb(gated, T1, T1 + 0.03);
      expect(Math.abs(gatedComeback - plainComeback)).toBeLessThan(1.5);

      // Against the ideal: gate the round-tripped audio in the time domain.
      let err = 0;
      let ref = 0;
      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const ideal = t >= T0 && t < T1 ? 0 : original[i];
        const e = gated[i] - ideal;
        err += e * e;
        ref += ideal * ideal;
      }
      expect(10 * Math.log10(err / ref)).toBeLessThan(-30);

      console.log(
        `commit gate | pre-tail ${plainPre.toFixed(1)} -> ${gatedPre.toFixed(1)} dB | ` +
          `cut-tail ${plainCut.toFixed(1)} -> ${gatedCut.toFixed(1)} dB`,
      );
    },
    TIMEOUT,
  );

  it(
    "returns coefficients the audio actually analyses to",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);
      const original = await roundTrip(analysis, analysis.data);

      const commit = await addon.commitStroke(
        erased,
        metaOf(analysis),
        SR,
        PARAMS,
        [original],
        fullWindow(analysis),
        gateStroke(),
      );
      expect(commit.patch.ranges.length).toBeGreaterThan(0);

      // Synthesising the projected canvas must reproduce the audio the commit
      // returned, over the interior of the window it rebuilt.
      const projected = applyPatch(erased, analysis, commit.patch);
      const fromCanvas = await roundTrip(analysis, projected);

      const a = Math.round((T0 - 0.2) * SR);
      const b = Math.round((T1 + 0.2) * SR);
      let err = 0;
      let ref = 0;
      for (let i = a; i < b; i++) {
        const e = fromCanvas[i] - commit.channels[0][i];
        err += e * e;
        ref += commit.channels[0][i] * commit.channels[0][i];
      }
      expect(10 * Math.log10(err / Math.max(ref, 1e-20))).toBeLessThan(-40);
    },
    TIMEOUT,
  );

  it(
    "settles: committing the projected canvas again converges rather than drifts",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);

      let canvas = erase(analysis);
      let audio = original;
      const audios: Float32Array[] = [];
      for (let round = 0; round < 4; round++) {
        const commit = await addon.commitStroke(
          canvas,
          metaOf(analysis),
          SR,
          PARAMS,
          [audio],
          fullWindow(analysis),
          gateStroke(),
        );
        audios.push(commit.channels[0]);
        canvas = applyPatch(canvas, analysis, commit.patch);
        audio = commit.channels[0];
      }

      const diffDb = (a: Float32Array, b: Float32Array): number => {
        let err = 0;
        let ref = 0;
        for (let i = 0; i < N; i++) {
          const e = a[i] - b[i];
          err += e * e;
          ref += b[i] * b[i];
        }
        return 10 * Math.log10(err / ref);
      };

      // Analysis and synthesis reconstruct, so the projection is a projection:
      // the first repeat is already far down, and every repeat after it is
      // smaller again. A drifting canvas would show the opposite.
      const steps = [diffDb(audios[1], audios[0]), diffDb(audios[2], audios[1]), diffDb(audios[3], audios[2])];
      expect(steps[0]).toBeLessThan(-55);
      expect(steps[1]).toBeLessThan(steps[0]);
      expect(steps[2]).toBeLessThan(steps[0]);
      console.log(`commit settling: ${steps.map((s) => s.toFixed(1)).join(" -> ")} dB`);
    },
    TIMEOUT,
  );

  it(
    "keeps the stored phase unwrapped, across the patch and both its seams",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);
      const original = await roundTrip(analysis, analysis.data);

      const commit = await addon.commitStroke(
        erased,
        metaOf(analysis),
        SR,
        PARAMS,
        [original],
        fullWindow(analysis),
        gateStroke(),
      );
      const projected = applyPatch(erased, analysis, commit.patch);

      // The packed format stores phase unwrapped in time, so neighbours never
      // differ by more than pi — including across both seams of the patch. The
      // transform reads that difference as pitch, so a turn landing on the
      // wrong branch reads as a jump in frequency.
      const worstOf = (data: Float32Array): number => {
        let worst = 0;
        for (let b = 0; b < analysis.numBands; b++) {
          const off = analysis.bandOffsets[b];
          for (let k = 1; k < analysis.bandLengths[b]; k++) {
            worst = Math.max(worst, Math.abs(data[(off + k) * 4 + 1] - data[(off + k - 1) * 4 + 1]));
          }
        }
        return worst;
      };
      // The analysis itself reaches pi exactly, so the projection must not go
      // past whatever a fresh analysis of the same file already stores.
      expect(worstOf(projected)).toBeLessThanOrEqual(worstOf(analysis.data));
    },
    TIMEOUT,
  );

  it(
    "limits inside the stroke only, and never moves the margins away from the existing audio",
    async () => {
      const analysis = await addon.analyze([makeNoise(0.3)], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);

      // Paint the span far too loud, then commit it with and without limiting.
      const loud = new Float32Array(analysis.data);
      for (let b = 0; b < analysis.numBands; b++) {
        const s = 1 << analysis.bandStepLog2s[b];
        const off = analysis.bandOffsets[b];
        for (let k = 0; k < analysis.bandLengths[b]; k++) {
          const t = k * s;
          if (t >= F0 && t < F1) loud[(off + k) * 4] *= 12;
        }
      }
      const window = fullWindow(analysis);
      const stroke = gateStroke({ hardEdgeStart: false, hardEdgeEnd: false });

      const bypassed = await addon.commitStroke(loud, metaOf(analysis), SR, PARAMS, [original], window, stroke);
      const limited = await addon.commitStroke(loud, metaOf(analysis), SR, PARAMS, [original], window, {
        ...stroke,
        applyLimiter: true,
      });

      expect(bypassed.peak).toBeGreaterThan(1);
      expect(limited.maxGainReductionDb).toBeGreaterThan(1);
      expect(limited.peak).toBeLessThan(bypassed.peak);

      // Outside the footprint the gain acts on the stroke's contribution
      // alone, so limiting can only move a margin sample toward the existing
      // audio, never past it — and where the commit already left the existing
      // audio bit-exact, it stays bit-exact.
      const checkMargin = (i: number): void => {
        const ex = original[i];
        const off = bypassed.channels[0][i];
        const on = limited.channels[0][i];
        if (off === ex) {
          expect(on).toBe(ex);
          return;
        }
        expect(Math.abs(on - off)).toBeLessThanOrEqual(Math.abs(off - ex) + 1e-6);
        expect(Math.abs(on - ex)).toBeLessThanOrEqual(Math.abs(off - ex) + 1e-6);
      };
      for (let i = 0; i < F0 - SR * 0.05; i += 97) checkMargin(i);
      for (let i = F1 + Math.round(SR * 0.05); i < N; i += 97) checkMargin(i);

      // Inside, the peak is held under the limiter's ceiling.
      let inside = 0;
      for (let i = F0; i < F1; i++) inside = Math.max(inside, Math.abs(limited.channels[0][i]));
      expect(inside).toBeLessThan(1);
    },
    TIMEOUT,
  );

  it(
    "keeps a stroke audible on already-hot audio, held to the loudness that was there",
    async () => {
      // A hot bed whose inter-sample true peak sits at its sample peak: a
      // loud low tone plus a little noise. Broadband noise at full scale
      // would carry true peaks far over its sample peak, and the limiter's
      // ceiling honours true peaks.
      const noise = makeNoise(0.12, 555555);
      const hot = new Float32Array(N);
      for (let i = 0; i < N; i++) hot[i] = 0.85 * Math.sin((2 * Math.PI * 220 * i) / SR) + noise[i];
      const analysis = await addon.analyze([hot], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);

      // Boost only the shortest-stride (highest-frequency) bands, so the
      // stroke is a timbre change that survives being held to the existing
      // loudness.
      const minStep = Math.min(...Array.from(analysis.bandStepLog2s));
      const loud = new Float32Array(analysis.data);
      for (let b = 0; b < analysis.numBands; b++) {
        if (analysis.bandStepLog2s[b] > minStep + 1) continue;
        const s = 1 << analysis.bandStepLog2s[b];
        const off = analysis.bandOffsets[b];
        for (let k = 0; k < analysis.bandLengths[b]; k++) {
          const t = k * s;
          if (t >= F0 && t < F1) loud[(off + k) * 4] *= 16;
        }
      }
      const window = fullWindow(analysis);
      const stroke = gateStroke({ hardEdgeStart: false, hardEdgeEnd: false });

      const bypassed = await addon.commitStroke(loud, metaOf(analysis), SR, PARAMS, [original], window, stroke);
      const limited = await addon.commitStroke(loud, metaOf(analysis), SR, PARAMS, [original], window, {
        ...stroke,
        applyLimiter: true,
      });

      expect(limited.maxGainReductionDb).toBeGreaterThan(1);
      expect(limited.peak).toBeLessThan(bypassed.peak);

      // Held to the loudness that was there: the existing audio already sits
      // over the global ceiling, and the stroke must not push past it. A soft
      // edge's mask ramp may pass a sliver of the existing level, so the soft
      // bound is read clear of the ramps.
      const ramp = Math.round(SR * 0.015);
      let originalPeak = 0;
      let insidePeak = 0;
      for (let i = F0 + ramp; i < F1 - ramp; i++) {
        originalPeak = Math.max(originalPeak, Math.abs(original[i]));
        insidePeak = Math.max(insidePeak, Math.abs(limited.channels[0][i]));
      }
      expect(insidePeak).toBeLessThan(originalPeak * 1.2);

      // A gated hard edge takes no ramp, so the bound holds over the whole
      // footprint, first sample to last.
      const hardLimited = await addon.commitStroke(loud, metaOf(analysis), SR, PARAMS, [original], window, {
        ...stroke,
        hardEdgeStart: true,
        hardEdgeEnd: true,
        applyLimiter: true,
      });
      let originalPeakFull = 0;
      let hardInsidePeak = 0;
      for (let i = F0; i < F1; i++) {
        originalPeakFull = Math.max(originalPeakFull, Math.abs(original[i]));
        hardInsidePeak = Math.max(hardInsidePeak, Math.abs(hardLimited.channels[0][i]));
      }
      expect(hardInsidePeak).toBeLessThan(originalPeakFull * 1.2);

      // Not cancelled: the stroke still reads as a clear change to the audio.
      const changeDb = (audio: Float32Array): number => {
        const a = Math.round((T0 + 0.05) * SR);
        const b = Math.round((T1 - 0.05) * SR);
        let sum = 0;
        for (let i = a; i < b; i++) sum += (audio[i] - original[i]) ** 2;
        return 10 * Math.log10(sum / (b - a) + 1e-20);
      };
      expect(changeDb(limited.channels[0])).toBeGreaterThan(rmsDb(original, T0 + 0.05, T1 - 0.05) - 12);
    },
    TIMEOUT,
  );

  it(
    "reports levels over the window and marks only the slices that clipped",
    async () => {
      const analysis = await addon.analyze([makeNoise(0.3)], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);
      const loud = new Float32Array(analysis.data);
      for (let b = 0; b < analysis.numBands; b++) {
        const s = 1 << analysis.bandStepLog2s[b];
        const off = analysis.bandOffsets[b];
        for (let k = 0; k < analysis.bandLengths[b]; k++) {
          const t = k * s;
          if (t >= F0 && t < F1) loud[(off + k) * 4] *= 12;
        }
      }

      const commit = await addon.commitStroke(
        loud,
        metaOf(analysis),
        SR,
        PARAMS,
        [original],
        fullWindow(analysis),
        gateStroke({ hardEdgeStart: false, hardEdgeEnd: false }),
      );

      expect(commit.levels.peaks.length).toBe(commit.levels.overDb.length);
      expect(commit.levels.peaks.length).toBeGreaterThan(0);
      // The window starts before the footprint, so its first hop precedes it.
      expect(commit.levels.startHop).toBeLessThanOrEqual(Math.floor(F0 / HOP));

      // Each reported peak is the real peak of its slice.
      for (let p = 0; p < commit.levels.peaks.length; p += 13) {
        const s0 = (commit.levels.startHop + p) * HOP;
        const s1 = Math.min(N, s0 + HOP);
        let peak = 0;
        for (let i = s0; i < s1; i++) peak = Math.max(peak, Math.abs(commit.channels[0][i]));
        expect(commit.levels.peaks[p]).toBeCloseTo(peak, 5);
      }

      let overInside = 0;
      for (let p = 0; p < commit.levels.overDb.length; p++) {
        const sample = (commit.levels.startHop + p) * HOP;
        if (commit.levels.overDb[p] > 0 && sample >= F0 && sample < F1) overInside++;
        if (commit.levels.overDb[p] > 0) expect(sample).toBeGreaterThanOrEqual(F0 - HOP);
      }
      expect(overInside).toBeGreaterThan(0);

      // The limiter keeps the same stroke inside headroom, so nothing marks:
      // the levels read the samples the same way whether it ran or not.
      const limited = await addon.commitStroke(
        loud,
        metaOf(analysis),
        SR,
        PARAMS,
        [original],
        fullWindow(analysis),
        gateStroke({ hardEdgeStart: false, hardEdgeEnd: false, applyLimiter: true }),
      );
      expect(limited.maxGainReductionDb).toBeGreaterThan(0);
      for (let p = 0; p < limited.levels.overDb.length; p++) expect(limited.levels.overDb[p]).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "never writes to its input, and fails whole on a bad request",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);
      const before = new Float32Array(erased);
      const original = await roundTrip(analysis, analysis.data);

      await addon.commitStroke(erased, metaOf(analysis), SR, PARAMS, [original], fullWindow(analysis), gateStroke());
      expect(erased).toEqual(before);

      // Existing audio that does not match the analysis is a caller bug, and a
      // bug must not produce half a commit.
      await expect(
        addon.commitStroke(
          erased,
          metaOf(analysis),
          SR,
          PARAMS,
          [new Float32Array(N - 1)],
          fullWindow(analysis),
          gateStroke(),
        ),
      ).rejects.toThrow();

      await expect(
        addon.commitStroke(
          erased,
          { ...metaOf(analysis), numChannels: 2 },
          SR,
          PARAMS,
          [original],
          fullWindow(analysis),
          gateStroke(),
        ),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "rebuilds the whole file when there is no audio to splice into",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const erased = erase(analysis);

      const commit = await addon.commitStroke(
        erased,
        metaOf(analysis),
        SR,
        PARAMS,
        [],
        fullWindow(analysis),
        gateStroke(),
      );

      expect(commit.channels.length).toBe(1);
      expect(commit.channels[0].length).toBe(N);
      expect(commit.levels.startHop).toBe(0);
      expect(commit.levels.peaks.length).toBe(Math.floor((N - 1) / HOP) + 1);

      // A full rebuild is the plain synthesis of the canvas: no existing audio
      // means no hard edge to gate against.
      const plain = await roundTrip(analysis, erased);
      let err = 0;
      let ref = 0;
      for (let i = 0; i < N; i++) {
        const e = commit.channels[0][i] - plain[i];
        err += e * e;
        ref += plain[i] * plain[i];
      }
      expect(10 * Math.log10(err / ref)).toBeLessThan(-100);
    },
    TIMEOUT,
  );

  it(
    "finds onsets through the patch, so they answer to the projection",
    async () => {
      // Two clicks, one inside the span the stroke erases and one outside it.
      const sig = new Float32Array(N);
      for (let i = 0; i < N; i++) sig[i] = 0;
      const click = (at: number) => {
        for (let i = 0; i < 64; i++) sig[at + i] += Math.exp(-i / 12) * (i % 2 ? -0.8 : 0.8);
      };
      click(Math.round(0.5 * SR));
      click(Math.round(1.7 * SR));

      const analysis = await addon.analyze([sig], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);
      const erased = erase(analysis);

      const commit = await addon.commitStroke(
        erased,
        metaOf(analysis),
        SR,
        { ...PARAMS, detectOnsets: true },
        [original],
        fullWindow(analysis),
        gateStroke(),
      );
      expect(commit.onsets).toBeDefined();

      const times: number[] = [];
      const onsets = commit.onsets as Float32Array;
      for (let i = 0; i < onsets.length; i += 2) times.push(onsets[i]);

      // The click outside the erased span survives; the one inside it does not.
      expect(times.some((t) => Math.abs(t - 0.5) < 0.03)).toBe(true);
      expect(times.some((t) => Math.abs(t - 1.7) < 0.03)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "keeps the painted canvas when projection is off, with the same audio",
    async () => {
      const analysis = await addon.analyze([makeNoise()], 1, SR, PARAMS);
      const original = await roundTrip(analysis, analysis.data);
      const erased = erase(analysis);

      const run = (project: boolean) =>
        addon.commitStroke(
          erased,
          metaOf(analysis),
          SR,
          { ...PARAMS, detectOnsets: true },
          [original],
          fullWindow(analysis),
          gateStroke({ project }),
        );
      const projected = await run(true);
      const painted = await run(false);

      // No patch: the canvas keeps exactly what was painted.
      expect(painted.patch.ranges.length).toBe(0);
      expect(painted.patch.pixels.length).toBe(0);
      expect(projected.patch.ranges.length).toBeGreaterThan(0);

      // The projection only reads the audio, so skipping it changes nothing
      // the ear gets: same samples, same peak, same levels.
      let maxDiff = 0;
      for (let i = 0; i < N; i++)
        maxDiff = Math.max(maxDiff, Math.abs(painted.channels[0][i] - projected.channels[0][i]));
      expect(maxDiff).toBe(0);
      expect(painted.peak).toBe(projected.peak);

      // Onsets still run, reading the painted coefficients directly.
      expect(painted.onsets).toBeDefined();
    },
    TIMEOUT,
  );
});
