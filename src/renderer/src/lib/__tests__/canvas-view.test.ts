import { describe, expect, it } from "vitest";

import { constantQBandLayout, constantQMetadata } from "../../test/mock-spectrogram";
import { layoutTexels, type BandLayout } from "../band-layout";
import { blockGrid, blockPixelRanges, blockTexels } from "../block-grid";
import { canvasViewOf, fileRangesToView, viewRangesToFile } from "../canvas-view";

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

const SMALL_RATE = 8000;
const small = layoutOf(2, SMALL_RATE, 4);
const grid = blockGrid(small, small.numFrames, SMALL_RATE, 0.25);

describe("canvasViewOf", () => {
  it("spans the whole file as the file's own layout", () => {
    const view = canvasViewOf(grid, 0, grid.blockCount - 1);
    expect(view.startFrame).toBe(0);
    expect(view.endFrame).toBe(small.numFrames);
    expect(view.texels).toBe(layoutTexels(small));
    expect(Array.from(view.layout.metadata)).toEqual(Array.from(small.metadata));
    for (let band = 0; band < small.numBands; band++) {
      expect(view.ranges[band * 2]).toBe(small.metadata[band * 4]);
      expect(view.ranges[band * 2 + 1]).toBe(small.metadata[band * 4 + 1]);
      expect(view.bandK0[band]).toBe(0);
    }
  });

  it("holds exactly its blocks' texels, band offsets packed in band order", () => {
    const view = canvasViewOf(grid, 1, 2);
    let expected = 0;
    for (let index = 1; index <= 2; index++) expected += blockTexels(grid, index);
    expect(view.texels).toBe(expected);
    let offset = 0;
    for (let band = 0; band < small.numBands; band++) {
      expect(view.layout.metadata[band * 4]).toBe(offset);
      offset += view.layout.metadata[band * 4 + 1];
      expect(view.layout.metadata[band * 4 + 2]).toBe(small.metadata[band * 4 + 2]);
      expect(view.layout.metadata[band * 4 + 3]).toBe(small.metadata[band * 4 + 3]);
    }
  });

  it("starts every band on the bin its blocks start on", () => {
    const view = canvasViewOf(grid, 2, grid.blockCount - 1);
    const first = blockPixelRanges(grid, 2);
    for (let i = 0; i < first.count; i++) {
      expect(view.ranges[i * 2]).toBe(first.ranges[i * 2]);
    }
    for (let band = 0; band < small.numBands; band++) {
      expect(view.bandK0[band]).toBe(view.startFrame / 2 ** small.metadata[band * 4 + 2]);
    }
  });

  it("sizes its texture the way the analysis sizes the file's", () => {
    const view = canvasViewOf(grid, 0, 0);
    expect(view.textureWidth * view.textureHeight).toBeGreaterThanOrEqual(view.texels);
    expect(view.textureWidth * (view.textureHeight - 1)).toBeLessThan(view.texels);
  });
});

describe("range remapping", () => {
  const view = canvasViewOf(grid, 1, 2);

  it("round-trips in-view ranges between file and view space", () => {
    const band = 2;
    const start = view.ranges[band * 2] + 3;
    const fileRanges = Uint32Array.of(start, 5);
    const viewRanges = fileRangesToView(view, small, fileRanges);
    expect(viewRanges).not.toBeNull();
    expect(Array.from(viewRangesToFile(view, viewRanges!))).toEqual(Array.from(fileRanges));
  });

  it("maps a file range to the same offset inside its band", () => {
    const band = 1;
    const fileRanges = Uint32Array.of(view.ranges[band * 2] + 2, 4);
    const viewRanges = fileRangesToView(view, small, fileRanges)!;
    expect(viewRanges[0]).toBe(view.layout.metadata[band * 4] + 2);
    expect(viewRanges[1]).toBe(4);
  });

  it("splits a range that crosses a band edge", () => {
    const wholeFile = canvasViewOf(grid, 0, grid.blockCount - 1);
    const band0Len = small.metadata[1];
    const fileRanges = Uint32Array.of(small.metadata[0] + band0Len - 2, 5);
    const viewRanges = fileRangesToView(wholeFile, small, fileRanges)!;
    expect(viewRanges.length).toBe(4);
    expect(viewRanges[1]).toBe(2);
    expect(viewRanges[3]).toBe(3);
    expect(Array.from(viewRangesToFile(wholeFile, viewRanges))).toEqual([
      small.metadata[0] + band0Len - 2,
      2,
      small.metadata[4],
      3,
    ]);
  });

  it("refuses a range that leaves the view", () => {
    const band = 0;
    const beforeView = Uint32Array.of(small.metadata[band * 4], 2);
    expect(fileRangesToView(view, small, beforeView)).toBeNull();
    const straddling = Uint32Array.of(view.ranges[band * 2] + view.ranges[band * 2 + 1] - 1, 2);
    expect(fileRangesToView(view, small, straddling)).toBeNull();
  });
});
