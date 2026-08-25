import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { brushFootprintRanges, fullTextureRange, rowRange } from "../range-quads";

function footprint(
  data: ReturnType<typeof createConstantQMockSpectrogramData>,
  lowBand: number,
  highBand: number,
  window: { frameStart: number; frameEnd: number } | null,
  marginBins = 4,
  pixelClamp?: { start: number; end: number },
) {
  const ranges = new Uint32Array(data.numBands * 6);
  const binRanges = new Float32Array(data.numBands * 4);
  const count = brushFootprintRanges(data, lowBand, highBand, window, marginBins, ranges, binRanges, pixelClamp);
  return { ranges: ranges.subarray(0, count * 2), count, binRanges };
}

function pixelBounds(ranges: Uint32Array): { first: number; last: number } {
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < ranges.length; i += 2) {
    first = Math.min(first, ranges[i]);
    last = Math.max(last, ranges[i] + ranges[i + 1]);
  }
  return { first, last };
}

function pixelsOf(ranges: Uint32Array): Set<number> {
  const pixels = new Set<number>();
  for (let i = 0; i < ranges.length; i += 2) {
    for (let p = ranges[i]; p < ranges[i] + ranges[i + 1]; p++) pixels.add(p);
  }
  return pixels;
}

describe("brushFootprintRanges", () => {
  const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 6 });
  const width = data.textureWidth;

  it("keeps every range inside one row or row-aligned at both ends", () => {
    const { ranges } = footprint(data, 0, data.numBands - 1, null);
    expect(ranges.length).toBeGreaterThan(0);
    for (let i = 0; i < ranges.length; i += 2) {
      const start = ranges[i];
      const count = ranges[i + 1];
      expect(count).toBeGreaterThan(0);
      const firstRow = Math.floor(start / width);
      const lastRow = Math.floor((start + count - 1) / width);
      if (firstRow !== lastRow) {
        expect(start % width).toBe(0);
        expect((start + count) % width).toBe(0);
      }
    }
  });

  it("covers exactly the bins it reports for each band, once", () => {
    const window = { frameStart: 3000, frameEnd: 3400 };
    const { ranges, binRanges } = footprint(data, 5, 20, window);
    const expected = new Set<number>();
    for (let band = 0; band < data.numBands; band++) {
      const offset = data.metadata[band * 4];
      for (let bin = binRanges[band * 4]; bin < binRanges[band * 4 + 1]; bin++) expected.add(offset + bin);
      if (band < 5 || band > 20) expect(binRanges[band * 4 + 1]).toBe(0);
    }
    let listed = 0;
    for (let i = 1; i < ranges.length; i += 2) listed += ranges[i];
    expect(listed).toBe(expected.size);
    expect(pixelsOf(ranges)).toEqual(expected);
  });

  it("includes every bin whose left edge lies in the window, plus the margin", () => {
    const window = { frameStart: 3000, frameEnd: 3400 };
    const margin = 4;
    const { binRanges } = footprint(data, 0, data.numBands - 1, window, margin);
    for (let band = 0; band < data.numBands; band++) {
      const cell = 2 ** data.metadata[band * 4 + 2];
      const length = data.metadata[band * 4 + 1];
      const firstInside = Math.ceil(window.frameStart / cell);
      const lastInside = Math.ceil(window.frameEnd / cell) - 1;
      expect(binRanges[band * 4]).toBeLessThanOrEqual(Math.max(0, firstInside - margin));
      expect(binRanges[band * 4 + 1]).toBeGreaterThanOrEqual(Math.min(length, lastInside + 1 + margin));
      expect(binRanges[band * 4]).toBeGreaterThanOrEqual(0);
      expect(binRanges[band * 4 + 1]).toBeLessThanOrEqual(length);
    }
  });

  // Band offsets are float32 and can round a whole-band range's true edges
  // away above 2^24 texels; margin pixels cover them, held inside the clamp.
  it("widens a whole-band range by margin pixels, inside the clamp", () => {
    const margin = 4;
    const clamp = { start: data.metadata[2 * 4] - 1, end: data.metadata[4 * 4] + data.metadata[4 * 4 + 1] + 2 };
    const { first, last } = pixelBounds(footprint(data, 2, 4, null, margin, clamp).ranges);
    expect(first).toBe(clamp.start);
    expect(last).toBe(clamp.end);
    const unclamped = pixelBounds(footprint(data, 2, 4, null, margin).ranges);
    expect(unclamped.first).toBe(data.metadata[2 * 4] - margin);
    expect(unclamped.last).toBe(data.metadata[4 * 4] + data.metadata[4 * 4 + 1] + margin);
  });

  it("spans whole bands when the window is null", () => {
    const { binRanges } = footprint(data, 2, 4, null);
    for (const band of [2, 3, 4]) {
      expect(binRanges[band * 4]).toBe(0);
      expect(binRanges[band * 4 + 1]).toBe(data.metadata[band * 4 + 1]);
    }
  });

  it("clamps the band range to the layout", () => {
    const { binRanges, count } = footprint(data, -3, data.numBands + 3, null);
    expect(count).toBeGreaterThan(0);
    expect(binRanges[(data.numBands - 1) * 4 + 1]).toBe(data.metadata[(data.numBands - 1) * 4 + 1]);
  });

  it("writes a fraction of the brush rows for a short dab on a long file", () => {
    const long = createConstantQMockSpectrogramData({ durationSeconds: 20, sampleRate: 48000, bandsPerOctave: 12 });
    // A 0.25 s dab over 12 semitones of the top octave.
    const frameStart = 10 * 48000;
    const frameEnd = frameStart + 0.25 * 48000;
    const lowBand = 2;
    const highBand = 16;
    const { ranges } = footprint(long, lowBand, highBand, { frameStart, frameEnd });
    let footprintPixels = 0;
    for (let i = 1; i < ranges.length; i += 2) footprintPixels += ranges[i];
    const firstPixel = long.metadata[lowBand * 4];
    const lastPixel = long.metadata[highBand * 4] + long.metadata[highBand * 4 + 1];
    const rowPixels =
      (Math.ceil(lastPixel / long.textureWidth) - Math.floor(firstPixel / long.textureWidth)) * long.textureWidth;
    expect(footprintPixels).toBeLessThan(rowPixels / 50);
  });
});

describe("whole-texture and row ranges", () => {
  it("cover the texture and the rows in one range each", () => {
    expect(fullTextureRange(64, 8)).toEqual({ ranges: new Uint32Array([0, 512]), count: 1 });
    expect(rowRange(64, 3, 2)).toEqual({ ranges: new Uint32Array([192, 128]), count: 1 });
  });
});
