import { describe, expect, it } from "vitest";
import { mergePixelRanges, scatterPixelRanges } from "../pixel-ranges";

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
