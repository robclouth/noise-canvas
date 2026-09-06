import { describe, expect, it } from "vitest";

import { constantQBandLayout, constantQMetadata } from "../../test/mock-spectrogram";
import { coarsestStepLog2, layoutTexels, type BandLayout } from "../band-layout";
import {
  blockGrid,
  blockOfFrame,
  blockPixelRanges,
  blockTexels,
  blocksForFrameRange,
  blocksForPixelRanges,
  frameRangeOfBlock,
} from "../block-grid";

/** A constant-Q band layout, without the packed data. */
function layoutOf(
  durationSeconds: number,
  sampleRate: number,
  bandsPerOctave: number,
): BandLayout & { numFrames: number } {
  const bands = constantQBandLayout({ durationSeconds, sampleRate, bandsPerOctave });
  return {
    numBands: bands.numBands,
    metadata: constantQMetadata(bands, { bandsPerOctave }),
    numFrames: bands.numFrames,
  };
}

// Small enough that a test can walk every packed pixel, and dyadic, so the
// bands really do step at doubling rates.
const SMALL_RATE = 8000;
const small = layoutOf(2, SMALL_RATE, 4);
const smallGrid = blockGrid(small, small.numFrames, SMALL_RATE, 0.25);

describe("blockGrid", () => {
  it("holds a whole number of every band's bins", () => {
    for (let band = 0; band < small.numBands; band++) {
      const step = 2 ** small.metadata[band * 4 + 2];
      expect(smallGrid.blockFrames % step, `band ${band}`).toBe(0);
      expect(smallGrid.binsPerBlock[band]).toBe(smallGrid.blockFrames / step);
    }
  });

  it("lands near the target length", () => {
    const layout = layoutOf(30, 48000, 36);
    const grid = blockGrid(layout, layout.numFrames, 48000);
    expect(grid.blockFrames / 48000).toBeGreaterThan(1.5);
    expect(grid.blockFrames / 48000).toBeLessThan(2.5);
  });

  it("rounds the target up to the coarsest band's step when that is longer", () => {
    const grid = blockGrid(small, small.numFrames, SMALL_RATE, 0.0001);
    expect(grid.blockFrames).toBe(2 ** coarsestStepLog2(small));
  });

  it("covers the whole file", () => {
    expect(smallGrid.blockCount * smallGrid.blockFrames).toBeGreaterThanOrEqual(small.numFrames);
    expect((smallGrid.blockCount - 1) * smallGrid.blockFrames).toBeLessThan(small.numFrames);
  });

  it("gives one block to a file shorter than a block", () => {
    const short = layoutOf(0.05, SMALL_RATE, 4);
    expect(blockGrid(short, short.numFrames, SMALL_RATE, 0.25).blockCount).toBe(1);
  });

  it("cuts every band into the same number of blocks", () => {
    for (let band = 0; band < small.numBands; band++) {
      const length = small.metadata[band * 4 + 1];
      expect(Math.ceil(length / smallGrid.binsPerBlock[band]), `band ${band}`).toBe(smallGrid.blockCount);
    }
  });
});

describe("blockOfFrame and frameRangeOfBlock", () => {
  it("agree on every block's boundaries", () => {
    for (let index = 0; index < smallGrid.blockCount; index++) {
      const span = frameRangeOfBlock(smallGrid, index);
      expect(blockOfFrame(smallGrid, span.start)).toBe(index);
      expect(blockOfFrame(smallGrid, span.end - 1)).toBe(index);
    }
  });

  it("clip the last block to the file", () => {
    expect(frameRangeOfBlock(smallGrid, smallGrid.blockCount - 1).end).toBe(small.numFrames);
  });

  it("clamp a frame outside the file to the nearest block", () => {
    expect(blockOfFrame(smallGrid, -100)).toBe(0);
    expect(blockOfFrame(smallGrid, small.numFrames * 10)).toBe(smallGrid.blockCount - 1);
  });
});

describe("blocksForFrameRange", () => {
  it("takes every block the range touches", () => {
    const start = smallGrid.blockFrames * 2 + 5;
    expect(blocksForFrameRange(smallGrid, start, start + smallGrid.blockFrames)).toEqual([2, 3]);
  });

  it("takes one block for a range inside it", () => {
    const start = smallGrid.blockFrames + 1;
    expect(blocksForFrameRange(smallGrid, start, start + 1)).toEqual([1]);
  });

  it("stops at the block the range ends on", () => {
    const start = smallGrid.blockFrames * 2;
    expect(blocksForFrameRange(smallGrid, start, start + smallGrid.blockFrames)).toEqual([2]);
  });

  it("takes nothing for an empty range", () => {
    expect(blocksForFrameRange(smallGrid, 100, 100)).toEqual([]);
  });
});

describe("blockPixelRanges", () => {
  it("tiles the packed array exactly once, with no gap and no overlap", () => {
    const seen = new Uint8Array(layoutTexels(small));
    for (let index = 0; index < smallGrid.blockCount; index++) {
      const list = blockPixelRanges(smallGrid, index);
      for (let i = 0; i < list.count; i++) {
        const start = list.ranges[i * 2];
        for (let p = start; p < start + list.ranges[i * 2 + 1]; p++) {
          expect(seen[p], `pixel ${p} in block ${index}`).toBe(0);
          seen[p] = 1;
        }
      }
    }
    expect(seen.indexOf(0)).toBe(-1);
  });

  it("reaches every band, with only the last block cut short", () => {
    for (let index = 0; index < smallGrid.blockCount; index++) {
      expect(blockPixelRanges(smallGrid, index).count, `block ${index}`).toBe(small.numBands);
    }
    expect(blockTexels(smallGrid, smallGrid.blockCount - 1)).toBeLessThanOrEqual(blockTexels(smallGrid, 0));
  });

  it("starts each band's range at the layout's own offset", () => {
    const list = blockPixelRanges(smallGrid, 3);
    for (let band = 0; band < small.numBands; band++) {
      expect(list.ranges[band * 2], `band ${band}`).toBe(small.metadata[band * 4] + 3 * smallGrid.binsPerBlock[band]);
    }
  });

  it("holds nothing past the last block", () => {
    expect(blockPixelRanges(smallGrid, smallGrid.blockCount).count).toBe(0);
    expect(blockTexels(smallGrid, smallGrid.blockCount + 5)).toBe(0);
  });

  it("adds up to the whole packed array over every block", () => {
    let texels = 0;
    for (let index = 0; index < smallGrid.blockCount; index++) texels += blockTexels(smallGrid, index);
    expect(texels).toBe(layoutTexels(small));
  });
});

describe("blocksForPixelRanges", () => {
  it("finds the blocks one band's bins fall in", () => {
    const offset = small.metadata[0];
    const bins = smallGrid.binsPerBlock[0];
    expect(blocksForPixelRanges(smallGrid, Uint32Array.of(offset + bins * 2, 1))).toEqual([2]);
    expect(blocksForPixelRanges(smallGrid, Uint32Array.of(offset + bins * 2 - 1, 2))).toEqual([1, 2]);
  });

  it("agrees with the ranges each block claims", () => {
    for (let index = 0; index < smallGrid.blockCount; index++) {
      const list = blockPixelRanges(smallGrid, index);
      expect(blocksForPixelRanges(smallGrid, list.ranges.subarray(0, list.count * 2)), `block ${index}`).toEqual([
        index,
      ]);
    }
  });

  it("takes every block for the whole packed array", () => {
    const all = blocksForPixelRanges(smallGrid, Uint32Array.of(0, layoutTexels(small)));
    expect(all).toHaveLength(smallGrid.blockCount);
  });

  it("takes nothing for an empty range", () => {
    expect(blocksForPixelRanges(smallGrid, Uint32Array.of(100, 0))).toEqual([]);
  });
});
