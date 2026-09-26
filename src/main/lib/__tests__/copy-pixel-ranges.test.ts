import { describe, expect, it } from "vitest";

import { copyCompactOverlap } from "../../../renderer/src/lib/pixel-ranges";
import { copyPixelRanges } from "../audio-analysis";

/** Sorted, disjoint [start, count] pairs over [0, span), cut by a seeded walk. */
function rangesOver(span: number, seed: number): Uint32Array {
  const out: number[] = [];
  let state = seed;
  const next = (bound: number): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state % bound;
  };
  for (let at = next(7); at < span; ) {
    const count = Math.min(span - at, 1 + next(40));
    out.push(at, count);
    at += count + next(9);
  }
  return Uint32Array.from(out);
}

function pixelCount(ranges: Uint32Array): number {
  let total = 0;
  for (let i = 1; i < ranges.length; i += 2) total += ranges[i];
  return total;
}

describe("copyPixelRanges", () => {
  it.each([1, 2, 3, 4])("copies what copyCompactOverlap copies (seed %i)", async (seed) => {
    const destRanges = rangesOver(3000, seed);
    const srcRanges = rangesOver(3000, seed + 100);
    const src = Float32Array.from({ length: pixelCount(srcRanges) * 4 }, (_, i) => i + 0.5);
    const want = new Float32Array(pixelCount(destRanges) * 4).fill(-1);
    const got = new Float32Array(want);
    copyCompactOverlap(want, destRanges, src, srcRanges);
    await copyPixelRanges(got, destRanges, src, srcRanges);
    expect(Array.from(got)).toEqual(Array.from(want));
  });

  it("refuses a buffer shorter than its ranges", async () => {
    const ranges = Uint32Array.of(0, 8);
    await expect(copyPixelRanges(new Float32Array(16), ranges, new Float32Array(32), ranges)).rejects.toThrow(
      /shorter/,
    );
  });
});
