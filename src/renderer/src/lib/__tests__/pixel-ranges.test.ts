import { describe, expect, it } from "vitest";
import { mergePixelRanges, scatterPixelRanges, subtractPixelRanges } from "../pixel-ranges";

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
