import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatherPixelRanges } from "../../../renderer/src/lib/pixel-ranges";
import { scanOnsets, type DetectRegional, type OnsetDetection } from "../onset-scan";
import type { GaboratorAnalysisResult, PackedLayout } from "../types";

// Onsets can be found a chunk of the file at a time, each pass reading only its
// own span of coefficients through a view. The gate is a share of the loudest
// moment of the detection function anywhere in the file, so the chunks are read
// twice: once for that moment, once to judge every event against it. What comes
// out has to be what one pass over the whole file gives.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
  detectOnsets: (
    packedData: Float32Array,
    meta: PackedLayout,
    sampleRate: number,
    options?: unknown,
  ) => Promise<OnsetDetection>;
};

const SAMPLE_RATE = 44100;

/** A hit at a time in seconds, at an amplitude. */
type Hit = [number, number];

/** Hits over a tonal bed that fades away, so the chunks differ from each other and from the file. */
function hits(seconds: number, times: Hit[]): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    data[i] = 0.05 * Math.exp(-0.5 * t) * Math.sin(2 * Math.PI * 520 * t);
  }
  for (const [at, level] of times) {
    const start = Math.round(at * SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE * 0.2 && start + i < data.length; i++) {
      const t = i / SAMPLE_RATE;
      data[start + i] += level * Math.exp(-24 * t) * Math.sin(2 * Math.PI * 1240 * t);
    }
  }
  return data;
}

/** A hit whose power keeps rising for `rise` seconds after it starts. */
function swell(data: Float32Array, at: number, level: number, rise: number): void {
  const start = Math.round(at * SAMPLE_RATE);
  for (let i = 0; i < SAMPLE_RATE * (rise + 0.1) && start + i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    const shape = t < rise ? t / rise : Math.exp(-30 * (t - rise));
    data[start + i] += level * shape * Math.sin(2 * Math.PI * 1240 * t);
  }
}

// Loud at the head, thirty decibels down by the tail, with a pair either side
// of the three-second mark.
const HITS: Hit[] = [
  [0.4, 0.9],
  [1.9, 0.7],
  [2.94, 0.5],
  [3.06, 0.45],
  [4.1, 0.2],
  [5.6, 0.12],
  [6.02, 0.1],
  [7.8, 0.04],
  [9.3, 0.03],
  [10.2, 0.028],
  [11.1, 0.025],
];

const COARSE = { bandsPerOctave: 24, minFreq: 40 };
// A layout whose slowest band deposits a coefficient every twelve milliseconds,
// so rounding a chunk's edges onto the band grid gives it no reach of its own.
const FINE = { bandsPerOctave: 24, minFreq: 400 };

function layoutOf(result: GaboratorAnalysisResult): PackedLayout {
  return {
    numFrames: result.numFrames,
    numChannels: result.numChannels,
    numBands: result.numBands,
    bandOffsets: result.bandOffsets,
    bandStepLog2s: result.bandStepLog2s,
    bandLengths: result.bandLengths,
  };
}

const detect: DetectRegional = (packed, meta, sampleRate, options) =>
  addon.detectOnsets(packed, meta, sampleRate, options);

async function analysed(seconds: number, times: Hit[], params = COARSE) {
  const result = await addon.analyze([hits(seconds, times)], 1, SAMPLE_RATE, params);
  const layout = layoutOf(result);
  const whole = await addon.detectOnsets(result.data, layout, SAMPLE_RATE);
  const read = async (ranges: Uint32Array) => gatherPixelRanges(result.data, ranges);
  return { result, layout, whole, read };
}

/** Four loud hits, then thirty-two seconds of near-silent noise. */
async function analysedTail() {
  const seconds = 40;
  const data = hits(8, [
    [0.5, 0.95],
    [2.1, 0.9],
    [4.4, 0.8],
    [6.7, 0.85],
  ]);
  const channel = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  channel.set(data);
  let noise = 12345;
  for (let i = data.length; i < channel.length; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    channel[i] = (noise / 0x7fffffff - 0.5) * 2e-4;
  }
  const result = await addon.analyze([channel], 1, SAMPLE_RATE, COARSE);
  const layout = layoutOf(result);
  const whole = await addon.detectOnsets(result.data, layout, SAMPLE_RATE);
  const read = async (ranges: Uint32Array) => gatherPixelRanges(result.data, ranges);
  return { result, layout, whole, read };
}

/**
 * Loud low hits at the head, then a pair of bright ones far later over noise:
 * the top bands' loudest moment is nowhere near the loudest chunk, so a chunk
 * judging those bands by its own span whitens its noise up to full.
 */
async function analysedLateBright() {
  const seconds = 24;
  const channel = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let noise = 987654321;
  for (let i = 0; i < channel.length; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    channel[i] = (noise / 0x7fffffff - 0.5) * 4e-4;
  }
  for (const at of [0.4, 1.3, 2.2]) {
    const start = Math.round(at * SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE * 0.3 && start + i < channel.length; i++) {
      const t = i / SAMPLE_RATE;
      channel[start + i] += 0.95 * Math.exp(-14 * t) * Math.sin(2 * Math.PI * 90 * t);
    }
  }
  for (const at of [15.4, 18.9]) {
    const start = Math.round(at * SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE * 0.05 && start + i < channel.length; i++) {
      const t = i / SAMPLE_RATE;
      channel[start + i] += 0.6 * Math.exp(-90 * t) * Math.sin(2 * Math.PI * 9000 * t);
    }
  }
  const result = await addon.analyze([channel], 1, SAMPLE_RATE, COARSE);
  const layout = layoutOf(result);
  const whole = await addon.detectOnsets(result.data, layout, SAMPLE_RATE);
  const read = async (ranges: Uint32Array) => gatherPixelRanges(result.data, ranges);
  return { result, layout, whole, read };
}

/** Onsets as [time, salience] pairs, for reporting a mismatch legibly. */
function pairs(flat: Float32Array): Hit[] {
  const out: Hit[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function expectSameEvents(scanned: Float32Array, whole: Float32Array): void {
  const a = pairs(whole);
  const b = pairs(scanned);
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) {
    expect(b[i][0], `event ${i} time`).toBeCloseTo(a[i][0], 3);
    expect(b[i][1], `event ${i} salience`).toBeCloseTo(a[i][1], 4);
  }
}

function texelsOf(layout: PackedLayout): number {
  let texels = 0;
  for (let b = 0; b < layout.numBands; b++) texels += layout.bandLengths[b];
  return texels;
}

describe("onsets found a chunk at a time", () => {
  it("reports the events a whole-file pass reports", async () => {
    const { layout, whole, read } = await analysed(12, HITS);
    const scanned = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 3);

    expect(pairs(scanned.onsets).length).toBeGreaterThanOrEqual(HITS.length);
    expectSameEvents(scanned.onsets, whole.onsets);
  });

  it("arrives at the whole file's gate", async () => {
    const { layout, whole, read } = await analysed(12, HITS);
    const scanned = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 2);
    expect(scanned.odfMax).toBeCloseTo(whole.odfMax, 6);
  });

  it("gives the same events however the file is cut", async () => {
    const { layout, whole, read } = await analysed(12, HITS);
    const coarse = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 5);
    const fine = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 1.5);
    expect(pairs(fine.onsets)).toEqual(pairs(coarse.onsets));
  });

  it("reads far enough past a chunk to measure the last event in it", async () => {
    // An event's level is the power that arrives with it, looked for over the
    // moment after it, so an event that swells across a chunk edge is measured
    // short unless the pass reads past its own span. The layout is fine enough
    // that rounding the edge onto the band grid gives it no reach of its own.
    const channel = hits(6, [
      [0.7, 0.8],
      [4.3, 0.5],
    ]);
    swell(channel, 1.9, 0.8, 0.13);
    swell(channel, 3.9, 0.6, 0.13);
    const result = await addon.analyze([channel], 1, SAMPLE_RATE, FINE);
    const layout = layoutOf(result);
    const whole = await addon.detectOnsets(result.data, layout, SAMPLE_RATE);
    const read = async (ranges: Uint32Array) => gatherPixelRanges(result.data, ranges);

    let coarsest = 0;
    for (let b = 0; b < layout.numBands; b++) coarsest = Math.max(coarsest, layout.bandStepLog2s[b]);
    expect(2 ** coarsest / SAMPLE_RATE).toBeLessThan(0.02);

    const scanned = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 2);
    expectSameEvents(scanned.onsets, whole.onsets);
  });

  it("keeps the file's own terms over a chunk that holds nothing", async () => {
    // The tail is near silence. Judged by what that chunk alone holds, its
    // noise is the loudest thing in it and reads as a run of events.
    const { layout, whole, read } = await analysedTail();

    const scanned = await scanOnsets(detect, read, layout, SAMPLE_RATE, whole.bandMax, 4);
    // Detection is permissive by design, so the noise gives events of its own;
    // what matters is that a chunk reports the ones the whole file reports.
    expect(pairs(whole.onsets).filter(([at]) => at > 12).length).toBeGreaterThan(20);
    expectSameEvents(scanned.onsets, whole.onsets);
  });

  it("works the band maxima out for itself when it is given none", async () => {
    // Each band's loudest moment is the file's, and the whitening reads it. A
    // caller with none to hand — a file whose reference was lost — must still
    // arrive at the events the whole-file pass reports, not at the ones each
    // chunk would report judged against itself. The near-silent tail is where
    // those two answers part, and so is a file whose top bands peak far from
    // its loudest chunk.
    for (const material of [await analysed(12, HITS), await analysedTail(), await analysedLateBright()]) {
      const { layout, whole, read } = material;
      const scanned = await scanOnsets(detect, read, layout, SAMPLE_RATE, new Float32Array(0), 3);

      expect(scanned.bandMax.length).toBe(layout.numBands);
      for (let b = 0; b < layout.numBands; b++) {
        expect(scanned.bandMax[b], `band ${b}`).toBeCloseTo(whole.bandMax[b], 5);
      }
      expectSameEvents(scanned.onsets, whole.onsets);
    }
  });

  it("walks each round the other way from the round before", async () => {
    const { layout, whole, read } = await analysed(12, HITS);
    const starts: number[] = [];
    const watched = async (ranges: Uint32Array) => {
      starts.push(ranges[0]);
      return await read(ranges);
    };
    const scanned = await scanOnsets(detect, watched, layout, SAMPLE_RATE, new Float32Array(0), 3);
    const rounds = 3;
    const perRound = starts.length / rounds;
    expect(Number.isInteger(perRound)).toBe(true);
    for (let r = 0; r < rounds; r++) {
      const walk = starts.slice(r * perRound, (r + 1) * perRound);
      const sorted = [...walk].sort((a, b) => a - b);
      const expected = r % 2 === 0 ? sorted.reverse() : sorted;
      expect(walk, `round ${r}`).toEqual(expected);
    }
    expectSameEvents(scanned.onsets, whole.onsets);
  });

  it("never reads the whole run at once", async () => {
    const { layout, whole, read } = await analysed(12, HITS);
    let widest = 0;
    const watched = async (ranges: Uint32Array) => {
      let texels = 0;
      for (let i = 1; i < ranges.length; i += 2) texels += ranges[i];
      widest = Math.max(widest, texels);
      return await read(ranges);
    };
    await scanOnsets(detect, watched, layout, SAMPLE_RATE, whole.bandMax, 2);
    // Two seconds reported on plus the warm-up either side, against twelve.
    expect(widest).toBeLessThan(0.9 * texelsOf(layout));
  });
});
