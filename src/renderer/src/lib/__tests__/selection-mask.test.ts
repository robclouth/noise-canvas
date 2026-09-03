import { describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { selectionBandRange, selectionFrameRange, selectionMaskTest, type Selection } from "../selection";
import { invertSelection, lassoSelection, maskBoundarySegments, unionSelections } from "../selection-mask";

// 1 s at 100 Hz with 10 bands: frames and pitch UV stay easy to reason about.
const spec = () => createMockSpectrogramData({ numFrames: 100, sampleRate: 100, numBands: 10 });

describe("lassoSelection", () => {
  it("fills a rectangular path completely inside its bounding box", () => {
    const s = spec();
    const points = [
      { time: 0.2, pitchUv: 0.2 },
      { time: 0.8, pitchUv: 0.2 },
      { time: 0.8, pitchUv: 0.8 },
      { time: 0.2, pitchUv: 0.8 },
    ];
    const selection = lassoSelection(points, s);
    expect(selection).not.toBeNull();
    expect(selection?.start).toBeCloseTo(0.2);
    expect(selection?.end).toBeCloseTo(0.8);
    expect(selection?.pitchLo).toBeCloseTo(0.2);
    expect(selection?.pitchHi).toBeCloseTo(0.8);
    const mask = selection?.mask;
    expect(mask).toBeDefined();
    if (!mask) return;
    expect(Array.from(mask.cells).every((cell) => cell === 255)).toBe(true);
  });

  it("fills a triangle with rows that narrow toward its apex", () => {
    const s = spec();
    // Apex at the top, base along the bottom.
    const points = [
      { time: 0.5, pitchUv: 0.9 },
      { time: 0.1, pitchUv: 0.1 },
      { time: 0.9, pitchUv: 0.1 },
    ];
    const selection = lassoSelection(points, s);
    const mask = selection?.mask;
    expect(mask).toBeDefined();
    if (!mask) return;
    const rowWidth = (row: number) => {
      let count = 0;
      for (let col = 0; col < mask.cols; col++) if (mask.cells[row * mask.cols + col] > 0) count++;
      return count;
    };
    // Row 0 is the highest pitch: the apex.
    expect(rowWidth(0)).toBeLessThan(rowWidth(mask.rows - 1));
    expect(rowWidth(mask.rows - 1)).toBeGreaterThan(0);
  });

  it("returns null for a path that encloses nothing", () => {
    const s = spec();
    expect(lassoSelection([{ time: 0.5, pitchUv: 0.5 }], s)).toBeNull();
    expect(
      lassoSelection(
        [
          { time: 0.2, pitchUv: 0.5 },
          { time: 0.8, pitchUv: 0.5 },
          { time: 0.5, pitchUv: 0.5 },
        ],
        s,
      ),
    ).toBeNull();
  });
});

describe("selectionMaskTest", () => {
  it("is null for a plain rectangle", () => {
    const rect: Selection = { start: 0.2, end: 0.8, pitchLo: 0.2, pitchHi: 0.8 };
    expect(selectionMaskTest(rect, 100, 10)).toBeNull();
  });

  it("reads the mask cell a band and bin edge fall in", () => {
    const s = spec();
    const selection = lassoSelection(
      [
        { time: 0.5, pitchUv: 0.9 },
        { time: 0.1, pitchUv: 0.1 },
        { time: 0.9, pitchUv: 0.1 },
      ],
      s,
    );
    expect(selection).not.toBeNull();
    if (!selection) return;
    const test = selectionMaskTest(selection, s.sampleRate, s.numBands);
    expect(test).not.toBeNull();
    if (!test) return;
    const { lowBand, highBand } = selectionBandRange(selection, s.numBands);
    const { startFrame, endFrame } = selectionFrameRange(selection, s.sampleRate);
    const midFrame = Math.floor((startFrame + endFrame) / 2);
    // The triangle's base row holds its middle; its apex row misses the corner.
    expect(test(highBand, midFrame)).toBe(true);
    expect(test(lowBand, startFrame)).toBe(false);
  });

  it("keeps the shape when the rectangle is translated, mask untouched", () => {
    const s = spec();
    const selection = lassoSelection(
      [
        { time: 0.5, pitchUv: 0.9 },
        { time: 0.1, pitchUv: 0.1 },
        { time: 0.9, pitchUv: 0.1 },
      ],
      s,
    );
    if (!selection) throw new Error("no selection");
    const moved: Selection = { ...selection, start: selection.start + 0.1, end: selection.end + 0.1 };
    const test = selectionMaskTest(selection, s.sampleRate, s.numBands);
    const movedTest = selectionMaskTest(moved, s.sampleRate, s.numBands);
    if (!test || !movedTest) throw new Error("no mask test");
    const { lowBand, highBand } = selectionBandRange(selection, s.numBands);
    const { startFrame } = selectionFrameRange(selection, s.sampleRate);
    for (let band = lowBand; band <= highBand; band++) {
      for (let off = 0; off < 60; off += 7) {
        expect(movedTest(band, startFrame + 10 + off)).toBe(test(band, startFrame + off));
      }
    }
  });
});

describe("unionSelections", () => {
  it("joins two disjoint rectangles into one mask with a gap between them", () => {
    const s = spec();
    const a: Selection = { start: 0.1, end: 0.3, pitchLo: 0.2, pitchHi: 0.4 };
    const b: Selection = { start: 0.6, end: 0.8, pitchLo: 0.6, pitchHi: 0.8 };
    const joined = unionSelections(a, b, s);
    expect(joined.start).toBeCloseTo(0.1);
    expect(joined.end).toBeCloseTo(0.8);
    expect(joined.pitchLo).toBeCloseTo(0.2);
    expect(joined.pitchHi).toBeCloseTo(0.8);
    const test = selectionMaskTest(joined, s.sampleRate, s.numBands);
    expect(test).not.toBeNull();
    if (!test) return;
    // Inside a: band 7 (pitch 0.25-0.35), frame 20. Inside b: band 2, frame 70.
    expect(test(7, 20)).toBe(true);
    expect(test(2, 70)).toBe(true);
    // The gap between them, and a's bands over b's time, stay out.
    expect(test(7, 45)).toBe(false);
    expect(test(7, 70)).toBe(false);
    expect(test(2, 20)).toBe(false);
  });

  it("returns a covering rectangle unchanged", () => {
    const s = spec();
    const outer: Selection = { start: 0.1, end: 0.9, pitchLo: 0.1, pitchHi: 0.9 };
    const inner: Selection = { start: 0.3, end: 0.5, pitchLo: 0.3, pitchHi: 0.5 };
    expect(unionSelections(outer, inner, s)).toBe(outer);
    expect(unionSelections(inner, outer, s)).toBe(outer);
  });

  it("keeps a masked side's shape through the union", () => {
    const s = spec();
    const triangle = lassoSelection(
      [
        { time: 0.5, pitchUv: 0.9 },
        { time: 0.1, pitchUv: 0.1 },
        { time: 0.9, pitchUv: 0.1 },
      ],
      s,
    );
    if (!triangle) throw new Error("no triangle");
    const rect: Selection = { start: 0.0, end: 0.05, pitchLo: 0.0, pitchHi: 0.1 };
    const joined = unionSelections(triangle, rect, s);
    const test = selectionMaskTest(joined, s.sampleRate, s.numBands);
    if (!test) throw new Error("no mask");
    const triTest = selectionMaskTest(triangle, s.sampleRate, s.numBands);
    if (!triTest) throw new Error("no triangle mask");
    // The triangle's own membership survives at its sample points, within one
    // cell of the resampled grid.
    expect(test(5, 50)).toBe(triTest(5, 50));
    expect(test(9, 1)).toBe(true);
  });
});

describe("maskBoundarySegments", () => {
  it("outlines a lone cell with its four edges", () => {
    const segments = maskBoundarySegments({ cols: 3, rows: 3, cells: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 0, 0]) });
    expect(segments.length).toBe(16);
  });
});

describe("invertSelection", () => {
  it("returns the rest of the file as a plain rectangle when one side is free", () => {
    const s = spec();
    const head: Selection = { start: 0, end: 0.4, pitchLo: 0, pitchHi: 1 };
    expect(invertSelection(head, s)).toEqual({ start: 0.4, end: 1, pitchLo: 0, pitchHi: 1 });
    const tail: Selection = { start: 0.4, end: 1, pitchLo: 0, pitchHi: 1 };
    expect(invertSelection(tail, s)).toEqual({ start: 0, end: 0.4, pitchLo: 0, pitchHi: 1 });
    const bottom: Selection = { start: 0, end: 1, pitchLo: 0, pitchHi: 0.3 };
    expect(invertSelection(bottom, s)).toEqual({ start: 0, end: 1, pitchLo: 0.3, pitchHi: 1 });
    const top: Selection = { start: 0, end: 1, pitchLo: 0.3, pitchHi: 1 };
    expect(invertSelection(top, s)).toEqual({ start: 0, end: 1, pitchLo: 0, pitchHi: 0.3 });
  });

  it("is null when the selection already covers the file", () => {
    const s = spec();
    expect(invertSelection({ start: 0, end: 1, pitchLo: 0, pitchHi: 1 }, s)).toBeNull();
  });

  it("masks out a rectangle in the middle and keeps everything around it", () => {
    const s = spec();
    const middle: Selection = { start: 0.3, end: 0.7, pitchLo: 0.3, pitchHi: 0.7 };
    const inverted = invertSelection(middle, s);
    expect(inverted).not.toBeNull();
    if (!inverted) return;
    expect(inverted).toMatchObject({ start: 0, end: 1, pitchLo: 0, pitchHi: 1 });
    const test = selectionMaskTest(inverted, s.sampleRate, s.numBands);
    const inner = selectionMaskTest(middle, s.sampleRate, s.numBands);
    expect(test).not.toBeNull();
    expect(inner).toBeNull();
    if (!test) return;
    const { lowBand, highBand } = selectionBandRange(middle, s.numBands);
    const { startFrame, endFrame } = selectionFrameRange(middle, s.sampleRate);
    const midBand = Math.floor((lowBand + highBand) / 2);
    const midFrame = Math.floor((startFrame + endFrame) / 2);
    expect(test(midBand, midFrame)).toBe(false);
    // Same bands either side of it, and the same time above and below it.
    expect(test(midBand, 5)).toBe(true);
    expect(test(midBand, 95)).toBe(true);
    expect(test(0, midFrame)).toBe(true);
    expect(test(s.numBands - 1, midFrame)).toBe(true);
  });

  it("inverts a shape, and inverting twice comes back to it", () => {
    const s = spec();
    const triangle = lassoSelection(
      [
        { time: 0.5, pitchUv: 0.9 },
        { time: 0.1, pitchUv: 0.1 },
        { time: 0.9, pitchUv: 0.1 },
      ],
      s,
    );
    if (!triangle) throw new Error("no triangle");
    const outside = invertSelection(triangle, s);
    if (!outside) throw new Error("no inverse");
    const back = invertSelection(outside, s);
    if (!back) throw new Error("no round trip");
    const triTest = selectionMaskTest(triangle, s.sampleRate, s.numBands);
    const outTest = selectionMaskTest(outside, s.sampleRate, s.numBands);
    const backTest = selectionMaskTest(back, s.sampleRate, s.numBands);
    if (!triTest || !outTest || !backTest) throw new Error("no mask test");
    const { lowBand, highBand } = selectionBandRange(triangle, s.numBands);
    for (let band = lowBand; band <= highBand; band++) {
      for (let frame = 5; frame < 100; frame += 10) {
        const inside = triTest(band, frame);
        expect(outTest(band, frame)).toBe(!inside);
        expect(backTest(band, frame)).toBe(inside);
      }
    }
  });
});
