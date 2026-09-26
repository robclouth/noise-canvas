import { describe, expect, it } from "vitest";
import {
  copyTapsFromCompact,
  float32BitsEqual,
  gatherPixelRanges,
  gatherTaps,
  mergePixelRanges,
  pixelRangePieces,
  scatterPixelRanges,
  subtractPixelRanges,
  tapCount,
  tapSpanRanges,
} from "../pixel-ranges";

describe("subtractPixelRanges", () => {
  it("cuts a hole out of a range", () => {
    expect(Array.from(subtractPixelRanges(new Uint32Array([0, 100]), new Uint32Array([10, 10])))).toEqual([
      0, 10, 20, 80,
    ]);
  });

  it("drops a range the cut covers entirely", () => {
    expect(Array.from(subtractPixelRanges(new Uint32Array([10, 5]), new Uint32Array([0, 100])))).toEqual([]);
  });

  it("keeps a range the cut only touches at its edges", () => {
    expect(Array.from(subtractPixelRanges(new Uint32Array([10, 10]), new Uint32Array([0, 10, 20, 10])))).toEqual([
      10, 10,
    ]);
  });

  it("applies every cut to every range that follows", () => {
    const kept = subtractPixelRanges(new Uint32Array([0, 10, 20, 10]), new Uint32Array([5, 20]));
    expect(Array.from(kept)).toEqual([0, 5, 25, 5]);
  });

  it("leaves the newer stroke's pixels behind when an older patch folds in", () => {
    const canvas = Float32Array.from({ length: 8 * 4 }, () => 2);
    const older = Float32Array.from({ length: 8 * 4 }, () => 1);
    // The older patch covers pixels 0-5; the newer stroke painted pixels 3-5.
    const kept = subtractPixelRanges(new Uint32Array([0, 6]), new Uint32Array([3, 3]));
    scatterPixelRanges(canvas, older, kept);

    expect(Array.from({ length: 8 }, (_, p) => canvas[p * 4])).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
  });
});

describe("scatterPixelRanges", () => {
  it("copies only the ranges' pixels, four floats each", () => {
    const dest = new Float32Array(6 * 4);
    const src = Float32Array.from({ length: 6 * 4 }, (_, i) => i + 1);
    scatterPixelRanges(dest, src, new Uint32Array([1, 2, 4, 1]));

    for (let p = 0; p < 6; p++) {
      const expected = p === 1 || p === 2 || p === 4 ? src[p * 4] : 0;
      expect(dest[p * 4]).toBe(expected);
    }
  });

  it("clips a range that runs past the buffers", () => {
    const dest = new Float32Array(3 * 4);
    const src = Float32Array.from({ length: 5 * 4 }, (_, i) => i + 1);
    scatterPixelRanges(dest, src, new Uint32Array([2, 3]));
    expect(dest[2 * 4]).toBe(src[2 * 4]);
    expect(dest.length).toBe(3 * 4);
  });

  it("round-trips with mergePixelRanges output", () => {
    const dest = new Float32Array(8 * 4);
    const src = Float32Array.from({ length: 8 * 4 }, (_, i) => i + 1);
    const merged = mergePixelRanges(new Uint32Array([0, 2]), new Uint32Array([1, 3]));
    expect(Array.from(merged)).toEqual([0, 4]);
    scatterPixelRanges(dest, src, merged);
    expect(dest[3 * 4]).toBe(src[3 * 4]);
    expect(dest[4 * 4]).toBe(0);
  });
});

describe("float32BitsEqual", () => {
  it("matches on bit patterns, NaN included, and tells signed zeros apart", () => {
    expect(float32BitsEqual(Float32Array.from([1, NaN, 0]), Float32Array.from([1, NaN, 0]))).toBe(true);
    expect(float32BitsEqual(Float32Array.from([0]), Float32Array.from([-0]))).toBe(false);
    expect(float32BitsEqual(Float32Array.from([1, 2]), Float32Array.from([1, 3]))).toBe(false);
    expect(float32BitsEqual(Float32Array.from([1]), Float32Array.from([1, 1]))).toBe(false);
  });
});

describe("taps", () => {
  // A packed array whose every float is its own index, so a wrong pixel shows.
  const packed = Float32Array.from({ length: 4000 * 4 }, (_, i) => i);
  // Two runs in different bands: one at stride 8, one at stride 3.
  const runs = Uint32Array.of(100, 50, 8, 1500, 20, 3);

  it("counts the taps and spans the pixels they stride over", () => {
    expect(tapCount(runs)).toBe(70);
    expect(Array.from(tapSpanRanges(runs))).toEqual([100, 49 * 8 + 1, 1500, 19 * 3 + 1]);
    expect(Array.from(tapSpanRanges(Uint32Array.of(7, 0, 4)))).toEqual([7, 0]);
  });

  it("gathers the left and right magnitudes at each tap", () => {
    const taps = gatherTaps(packed, runs);
    expect(taps.length).toBe(140);
    expect(taps[0]).toBe(100 * 4);
    expect(taps[1]).toBe(100 * 4 + 2);
    expect(taps[2]).toBe(108 * 4);
    expect(taps[100]).toBe(1500 * 4);
    expect(taps[139]).toBe((1500 + 19 * 3) * 4 + 2);
  });

  it("picks the taps out of compact pieces the same as out of the whole", () => {
    // Pieces that split both runs, with gaps the taps must skip.
    const pieces = Uint32Array.of(0, 250, 300, 200, 1490, 30, 1540, 40);
    const compact = gatherPixelRanges(packed, pieces);
    const out = new Float32Array(tapCount(runs) * 2).fill(-1);
    copyTapsFromCompact(out, runs, compact, pieces);
    const whole = gatherTaps(packed, runs);
    for (let i = 0; i < out.length; i++) {
      const pixel = i < 100 ? 100 + Math.floor(i / 2) * 8 : 1500 + Math.floor((i - 100) / 2) * 3;
      const held =
        (pixel >= 0 && pixel < 250) ||
        (pixel >= 300 && pixel < 500) ||
        (pixel >= 1490 && pixel < 1520) ||
        (pixel >= 1540 && pixel < 1580);
      expect(out[i]).toBe(held ? whole[i] : -1);
    }
    expect(float32BitsEqual(out, whole)).toBe(false);
    const rest = new Float32Array(out);
    copyTapsFromCompact(
      rest,
      runs,
      gatherPixelRanges(packed, Uint32Array.of(250, 50, 500, 1000, 1520, 20)),
      Uint32Array.of(250, 50, 500, 1000, 1520, 20),
    );
    expect(float32BitsEqual(rest, whole)).toBe(true);
  });
});

describe("pixelRangePieces", () => {
  it("cuts ranges into pieces that gather, end to end, what the whole list gathers", () => {
    const ranges = Uint32Array.of(3, 5, 10, 12, 30, 1, 40, 7);
    const src = Float32Array.from({ length: 50 * 4 }, (_, i) => i);
    const whole = gatherPixelRanges(src, ranges);
    const pieces = pixelRangePieces(ranges, 6);
    expect(pieces.map((piece) => Array.from(piece.ranges))).toEqual([
      [3, 5, 10, 1],
      [11, 6],
      [17, 5, 30, 1],
      [40, 6],
      [40 + 6, 1],
    ]);
    for (const piece of pieces) {
      const part = gatherPixelRanges(src, piece.ranges);
      expect(Array.from(whole.subarray(piece.at, piece.at + part.length))).toEqual(Array.from(part));
    }
  });
});
