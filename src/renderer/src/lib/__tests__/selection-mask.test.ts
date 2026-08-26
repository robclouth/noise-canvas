import { describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { selectionBandRange, selectionFrameRange, selectionMaskTest, type Selection } from "../selection";
import { lassoSelection, maskBoundarySegments } from "../selection-mask";

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

describe("maskBoundarySegments", () => {
  it("outlines a lone cell with its four edges", () => {
    const segments = maskBoundarySegments({ cols: 3, rows: 3, cells: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 0, 0]) });
    expect(segments.length).toBe(16);
  });
});
