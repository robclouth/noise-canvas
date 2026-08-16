import { describe, expect, it } from "vitest";
import { packedRangesToUvRegion } from "../history-manager";

// Three bands: strides 1, 2, 4 frames per stored coefficient.
const layout = {
  bandOffsets: Uint32Array.from([0, 64, 96]),
  bandLengths: Uint32Array.from([64, 32, 16]),
  bandStepLog2s: Int32Array.from([0, 1, 2]),
};
const numFrames = 64;
const numBands = 3;

describe("packedRangesToUvRegion", () => {
  it("maps a range inside one band to its frame window", () => {
    const region = packedRangesToUvRegion(Uint32Array.from([70, 4]), layout, numFrames, numBands);
    expect(region).toEqual({
      startX: 12 / 64,
      endX: 20 / 64,
      startY: 1 - 2 / 3,
      endY: 1 - 1 / 3,
    });
  });

  it("unions a range that crosses a band boundary", () => {
    const region = packedRangesToUvRegion(Uint32Array.from([60, 10]), layout, numFrames, numBands);
    expect(region).toEqual({
      startX: 0,
      endX: 1,
      startY: 1 - 2 / 3,
      endY: 1,
    });
  });

  it("unions multiple ranges", () => {
    const region = packedRangesToUvRegion(Uint32Array.from([0, 2, 100, 2]), layout, numFrames, numBands);
    // Band 0 frames 0..2 plus band 2 time 4..6 → frames 16..24.
    expect(region).toEqual({
      startX: 0,
      endX: 24 / 64,
      startY: 0,
      endY: 1,
    });
  });

  it("returns null for empty or zero-length ranges", () => {
    expect(packedRangesToUvRegion(new Uint32Array(0), layout, numFrames, numBands)).toBeNull();
    expect(packedRangesToUvRegion(Uint32Array.from([10, 0]), layout, numFrames, numBands)).toBeNull();
  });
});
