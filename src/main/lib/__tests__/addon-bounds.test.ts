import { describe, expect, it } from "vitest";

import { analyseChannels, historyFootprintChanged, hpss, mergeSpectrograms, nmf, synthesize } from "../audio-analysis";

/**
 * The addon indexes the band tables and the caller's audio buffers from what the
 * JS side declares about them. These check that a declaration the buffers cannot
 * satisfy rejects the promise instead of reading off the end on a worker thread.
 */

const SAMPLE_RATE = 48000;
const NUM_BANDS = 4;
const PIXELS_PER_BAND = 8;

function bandLayout() {
  const bandOffsets = new Uint32Array(NUM_BANDS);
  const bandLengths = new Uint32Array(NUM_BANDS);
  const bandStepLog2s = new Int32Array(NUM_BANDS);
  for (let b = 0; b < NUM_BANDS; b++) {
    bandOffsets[b] = b * PIXELS_PER_BAND;
    bandLengths[b] = PIXELS_PER_BAND;
  }
  return { bandOffsets, bandLengths, bandStepLog2s };
}

function packed(): Float32Array {
  return new Float32Array(NUM_BANDS * PIXELS_PER_BAND * 4);
}

function meta(overrides: Partial<{ numBands: number; numChannels: number }> = {}) {
  const { bandOffsets, bandLengths } = bandLayout();
  return { numBands: NUM_BANDS, numChannels: 1, bandOffsets, bandLengths, ...overrides };
}

describe("coefficient workers reject a band layout the buffer cannot hold", () => {
  it("rejects hpss when the tables run past the packed buffer", async () => {
    const { bandOffsets, bandLengths } = bandLayout();
    bandLengths[NUM_BANDS - 1] = PIXELS_PER_BAND * 100;
    await expect(hpss(packed(), { ...meta(), bandOffsets, bandLengths }, 3, 3)).rejects.toThrow(/past the end/);
  });

  it("rejects hpss when the tables are shorter than numBands", async () => {
    await expect(hpss(packed(), { ...meta(), numBands: NUM_BANDS + 4 }, 3, 3)).rejects.toThrow(/shorter than numBands/);
  });

  it("rejects nmf when the tables run past the packed buffer", async () => {
    const { bandOffsets, bandLengths } = bandLayout();
    bandOffsets[0] = 1 << 20;
    await expect(nmf(packed(), { ...meta(), bandOffsets, bandLengths }, 2, 2, 1)).rejects.toThrow(/past the end/);
  });

  it("rejects a merge whose tables run past the inputs", async () => {
    const { bandOffsets, bandLengths } = bandLayout();
    bandLengths[0] = PIXELS_PER_BAND * 100;
    await expect(mergeSpectrograms([packed(), packed()], { ...meta(), bandOffsets, bandLengths })).rejects.toThrow(
      /past the end/,
    );
  });

  it("accepts a layout that fits", async () => {
    const result = await hpss(packed(), meta(), 3, 3);
    expect(result.harmonic.length).toBe(packed().length);
  });
});

describe("synthesis rejects existing audio that does not match the analysis", () => {
  const numFrames = 512;

  function analysisMetadata(numChannels: number) {
    const { bandOffsets, bandLengths, bandStepLog2s } = bandLayout();
    return { numFrames, numChannels, numBands: NUM_BANDS, bandOffsets, bandLengths, bandStepLog2s };
  }

  it("rejects when there are fewer existing channels than the analysis declares", async () => {
    await expect(
      synthesize(
        packed(),
        analysisMetadata(2),
        SAMPLE_RATE,
        { bandsPerOctave: 12, minFreq: 20 },
        false,
        [new Float32Array(numFrames)],
        0,
        128,
      ),
    ).rejects.toThrow(/channel count/);
  });

  it("rejects when an existing channel is shorter than numFrames", async () => {
    await expect(
      synthesize(
        packed(),
        analysisMetadata(1),
        SAMPLE_RATE,
        { bandsPerOctave: 12, minFreq: 20 },
        false,
        [new Float32Array(numFrames - 1)],
        0,
        128,
      ),
    ).rejects.toThrow(/shorter than numFrames/);
  });

  it("rejects when the band tables run past the packed buffer", async () => {
    const md = analysisMetadata(1);
    md.bandLengths[0] = PIXELS_PER_BAND * 100;
    await expect(synthesize(packed(), md, SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 20 }, false)).rejects.toThrow(
      /past the end/,
    );
  });
});

describe("analysis with uneven channel lengths", () => {
  it("reads no further than the shortest channel", async () => {
    const long = new Float32Array(4096);
    const short = new Float32Array(1024);
    for (let i = 0; i < long.length; i++) long[i] = Math.sin(i / 8) * 0.5;
    for (let i = 0; i < short.length; i++) short[i] = Math.sin(i / 8) * 0.5;

    const result = await analyseChannels([long, short], SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 40 });
    expect(result.numFrames).toBe(short.length);
  });
});

describe("history footprint comparison", () => {
  it("rejects a range that runs past the end of the state", async () => {
    const base = new Float32Array(64);
    const after = new Float32Array(64);
    await expect(historyFootprintChanged(base, after, new Uint32Array([0, 1000]))).rejects.toThrow(/past the end/);
  });

  it("rejects states of different sizes", async () => {
    await expect(
      historyFootprintChanged(new Float32Array(64), new Float32Array(32), new Uint32Array([0, 4])),
    ).rejects.toThrow(/different size/);
  });

  it("still reports a change inside a range that fits", async () => {
    const base = new Float32Array(64);
    const after = new Float32Array(64);
    after[5] = 1;
    expect(await historyFootprintChanged(base, after, new Uint32Array([0, 16]))).toBe(true);
    expect(await historyFootprintChanged(base, base, new Uint32Array([0, 16]))).toBe(false);
  });
});
