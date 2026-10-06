import { describe, expect, it } from "vitest";

import { constantQBandLayout, constantQMetadata } from "../../test/mock-spectrogram";
import { layoutTexels, type BandLayout } from "../band-layout";
import { ANALYSIS_MAX_TEXTURE_SIZE, packedFold, padToFold } from "../constants";
import { blockGrid, blockPixelRanges, blockTexels, gridQuantumFrames } from "../block-grid";
import {
  canvasViewOf,
  canvasViewOfFrames,
  clipRangesToView,
  fileRangesToView,
  fileUvToViewUv,
  viewCoversFile,
  viewRangesToFile,
  viewUvToFileUv,
} from "../canvas-view";

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

describe("canvasViewOfFrames", () => {
  const quantum = gridQuantumFrames(grid);

  it("moves its edges out to an even bin of every band", () => {
    const view = canvasViewOfFrames(grid, grid.blockFrames + quantum * 1.5, grid.blockFrames + quantum * 3.25);
    expect(view.startFrame).toBe(grid.blockFrames + quantum);
    expect(view.endFrame).toBe(grid.blockFrames + quantum * 4);
    for (let band = 0; band < small.numBands; band++) {
      const k0 = view.startFrame / 2 ** small.metadata[band * 4 + 2];
      expect(view.bandK0[band]).toBe(k0);
      expect(k0 % 2).toBe(0);
    }
    expect(view.firstBlock).toBe(1);
    expect(view.lastBlock).toBe(1);
  });

  it("holds what the view of the same blocks holds when its edges are block edges", () => {
    const frames = canvasViewOfFrames(grid, grid.blockFrames, grid.blockFrames * 3);
    const blocks = canvasViewOf(grid, 1, 2);
    expect(Array.from(frames.ranges)).toEqual(Array.from(blocks.ranges));
    expect(Array.from(frames.layout.metadata)).toEqual(Array.from(blocks.layout.metadata));
    expect([frames.firstBlock, frames.lastBlock]).toEqual([1, 2]);
  });

  it("ends at the file's end", () => {
    const view = canvasViewOfFrames(grid, small.numFrames - 1, small.numFrames + quantum);
    expect(view.endFrame).toBe(small.numFrames);
    expect(view.texels).toBeGreaterThan(0);
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

describe("clipRangesToView", () => {
  const view = canvasViewOf(grid, 2, 4);

  it("keeps a fully covered range, translated with its values", () => {
    const band = 1;
    const fileStart = view.ranges[band * 2] + 3;
    const ranges = Uint32Array.of(fileStart, 4);
    const values = new Float32Array(4 * 4);
    for (let i = 0; i < values.length; i++) values[i] = i + 1;
    const clipped = clipRangesToView(view, small, ranges, values);
    expect(clipped.covered).toBe(true);
    expect(Array.from(clipped.viewRanges)).toEqual([view.layout.metadata[band * 4] + 3, 4]);
    expect(Array.from(clipped.fileRanges)).toEqual([fileStart, 4]);
    expect(Array.from(clipped.viewValues!)).toEqual(Array.from(values));
  });

  it("drops the pixels outside the view and keeps their neighbours' values", () => {
    const band = 2;
    const viewFileStart = view.ranges[band * 2];
    // Two pixels before the view, three inside.
    const ranges = Uint32Array.of(viewFileStart - 2, 5);
    const values = new Float32Array(5 * 4);
    for (let i = 0; i < values.length; i++) values[i] = i + 1;
    const clipped = clipRangesToView(view, small, ranges, values);
    expect(clipped.covered).toBe(false);
    expect(Array.from(clipped.viewRanges)).toEqual([view.layout.metadata[band * 4], 3]);
    expect(Array.from(clipped.fileRanges)).toEqual([viewFileStart, 3]);
    expect(Array.from(clipped.viewValues!)).toEqual(Array.from(values.subarray(2 * 4)));
  });

  it("splits a range crossing a band edge and reports full coverage", () => {
    const wholeFile = canvasViewOf(grid, 0, grid.blockCount - 1);
    const band0Len = small.metadata[1];
    const ranges = Uint32Array.of(small.metadata[0] + band0Len - 2, 5);
    const clipped = clipRangesToView(wholeFile, small, ranges);
    expect(clipped.covered).toBe(true);
    expect(clipped.viewRanges.length).toBe(4);
    expect(clipped.viewRanges[1]).toBe(2);
    expect(clipped.viewRanges[3]).toBe(3);
    expect(Array.from(clipped.fileRanges)).toEqual([small.metadata[0] + band0Len - 2, 2, small.metadata[4], 3]);
  });

  it("keeps values aligned across several ranges when the first is clipped", () => {
    const band = 1;
    const viewFileStart = view.ranges[band * 2];
    const inside = view.ranges[band * 2] + 5;
    const ranges = Uint32Array.of(viewFileStart - 1, 2, inside, 2);
    const values = new Float32Array(4 * 4);
    for (let i = 0; i < values.length; i++) values[i] = i + 1;
    const clipped = clipRangesToView(view, small, ranges, values);
    expect(clipped.covered).toBe(false);
    expect(Array.from(clipped.viewRanges)).toEqual([
      view.layout.metadata[band * 4],
      1,
      view.layout.metadata[band * 4] + 5,
      2,
    ]);
    expect(Array.from(clipped.viewValues!)).toEqual(
      Array.from(values.subarray(4, 8)).concat(Array.from(values.subarray(8, 16))),
    );
  });
});

describe("view UV translation", () => {
  const view = canvasViewOf(grid, 2, 4);

  it("covers the file only from the first to the last block", () => {
    expect(viewCoversFile(canvasViewOf(grid, 0, grid.blockCount - 1), small.numFrames)).toBe(true);
    expect(viewCoversFile(view, small.numFrames)).toBe(false);
  });

  it("round-trips a time UV through the view", () => {
    const fileX = viewUvToFileUv(view, small.numFrames, 0.25);
    expect(fileX).toBeCloseTo((view.startFrame + 0.25 * (view.endFrame - view.startFrame)) / small.numFrames, 12);
    expect(fileUvToViewUv(view, small.numFrames, fileX)).toBeCloseTo(0.25, 12);
  });
});

describe("the fold a packed run takes", () => {
  it("lays a short run along one row", () => {
    expect(packedFold(1)).toEqual({ width: 1, height: 1 });
    expect(packedFold(100)).toEqual({ width: 100, height: 1 });
    expect(packedFold(ANALYSIS_MAX_TEXTURE_SIZE)).toEqual({ width: ANALYSIS_MAX_TEXTURE_SIZE, height: 1 });
  });

  it("wraps a longer run at the widest texture, leaving the last row short", () => {
    const fold = packedFold(ANALYSIS_MAX_TEXTURE_SIZE * 3 + 7);
    expect(fold).toEqual({ width: ANALYSIS_MAX_TEXTURE_SIZE, height: 4 });
    expect(fold.width * fold.height).toBeGreaterThan(ANALYSIS_MAX_TEXTURE_SIZE * 3 + 7);
  });

  it("gives an empty run a texture of one texel, because no texture may be empty", () => {
    expect(packedFold(0)).toEqual({ width: 1, height: 1 });
  });

  it("grows a run to fill the texture its fold makes, keeping the values it had", () => {
    const texels = ANALYSIS_MAX_TEXTURE_SIZE + 3;
    const run = new Float32Array(texels * 4);
    for (let i = 0; i < run.length; i++) run[i] = i + 1;
    const padded = padToFold(run, texels, 4);
    const fold = packedFold(texels);
    expect(padded.length).toBe(fold.width * fold.height * 4);
    expect(Array.from(padded.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(padded[run.length - 1]).toBe(run.length);
    expect(padded[run.length]).toBe(0);
  });

  it("hands back a run that already fills its texture", () => {
    const run = new Float32Array(64 * 2);
    expect(padToFold(run, 64, 2)).toBe(run);
  });
});
