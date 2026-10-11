import { describe, expect, it } from "vitest";
import {
  normaliseRaw,
  RAW_NOISE_BLOCK,
  RAW_RATE,
  rawBlockFlatness,
  rawOutputFrames,
  readRawSamples,
  removeRawDc,
  removeRawNoise,
  type RawOpenOptions,
} from "../raw-file";

const options = (patch: Partial<RawOpenOptions> = {}): RawOpenOptions => ({
  length: 0,
  format: "u8",
  stereo: "mono",
  read: "plain",
  holdLength: 64,
  speed: 1,
  removeNoise: 0,
  ...patch,
});

const read = (bytes: number[], patch: Partial<RawOpenOptions> = {}) =>
  readRawSamples(Uint8Array.from(bytes), options({ length: bytes.length, ...patch }));

/** A seeded run of bytes that sounds like hiss. */
function noiseBytes(count: number): number[] {
  let state = 12345;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 24;
  });
}

const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length);

describe("Open Raw formats", () => {
  it("reads each format's bytes as full-scale samples", () => {
    expect(Array.from(read([0, 128, 255])[0])).toEqual([-1, 0, 127 / 128]);
    expect(Array.from(read([0x80, 0, 0x7f], { format: "s8" })[0])).toEqual([-1, 0, 127 / 128]);
    expect(Array.from(read([0x00, 0x80, 0xff, 0x7f], { format: "s16le" })[0])).toEqual([-1, 32767 / 32768]);
    expect(Array.from(read([0x80, 0x00, 0x7f, 0xff], { format: "s16be" })[0])).toEqual([-1, 32767 / 32768]);
    expect(Array.from(read([0x7f, 0x80, 0x0f], { format: "topBit" })[0])).toEqual([-1, 1, -1]);
  });

  it("reads μ-law bytes on the telephone curve: loudest at the ends, silent at 0xFF", () => {
    const [x] = read([0x00, 0x80, 0xff, 0x7f], { format: "mulaw" });
    expect(x[0]).toBeCloseTo(-32124 / 32768, 6);
    expect(x[1]).toBeCloseTo(32124 / 32768, 6);
    expect(x[2]).toBe(0);
    expect(x[3]).toBe(0);
  });
});

describe("Open Raw stereo", () => {
  it("makes one channel in Mono and two in every other mode", () => {
    expect(read([1, 2, 3, 4])).toHaveLength(1);
    for (const stereo of ["separate", "pan", "split"] as const) expect(read([1, 2, 3, 4], { stereo })).toHaveLength(2);
  });

  it("reads a sample for each channel in Separate and drops a part frame at the end", () => {
    const [left, right] = read([0, 255, 128, 64, 1], { stereo: "separate" });
    expect(Array.from(left)).toEqual([-1, 0]);
    expect(Array.from(right)).toEqual([127 / 128, -0.5]);
  });

  it("places each sample by a byte of its own in Pan, at equal power", () => {
    const [left, right] = read([200, 255, 255, 0, 0, 200], { stereo: "pan" });
    expect(left).toHaveLength(3);
    expect(left[0]).toBeCloseTo(0, 6);
    expect(right[0]).toBeCloseTo(72 / 128, 6);
    expect(left[1]).toBeCloseTo(127 / 128, 6);
    expect(right[1]).toBeCloseTo(0, 6);
    const angle = (200 / 255) * (Math.PI / 2);
    expect(left[2] ** 2 + right[2] ** 2).toBeCloseTo(1, 6);
    expect(right[2] / left[2]).toBeCloseTo(Math.tan(angle), 5);
  });

  it("pans a Hold step by its own byte, not by its length", () => {
    const steps = [200, 0, 255, 10, 255, 0];
    const [left, right] = read([...steps, ...new Array(200).fill(0)], { stereo: "pan", read: "hold", holdLength: 64 });
    for (let k = 0; k < 64; k++) {
      expect(left[k]).toBeCloseTo(72 / 128, 6);
      expect(right[k]).toBeCloseTo(0, 6);
    }
    expect(left[64]).toBeCloseTo(0, 6);
    expect(right[64]).toBeCloseTo(-118 / 128, 6);
  });

  it("plays the top half of each sample's bits left and the bottom half right in Split", () => {
    const [left, right] = read([0xf0, 0x8f], { stereo: "split" });
    expect(left[0]).toBe(1);
    expect(left[1]).toBeCloseTo((8 - 7.5) / 7.5, 6);
    expect(Array.from(right)).toEqual([-1, 1]);
    const [high, low] = read([0x34, 0x12], { stereo: "split", format: "s16le" });
    expect(high[0]).toBeCloseTo((0x12 - 127.5) / 127.5, 6);
    expect(low[0]).toBeCloseTo((0x34 - 127.5) / 127.5, 6);
  });

  it("sums both channels in Delta, and only the sample in Pan", () => {
    const bytes = [130, 120, 200, 0, 255, 128];
    const [left, right] = read(bytes, { stereo: "split" });
    const [sumLeft, sumRight] = read(bytes, { stereo: "split", read: "delta" });
    expect(sumLeft[1]).toBeCloseTo(left[0] * 0.9995 + left[1], 6);
    expect(sumRight[1]).toBeCloseTo(right[0] * 0.9995 + right[1], 6);
    const [panLeft, panRight] = read([255, 0, 0, 255], { stereo: "pan", read: "delta" });
    expect(panRight[0]).toBeCloseTo(0, 6);
    expect(panLeft[1]).toBeCloseTo(0, 6);
    expect(panRight[1]).toBeCloseTo((127 / 128) * 0.9995 - 1, 6);
  });
});

describe("Open Raw reads", () => {
  it("keeps a slowly leaking running sum in Delta", () => {
    const bytes = [130, 120, 200, 0, 255, 128];
    const [plain] = read(bytes);
    const [sum] = read(bytes, { read: "delta" });
    expect(sum[0]).toBeCloseTo(plain[0], 6);
    for (let k = 1; k < bytes.length; k++) expect(sum[k]).toBeCloseTo(sum[k - 1] * 0.9995 + plain[k], 6);
  });

  it("holds each sample for as long as the byte after it says, up to Hold Length", () => {
    const bytes = [200, 0, 10, 255, 60, 128, 0, 0];
    const [x] = read([...bytes, ...new Array(200).fill(0)], { read: "hold", holdLength: 64 });
    const runs: [number, number][] = [];
    for (const v of x.subarray(0, 1 + 64 + 33)) {
      if (runs.length && runs[runs.length - 1][0] === v) runs[runs.length - 1][1]++;
      else runs.push([v, 1]);
    }
    expect(runs).toEqual([
      [72 / 128, 1],
      [-118 / 128, 64],
      [-68 / 128, 33],
    ]);
  });

  it("repeats samples below 1× and skips them above, with the length following Speed", () => {
    const bytes = [0, 64, 128, 192];
    expect(Array.from(read(bytes, { speed: 0.5 })[0])).toEqual([-1, -1, -0.5, -0.5, 0, 0, 0.5, 0.5]);
    expect(Array.from(read(bytes, { speed: 2 })[0])).toEqual([-1, 0]);
    expect(rawOutputFrames(options({ length: 4800, speed: 0.25 }))).toBe(19200);
    expect(rawOutputFrames(options({ length: 4800, format: "s16le", stereo: "separate", speed: 3 }))).toBe(400);
  });

  it("lasts as long as the bytes played in order, whatever the Read", () => {
    const bytes = noiseBytes(3000);
    for (const mode of ["plain", "delta", "hold"] as const) {
      expect(read(bytes, { read: mode, speed: 0.75 })[0].length).toBe(4000);
    }
  });
});

describe("Open Raw clean-up", () => {
  it("takes out a DC offset", () => {
    const x = new Float32Array(RAW_RATE).fill(0.5);
    removeRawDc([x]);
    expect(Math.abs(x[x.length - 1])).toBeLessThan(0.01);
  });

  it("silences hiss and keeps a tone", () => {
    const noise = read(noiseBytes(RAW_NOISE_BLOCK * 8))[0];
    const tone = Float32Array.from({ length: RAW_NOISE_BLOCK * 8 }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / RAW_RATE),
    );
    const mixed = new Float32Array(RAW_NOISE_BLOCK * 16);
    mixed.set(noise, 0);
    mixed.set(tone, RAW_NOISE_BLOCK * 8);
    const flatness = rawBlockFlatness([mixed]);
    expect(Math.min(...flatness.slice(0, 8))).toBeGreaterThan(0.4);
    expect(Math.max(...flatness.slice(8))).toBeLessThan(0.1);

    const kept = removeRawNoise([mixed], 0.7);
    expect(kept).toBe(0.5);
    expect(Math.max(...mixed.subarray(RAW_NOISE_BLOCK, RAW_NOISE_BLOCK * 7).map(Math.abs))).toBe(0);
    expect(rmsDb(mixed.subarray(RAW_NOISE_BLOCK * 9))).toBeCloseTo(rmsDb(tone.subarray(RAW_NOISE_BLOCK)), 1);
  });

  it("keeps more at a lower strength", () => {
    const bytes = noiseBytes(RAW_NOISE_BLOCK * 32).map((b, i) => (i % 3 === 0 ? b : b >> 1));
    const keptAt = (strength: number) => removeRawNoise(read(bytes), strength);
    expect(keptAt(0.05)).toBeGreaterThanOrEqual(keptAt(0.5));
    expect(keptAt(0.5)).toBeGreaterThanOrEqual(keptAt(1));
  });

  it("brings any result to the same loudness, and reports silence", () => {
    const quiet = Float32Array.from({ length: RAW_RATE }, (_, i) => 0.01 * Math.sin(i / 7));
    expect(normaliseRaw([quiet])).toBe(true);
    expect(rmsDb(quiet)).toBeCloseTo(-16, 1);
    expect(normaliseRaw([new Float32Array(100)])).toBe(false);
  });

  it("lifts a sparse result only until its peak sits 6 dB over full scale", () => {
    const sparse = new Float32Array(RAW_RATE);
    sparse[100] = 0.001;
    normaliseRaw([sparse]);
    expect(20 * Math.log10(sparse[100])).toBeCloseTo(6, 3);
  });
});
