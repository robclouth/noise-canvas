import { describe, expect, it } from "vitest";

import {
  applyHistoryDelta,
  buildHistoryInverseMap,
  decodeHistorySnapshot,
  encodeHistoryDelta,
  encodeHistorySnapshot,
  historyFootprintChanged,
} from "../audio-analysis";

/**
 * The undo history's codec, as the addon implements it. Undo has to give back
 * the state that was painted, byte for byte — a magnitude that drifted by one
 * ulp per round-trip would audibly decay a state you visit repeatedly — so
 * these check bit patterns rather than float equality.
 */

// Bit patterns rather than values, so -0 vs 0 and NaN vs NaN are distinguished.
function bits(array: Float32Array): Uint32Array {
  return new Uint32Array(array.buffer, array.byteOffset, array.length);
}

// A packed state shaped like a real one: [magL, phaseL, magR, phaseR] per pixel,
// with small magnitudes and phase that accumulates across time. The values are
// irrational, so any arithmetic that rounds would show up in the bit patterns.
function packedState(pixels: number, salt: number): Float32Array {
  const out = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    out[p * 4] = Math.abs(Math.sin((p + salt) / 31)) * 0.01;
    out[p * 4 + 1] = (p + salt) * 0.37;
    out[p * 4 + 2] = Math.abs(Math.sin((p + salt) / 29)) * 0.01;
    out[p * 4 + 3] = (p + salt) * 0.36;
  }
  return out;
}

// Flat [pixelStart, pixelCount, ...] footprint, as the brush reports it.
function ranges(...pairs: Array<[number, number]>): Uint32Array {
  return new Uint32Array(pairs.flat());
}

describe("history snapshot codec", () => {
  it("round-trips a packed state bit-for-bit", async () => {
    const packed = packedState(4096, 3);
    const restored = await decodeHistorySnapshot(await encodeHistorySnapshot(packed));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(packed)));
  });

  it("keeps the values float32 alone would lose", async () => {
    const packed = new Float32Array([0, -0, NaN, Infinity, -Infinity, 1e-45, -1e-45, 3.4e38]);
    const restored = await decodeHistorySnapshot(await encodeHistorySnapshot(packed));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(packed)));
  });

  it("compresses better than the untransformed state would", async () => {
    // The reordering exists to make zstd effective on interleaved floats; if it
    // ever stopped helping, the whole transform would be dead weight.
    const { promisify } = await import("util");
    const { zstdCompress } = await import("zlib");
    const compress = promisify(zstdCompress);

    const packed = new Float32Array(64 * 1024);
    for (let p = 0; p < packed.length / 4; p++) {
      packed[p * 4] = Math.abs(Math.sin(p / 31)) * 0.01; // magL
      packed[p * 4 + 1] = p * 0.37; // phaseL, ramps like real unwrapped phase
      packed[p * 4 + 2] = Math.abs(Math.sin(p / 29)) * 0.01;
      packed[p * 4 + 3] = p * 0.36;
    }
    const plain = await compress(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength));
    const encoded = await encodeHistorySnapshot(packed);
    expect(encoded.byteLength).toBeLessThan(plain.byteLength);
  });

  it("handles an empty state", async () => {
    const restored = await decodeHistorySnapshot(await encodeHistorySnapshot(new Float32Array(0)));
    expect(restored.length).toBe(0);
  });

  it("refuses a state that is not whole RGBA pixels rather than truncating it", async () => {
    await expect(encodeHistorySnapshot(new Float32Array(6))).rejects.toThrow(/whole number of RGBA pixels/);
  });
});

describe("history stroke delta", () => {
  const PIXELS = 2048;

  it("reproduces the painted state exactly", async () => {
    const base = packedState(PIXELS, 0);
    const after = new Float32Array(base);
    for (let p = 100; p < 300; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = ((p * 7 + c) % 91) / 91;
    const rs = ranges([100, 200]);

    const restored = await applyHistoryDelta(base, await encodeHistoryDelta(base, after, rs));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(after)));
  });

  it("does not drift when the same delta is replayed", async () => {
    // Undo and redo replay a delta against the same base over and over; an
    // additive float delta would accumulate error on each pass.
    const base = packedState(PIXELS, 1);
    const after = new Float32Array(base);
    for (let p = 10; p < 50; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = ((p * 13 + c) % 83) / 83;
    const rs = ranges([10, 40]);
    const delta = await encodeHistoryDelta(base, after, rs);

    for (let i = 0; i < 5; i++) {
      const restored = await applyHistoryDelta(base, delta);
      expect(Array.from(bits(restored))).toEqual(Array.from(bits(after)));
    }
  });

  it("carries signed zeros, NaN and denormals through the footprint", async () => {
    const base = new Float32Array([0, -0, NaN, Infinity, 1e-45, -1e-45, 3.4e38, -3.4e38]);
    const after = new Float32Array([-0, 0, Infinity, NaN, -3.4e38, 3.4e38, -1e-45, 1e-45]);
    const restored = await applyHistoryDelta(base, await encodeHistoryDelta(base, after, ranges([0, 2])));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(after)));
  });

  it("leaves everything outside the footprint alone", async () => {
    const base = packedState(PIXELS, 2);
    const after = new Float32Array(base);
    after[500 * 4] = 42;
    // A footprint that does not cover pixel 500: the change is not recorded.
    const restored = await applyHistoryDelta(base, await encodeHistoryDelta(base, after, ranges([0, 100])));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(base)));
  });

  it("spans several disjoint ranges, one per band", async () => {
    const base = packedState(PIXELS, 4);
    const after = new Float32Array(base);
    const rs = ranges([3, 2], [40, 5], [1000, 17]);
    for (let r = 0; r < rs.length; r += 2)
      for (let p = rs[r]; p < rs[r] + rs[r + 1]; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = (p * 4 + c) / 7;

    const restored = await applyHistoryDelta(base, await encodeHistoryDelta(base, after, rs));
    expect(Array.from(bits(restored))).toEqual(Array.from(bits(after)));
  });

  it("refuses a footprint that runs past the end of the state", async () => {
    const base = packedState(64, 3);
    await expect(encodeHistoryDelta(base, new Float32Array(base), ranges([60, 10]))).rejects.toThrow(/past the end/);
  });

  it("is far smaller when the stroke barely changed the footprint", async () => {
    // Untouched pixels encode as zeros, which is what makes a stroke cheap to
    // store even when its footprint covers much of the texture.
    const base = packedState(PIXELS, 5);
    const rs = ranges([0, PIXELS]);

    const touched = new Float32Array(base);
    touched[7] += 0.5;
    const barely = await encodeHistoryDelta(base, touched, rs);

    const rewritten = packedState(PIXELS, 6);
    const wholesale = await encodeHistoryDelta(base, rewritten, rs);

    expect(barely.byteLength).toBeLessThan(wholesale.byteLength / 10);
    // And a rewrite of the same footprint still beats storing it outright.
    expect(wholesale.byteLength).toBeLessThan(PIXELS * 16);
  });
});

describe("historyFootprintChanged", () => {
  it("is false when the stroke changed nothing it covered", async () => {
    const base = packedState(512, 7);
    expect(await historyFootprintChanged(base, new Float32Array(base), ranges([0, 512]))).toBe(false);
  });

  it("is true when any channel inside the footprint differs", async () => {
    const base = packedState(512, 8);
    const after = new Float32Array(base);
    after[5 * 4 + 3] = 9;
    expect(await historyFootprintChanged(base, after, ranges([4, 4]))).toBe(true);
  });

  it("ignores changes outside the footprint", async () => {
    const base = packedState(512, 9);
    const after = new Float32Array(base);
    after[20 * 4] = 1;
    expect(await historyFootprintChanged(base, after, ranges([0, 8]))).toBe(false);
  });
});

describe("buildHistoryInverseMap", () => {
  it("gives each pixel its time offset within the band and its band index", async () => {
    // Two bands: the first at full rate, the second at half rate behind it.
    const inverseMap = await buildHistoryInverseMap(
      new Uint32Array([0, 4]),
      new Uint32Array([4, 2]),
      new Int32Array([0, 1]),
      8,
    );
    expect(Array.from(inverseMap.subarray(0, 8))).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
    expect(Array.from(inverseMap.subarray(8, 12))).toEqual([0, 1, 2, 1]);
  });

  it("covers the whole padded texture, leaving unused pixels zeroed", async () => {
    const inverseMap = await buildHistoryInverseMap(new Uint32Array([0]), new Uint32Array([2]), new Int32Array([0]), 8);
    expect(inverseMap.length).toBe(16);
    expect(Array.from(inverseMap.subarray(4))).toEqual(new Array(12).fill(0));
  });
});
