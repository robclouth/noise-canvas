import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  alignWindow,
  bandOfFilePixel,
  buildWindowInverseMap,
  buildWindowLayout,
  buildWindowMetadata,
  fileLayoutOf,
  frameSpanOfRanges,
  layoutPixelCount,
  mapFileRangesToWindow,
  windowAlignment,
  windowFileRanges,
  type PackedLayout,
} from "../window-layout";
import { applyCoefficientPatch } from "../coef-patch";
import { gatherPixelRanges } from "../pixel-ranges";

function mockFile(durationSeconds = 4): {
  data: ReturnType<typeof createConstantQMockSpectrogramData>;
  layout: PackedLayout;
} {
  const data = createConstantQMockSpectrogramData({ durationSeconds, sampleRate: 8000, bandsPerOctave: 4 });
  return { data, layout: fileLayoutOf(data) };
}

describe("windowAlignment", () => {
  it("is the coarsest band's bin width", () => {
    const { layout } = mockFile();
    let maxStep = 0;
    for (let b = 0; b < layout.numBands; b++) maxStep = Math.max(maxStep, layout.bandStepLog2s[b]);
    expect(windowAlignment(layout)).toBe(2 ** maxStep);
  });
});

describe("alignWindow", () => {
  const { layout } = mockFile();
  const align = windowAlignment(layout);

  it("widens both edges to the alignment", () => {
    const span = alignWindow(layout, align + 1, align * 3 - 1);
    expect(span.startFrame % align).toBe(0);
    expect(span.endFrame % align).toBe(0);
    expect(span.startFrame).toBeLessThanOrEqual(align + 1);
    expect(span.endFrame).toBeGreaterThanOrEqual(align * 3 - 1);
  });

  it("always spans at least one alignment block", () => {
    for (const start of [0, 1, layout.numFrames - 1, layout.numFrames * 2]) {
      const span = alignWindow(layout, start, start);
      expect(span.endFrame - span.startFrame).toBeGreaterThanOrEqual(align);
      expect(span.startFrame).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildWindowLayout", () => {
  it("reproduces the file layout for a whole-file window", () => {
    const { layout } = mockFile();
    const window = buildWindowLayout(layout, 0, layout.numFrames);
    expect(Array.from(window.bandOffsets)).toEqual(Array.from(layout.bandOffsets));
    expect(Array.from(window.bandLengths)).toEqual(Array.from(layout.bandLengths));
    expect(window.textureWidth).toBe(layout.textureWidth);
    expect(window.textureHeight).toBe(layout.textureHeight);
    expect(Array.from(window.firstBins)).toEqual(new Array(layout.numBands).fill(0));
  });

  it("gives every band at least one bin", () => {
    const { layout } = mockFile();
    const align = windowAlignment(layout);
    for (let start = 0; start < layout.numFrames; start += align) {
      const window = buildWindowLayout(layout, start, start + align);
      for (let b = 0; b < layout.numBands; b++) {
        expect(window.bandLengths[b]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("puts every band's first bin at startFrame >> stepLog2", () => {
    const { layout } = mockFile();
    const window = buildWindowLayout(layout, layout.numFrames * 0.3, layout.numFrames * 0.6);
    for (let b = 0; b < layout.numBands; b++) {
      expect(window.firstBins[b]).toBe(window.startFrame >> layout.bandStepLog2s[b]);
    }
  });

  // The exactness claim the whole design rests on: a shader that subtracts the
  // window origin before the band scale lands on the same bin the file layout
  // would have chosen.
  it("addresses the same bin as the file for every frame in the window", () => {
    const { layout } = mockFile();
    const window = buildWindowLayout(layout, layout.numFrames * 0.25, layout.numFrames * 0.75);
    for (let b = 0; b < layout.numBands; b++) {
      const step = 2 ** layout.bandStepLog2s[b];
      for (let frame = window.startFrame; frame < window.endFrame; frame++) {
        const fileBin = Math.floor(frame / step);
        if (fileBin >= layout.bandLengths[b]) continue;
        const windowBin = Math.floor((frame - window.startFrame) / step);
        expect(windowBin).toBe(fileBin - window.firstBins[b]);
        expect(windowBin).toBeLessThan(window.bandLengths[b]);
      }
    }
  });

  it("sizes the texture by the analyser's own rule", () => {
    const { layout } = mockFile();
    const window = buildWindowLayout(layout, 0, layout.numFrames / 4);
    const pixels = layoutPixelCount(window);
    expect(window.textureWidth).toBe(Math.min(8192, pixels));
    expect(window.textureWidth * window.textureHeight).toBeGreaterThanOrEqual(pixels);
    expect(pixels).toBeLessThan(layoutPixelCount(layout));
  });
});

describe("buildWindowMetadata", () => {
  it("writes the window in row 0 and the file's geometry in row 1", () => {
    const { data, layout } = mockFile();
    const window = buildWindowLayout(layout, layout.numFrames / 2, layout.numFrames);
    const meta = buildWindowMetadata(window, data.metadata);
    expect(meta.length).toBe(layout.numBands * 2 * 4);

    for (let b = 0; b < layout.numBands; b++) {
      expect(meta[b * 4 + 0]).toBe(window.bandOffsets[b]);
      expect(meta[b * 4 + 1]).toBe(window.bandLengths[b]);
      expect(meta[b * 4 + 2]).toBe(window.bandStepLog2s[b]);
      expect(meta[b * 4 + 3]).toBe(data.metadata[b * 4 + 3]);

      const row1 = (layout.numBands + b) * 4;
      expect(meta[row1 + 0]).toBe(window.startFrame);
      expect(meta[row1 + 1]).toBe(layout.bandLengths[b]);
      expect(meta[row1 + 2]).toBe(layout.bandOffsets[b]);
    }
  });
});

describe("buildWindowInverseMap", () => {
  it("holds file frames, not window frames", () => {
    const { data, layout } = mockFile();
    const window = buildWindowLayout(layout, layout.numFrames / 2, layout.numFrames);
    const map = buildWindowInverseMap(window);

    for (let b = 0; b < layout.numBands; b++) {
      const windowPixel = window.bandOffsets[b];
      const filePixel = layout.bandOffsets[b] + window.firstBins[b];
      expect(map[windowPixel * 2 + 0]).toBe(data.inverseMap[filePixel * 2 + 0]);
      expect(map[windowPixel * 2 + 1]).toBe(b);
      expect(map[windowPixel * 2 + 0]).toBeGreaterThanOrEqual(window.startFrame);
    }
  });
});

describe("windowFileRanges", () => {
  it("gathers exactly the window's pixels out of the file array", () => {
    const { data, layout } = mockFile();
    const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);
    const ranges = windowFileRanges(window);
    const gathered = gatherPixelRanges(data.packedData, ranges);
    expect(gathered.length).toBe(layoutPixelCount(window) * 4);

    for (let b = 0; b < layout.numBands; b++) {
      const filePixel = layout.bandOffsets[b] + window.firstBins[b];
      const windowPixel = window.bandOffsets[b];
      expect(gathered[windowPixel * 4]).toBe(data.packedData[filePixel * 4]);
    }
  });
});

describe("mapFileRangesToWindow", () => {
  const { layout } = mockFile();
  const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);

  function totalCount(ranges: Uint32Array, stride: number): number {
    let total = 0;
    for (let i = 0; i < ranges.length; i += stride) total += ranges[i + stride - 1];
    return total;
  }

  it("splits a whole band into before, inside and after", () => {
    const band = 0;
    const ranges = Uint32Array.of(layout.bandOffsets[band], layout.bandLengths[band]);
    const { mapped, outside } = mapFileRangesToWindow(window, ranges);

    expect(totalCount(mapped, 3) + totalCount(outside, 2)).toBe(layout.bandLengths[band]);
    expect(totalCount(mapped, 3)).toBe(window.bandLengths[band]);
    expect(mapped[0]).toBe(layout.bandOffsets[band] + window.firstBins[band]);
    expect(mapped[1]).toBe(window.bandOffsets[band]);
  });

  it("maps the whole file when the window is the whole file", () => {
    const full = buildWindowLayout(layout, 0, layout.numFrames);
    const ranges = windowFileRanges(full);
    const { mapped, outside } = mapFileRangesToWindow(full, ranges);
    expect(outside.length).toBe(0);
    for (let i = 0; i < mapped.length; i += 3) expect(mapped[i]).toBe(mapped[i + 1]);
  });

  it("reports a range wholly outside the window as a miss, never a clamp", () => {
    const band = 0;
    const outsideStart = layout.bandOffsets[band] + window.firstBins[band] + window.bandLengths[band];
    const ranges = Uint32Array.of(outsideStart, 4);
    const { mapped, outside } = mapFileRangesToWindow(window, ranges);
    expect(mapped.length).toBe(0);
    expect(Array.from(outside)).toEqual([outsideStart, 4]);
  });

  it("keeps every mapped pixel inside its band's window span", () => {
    const ranges = Uint32Array.of(0, layoutPixelCount(layout));
    const { mapped } = mapFileRangesToWindow(window, ranges);
    for (let i = 0; i < mapped.length; i += 3) {
      const band = bandOfFilePixel(layout, mapped[i]);
      const start = window.bandOffsets[band];
      expect(mapped[i + 1]).toBeGreaterThanOrEqual(start);
      expect(mapped[i + 1] + mapped[i + 2]).toBeLessThanOrEqual(start + window.bandLengths[band]);
    }
  });
});

describe("frameSpanOfRanges", () => {
  it("agrees with the patch extent's own arithmetic", () => {
    const { data, layout } = mockFile();
    const band = 3;
    const k0 = 5;
    const count = 9;
    const patch = { ranges: Uint32Array.of(band, k0, count) };
    const extent = applyCoefficientPatch(data.packedData, patch, layout.bandOffsets, layout.bandStepLog2s);
    expect(extent).not.toBeNull();

    const span = frameSpanOfRanges(layout, extent!.pixelRanges);
    expect(span.startFrame).toBe(extent!.minFrame);
    expect(span.endFrame).toBe(Math.min(extent!.maxFrame, layout.numFrames));
  });

  it("gives an empty span for empty ranges", () => {
    const { layout } = mockFile();
    expect(frameSpanOfRanges(layout, new Uint32Array(0))).toEqual({ startFrame: 0, endFrame: 0 });
  });
});
