import { describe, expect, it } from "vitest";

import {
  constantQBandLayout,
  constantQMetadata,
  createConstantQMockSpectrogramData,
} from "../../test/mock-spectrogram";
import {
  DISPLAY_PYRAMID_BYTES_PER_TEXEL,
  displayLevelChoice,
  displayPyramidBudgetTexels,
  displayPyramidBytes,
  displayPyramidLevel,
  displayPyramidLevels,
  levelBinCount,
  levelBinSpan,
  levelDecimation,
  sourceBinRanges,
  type BandLayout,
} from "../display-pyramid";

/** A constant-Q layout of any length, without the coefficient arrays. */
function layoutOf(durationSeconds: number, bandsPerOctave = 24): BandLayout {
  const bands = constantQBandLayout({ durationSeconds, bandsPerOctave });
  return { numBands: bands.numBands, metadata: constantQMetadata(bands, { bandsPerOctave }) };
}

describe("display pyramid layout", () => {
  it("reproduces the source layout at level 0", () => {
    const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 4 });
    const level = displayPyramidLevel({ numBands: data.numBands, metadata: data.metadata }, 0);
    expect(Array.from(level.metadata)).toEqual(Array.from(data.metadata));
    expect(level.textureWidth).toBe(data.textureWidth);
    expect(level.textureHeight).toBe(data.textureHeight);
  });

  it("holds a band unchanged until the level step passes the band's own", () => {
    const layout = layoutOf(4, 8);
    // Band 8 sits one octave down, so its own step is 2^1 frames.
    const ownStep = layout.metadata[8 * 4 + 2];
    expect(ownStep).toBe(1);
    const bins = layout.metadata[8 * 4 + 1];
    expect(levelBinCount(layout.metadata, 8, 0)).toBe(bins);
    expect(levelBinCount(layout.metadata, 8, 1)).toBe(bins);
    expect(levelBinCount(layout.metadata, 8, 2)).toBe(Math.ceil(bins / 2));
    expect(levelBinCount(layout.metadata, 8, 3)).toBe(Math.ceil(bins / 4));
  });

  it("halves every band that a step reaches, level over level", () => {
    const layout = layoutOf(4, 8);
    for (let step = 0; step < 12; step++) {
      for (let band = 0; band < layout.numBands; band++) {
        const here = levelBinCount(layout.metadata, band, step);
        const next = levelBinCount(layout.metadata, band, step + 1);
        const expected = step < layout.metadata[band * 4 + 2] ? here : Math.ceil(here / 2);
        expect(next).toBe(expected);
      }
    }
  });

  it("packs each level's bands back to back", () => {
    const layout = layoutOf(4, 8);
    const level = displayPyramidLevel(layout, 3);
    let offset = 0;
    for (let band = 0; band < layout.numBands; band++) {
      expect(level.metadata[band * 4]).toBe(offset);
      offset += level.metadata[band * 4 + 1];
    }
    expect(level.texelCount).toBeGreaterThanOrEqual(offset);
  });

  it("runs consecutive levels down to a single bin per band", () => {
    const levels = displayPyramidLevels(layoutOf(4, 8));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].stepLog2).toBe(levels[i - 1].stepLog2 + 1);
    }
    const last = levels[levels.length - 1];
    for (let band = 0; band < last.metadata.length / 4; band++) {
      expect(last.metadata[band * 4 + 1]).toBe(1);
    }
  });

  it("drops the finest levels until the stack fits the cap", () => {
    const layout = layoutOf(4, 8);
    const full = displayPyramidLevels(layout, Number.MAX_SAFE_INTEGER);
    const capped = displayPyramidLevels(
      layout,
      Math.floor(displayPyramidBytes(full) / DISPLAY_PYRAMID_BYTES_PER_TEXEL / 8),
    );
    expect(capped.length).toBeLessThan(full.length);
    expect(capped[0].stepLog2).toBeGreaterThan(full[0].stepLog2);
    expect(capped[capped.length - 1].stepLog2).toBe(full[full.length - 1].stepLog2);
  });

  it("keeps the same cost as the file grows, by starting coarser", () => {
    const cap = 200_000;
    const short = displayPyramidLevels(layoutOf(10), cap);
    const long = displayPyramidLevels(layoutOf(600), cap);
    expect(displayPyramidBytes(short)).toBeLessThanOrEqual(cap * DISPLAY_PYRAMID_BYTES_PER_TEXEL);
    expect(displayPyramidBytes(long)).toBeLessThanOrEqual(cap * DISPLAY_PYRAMID_BYTES_PER_TEXEL);
    expect(long[0].stepLog2).toBeGreaterThan(short[0].stepLog2);
  });

  it("never drops the coarsest level, however small the cap", () => {
    const levels = displayPyramidLevels(layoutOf(4, 8), 1);
    expect(levels).toHaveLength(1);
    expect(levels[0].metadata[1]).toBe(1);
  });

  it("never outgrows the bound the budget charges it at", () => {
    for (const seconds of [2, 10, 60, 600]) {
      const layout = layoutOf(seconds);
      const uncapped = displayPyramidLevels(layout, Number.MAX_SAFE_INTEGER);
      const packed = uncapped[0].texelCount;
      const actual = uncapped.reduce((sum, level) => sum + level.texelCount, 0);
      expect(actual).toBeLessThanOrEqual(displayPyramidBudgetTexels(packed, Number.MAX_SAFE_INTEGER));

      const cap = 100_000;
      const capped = displayPyramidLevels(layout, cap);
      expect(capped.reduce((sum, level) => sum + level.texelCount, 0)).toBeLessThanOrEqual(
        displayPyramidBudgetTexels(packed, cap),
      );
    }
  });

  it("counts bytes at the half-float pair rate", () => {
    const levels = displayPyramidLevels(layoutOf(4, 8));
    const texels = levels.reduce((sum, level) => sum + level.texelCount, 0);
    expect(displayPyramidBytes(levels)).toBe(texels * DISPLAY_PYRAMID_BYTES_PER_TEXEL);
  });
});

describe("display level choice", () => {
  // Capped, so the finest level's step is well above zero and the choice has
  // to measure density against that base rather than against level 0.
  const levels = displayPyramidLevels(layoutOf(20, 8), 40_000);

  it("starts above the source's finest step", () => {
    expect(levels[0].stepLog2).toBeGreaterThan(0);
  });

  it("picks the level whose step matches the screen density", () => {
    for (let step = levels[0].stepLog2; step < levels[0].stepLog2 + 6; step++) {
      const choice = displayLevelChoice(levels, 2 ** step);
      expect(levels[choice.fine].stepLog2).toBe(step);
      expect(choice.blend).toBeCloseTo(0, 6);
    }
  });

  it("blends toward the coarser level between two steps", () => {
    const step = levels[0].stepLog2 + 3;
    const choice = displayLevelChoice(levels, 2 ** step * Math.SQRT2);
    expect(levels[choice.fine].stepLog2).toBe(step);
    expect(levels[choice.coarse].stepLog2).toBe(step + 1);
    expect(choice.blend).toBeCloseTo(0.5, 6);
  });

  it("holds the finest level when the view is zoomed past it", () => {
    const choice = displayLevelChoice(levels, 0.25);
    expect(choice.fine).toBe(0);
    expect(choice.blend).toBe(0);
  });

  it("holds the coarsest level when the view is zoomed out past it", () => {
    const choice = displayLevelChoice(levels, 2 ** 40);
    expect(choice.fine).toBe(levels.length - 1);
    expect(choice.coarse).toBe(levels.length - 1);
    expect(choice.blend).toBe(0);
  });
});

describe("patch range mapping", () => {
  const layout = layoutOf(4, 8);
  const bandOf = (band: number) => ({
    offset: layout.metadata[band * 4],
    length: layout.metadata[band * 4 + 1],
  });

  it("names only the bands a range reaches", () => {
    const { offset, length } = bandOf(5);
    const spans = sourceBinRanges(layout, Uint32Array.of(offset + 10, Math.min(20, length - 10)));
    for (let band = 0; band < layout.numBands; band++) {
      const empty = spans[band * 2 + 1] <= spans[band * 2];
      expect(empty).toBe(band !== 5);
    }
  });

  it("covers the bins a range touches, with room to spare", () => {
    const { offset, length } = bandOf(5);
    expect(length).toBeGreaterThan(40);
    const spans = sourceBinRanges(layout, Uint32Array.of(offset + 10, 20));
    expect(spans[10]).toBeLessThan(10);
    expect(spans[11]).toBeGreaterThan(30);
  });

  it("holds the widened span inside the band", () => {
    const { offset, length } = bandOf(3);
    const spans = sourceBinRanges(layout, Uint32Array.of(offset, length));
    expect(spans[6]).toBe(0);
    expect(spans[7]).toBe(length);
  });

  it("reaches every band a range crosses", () => {
    const low = bandOf(2);
    const high = bandOf(4);
    const spans = sourceBinRanges(
      layout,
      Uint32Array.of(low.offset + low.length - 5, high.offset + 5 - (low.offset + low.length - 5)),
    );
    for (const band of [2, 3, 4]) expect(spans[band * 2 + 1]).toBeGreaterThan(spans[band * 2]);
    expect(spans[1 * 2 + 1]).toBe(spans[1 * 2]);
    expect(spans[5 * 2 + 1]).toBe(spans[5 * 2]);
  });

  it("merges two ranges in one band into a single span", () => {
    const { offset, length } = bandOf(6);
    expect(length).toBeGreaterThan(120);
    const spans = sourceBinRanges(layout, Uint32Array.of(offset + 10, 10, offset + 100, 10));
    expect(spans[12]).toBeLessThanOrEqual(10);
    expect(spans[13]).toBeGreaterThanOrEqual(110);
  });

  it("ignores empty ranges", () => {
    const spans = sourceBinRanges(layout, Uint32Array.of(bandOf(2).offset, 0));
    expect(spans.every((value) => value === 0)).toBe(true);
  });

  it("carries a source span straight through at the finest step", () => {
    const level = displayPyramidLevel(layout, 0);
    expect(levelDecimation(level, layout.metadata[4 * 4 + 2], 4)).toBe(1);
    expect(levelBinSpan(level, 4, layout.metadata[4 * 4 + 2], 7, 33)).toEqual({ start: 7, end: 33 });
  });

  it("divides a source span by the level's stride", () => {
    const level = displayPyramidLevel(layout, 6);
    const stride = levelDecimation(level, layout.metadata[0 * 4 + 2], 0);
    expect(stride).toBe(64);
    // A level bin reads the source bin at its own index times the stride, so a
    // span starts at the first such bin inside it, not at the one before.
    expect(levelBinSpan(level, 0, layout.metadata[0 * 4 + 2], 65, 200)).toEqual({ start: 2, end: 4 });
    expect(levelBinSpan(level, 0, layout.metadata[0 * 4 + 2], 64, 200)).toEqual({ start: 1, end: 4 });
  });

  it("clamps a span to the bins the level holds", () => {
    const level = displayPyramidLevel(layout, 6);
    const bins = level.metadata[1];
    const span = levelBinSpan(level, 0, layout.metadata[2], 0, layout.metadata[1] * 4);
    expect(span.end).toBe(bins);
  });
});
