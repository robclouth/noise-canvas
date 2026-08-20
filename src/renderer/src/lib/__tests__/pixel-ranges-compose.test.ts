import { describe, expect, it } from "vitest";
import { composePixelRangeValues, gatherPixelRanges, mergePixelRanges } from "../pixel-ranges";

function state(pixels: number, salt: number): Float32Array {
  const out = new Float32Array(pixels * 4);
  for (let i = 0; i < out.length; i++) out[i] = ((i * 7 + salt) % 53) / 53 + salt;
  return out;
}

describe("composePixelRangeValues", () => {
  it("takes each pixel from the first layer holding it, in the target's range order", () => {
    const a = state(64, 1);
    const b = state(64, 2);
    const dirty = new Uint32Array([10, 5, 40, 3]);
    const extent = new Uint32Array([8, 10, 38, 8]);
    const merged = mergePixelRanges(dirty, extent);
    const composed = composePixelRangeValues(merged, [
      { ranges: dirty, values: gatherPixelRanges(a, dirty) },
      { ranges: extent, values: gatherPixelRanges(b, extent) },
    ]);
    // Expected: b everywhere in the extent, overridden by a inside the dirty ranges.
    const expected = new Float32Array(b);
    for (let p = 10; p < 15; p++) expected.set(a.subarray(p * 4, p * 4 + 4), p * 4);
    for (let p = 40; p < 43; p++) expected.set(a.subarray(p * 4, p * 4 + 4), p * 4);
    expect(Array.from(composed)).toEqual(Array.from(gatherPixelRanges(expected, merged)));
  });

  it("throws when a target pixel is covered by no layer", () => {
    expect(() =>
      composePixelRangeValues(new Uint32Array([0, 4]), [
        { ranges: new Uint32Array([2, 2]), values: new Float32Array(8) },
      ]),
    ).toThrow(/no layer/);
  });
});
