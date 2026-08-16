import { describe, expect, it } from "vitest";
import { buildMaxPyramid, queryMax } from "../max-pyramid";

const bruteMax = (values: Float32Array, first: number, last: number): number => {
  let best = 0;
  for (let i = Math.max(0, first); i <= Math.min(values.length - 1, last); i++) {
    if (values[i] > best) best = values[i];
  }
  return best;
};

describe("max pyramid", () => {
  it("matches a brute-force range maximum on random data and ranges", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (const length of [1, 2, 3, 7, 64, 1000, 4096]) {
      const values = new Float32Array(length);
      for (let i = 0; i < length; i++) values[i] = rand();
      const pyramid = buildMaxPyramid(values);

      for (let trial = 0; trial < 200; trial++) {
        const a = Math.floor(rand() * length);
        const b = Math.floor(rand() * length);
        const first = Math.min(a, b);
        const last = Math.max(a, b);
        expect(queryMax(pyramid, first, last)).toBe(bruteMax(values, first, last));
      }
    }
  });

  it("clamps out-of-range queries and returns 0 for empty ranges", () => {
    const pyramid = buildMaxPyramid(Float32Array.from([0.5, 0.25]));
    expect(queryMax(pyramid, -5, 10)).toBe(0.5);
    expect(queryMax(pyramid, 1, 5)).toBe(0.25);
    expect(queryMax(pyramid, 3, 2)).toBe(0);
    expect(queryMax(pyramid, 5, 3)).toBe(0);
  });
});
