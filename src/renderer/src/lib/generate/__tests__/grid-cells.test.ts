import { ONSETS_GRID_VALUE } from "@renderer/lib/constants";
import type { Onset } from "@renderer/lib/onset-map";
import { C0_HZ } from "@renderer/lib/scale-snap";
import { describe, expect, it } from "vitest";
import { resolvePitchCells, resolveTimeCells, type PitchCellParams, type TimeCellParams } from "../grid-cells";

const timeParams = (overrides: Partial<TimeCellParams> = {}): TimeCellParams => ({
  gridSizeBeats: 1,
  gridSwing: 0,
  snapTime: true,
  bpm: 120,
  onsets: [],
  ...overrides,
});

const pitchParams = (overrides: Partial<PitchCellParams> = {}): PitchCellParams => ({
  gridSizeSemis: 12,
  snapPitch: true,
  scaleTonic: "C",
  scaleType: "major",
  minFreq: C0_HZ,
  ...overrides,
});

const starts = (cells: { start: number }[]) => cells.map((cell) => Number(cell.start.toFixed(6)));
const sizes = (cells: { size: number }[]) => cells.map((cell) => Number(cell.size.toFixed(6)));

describe("resolveTimeCells", () => {
  it("lays one cell per beat across the range", () => {
    // 120bpm makes a beat half a second, so four cells fill two seconds.
    const cells = resolveTimeCells({ min: 0, max: 2 }, timeParams());
    expect(starts(cells)).toEqual([0, 0.5, 1, 1.5]);
    expect(sizes(cells)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("alternates cell widths under swing", () => {
    const cells = resolveTimeCells({ min: 0, max: 2 }, timeParams({ gridSwing: 100 }));
    // Full swing delays every odd line by half a cell, so widths alternate 3:1.
    expect(sizes(cells)).toEqual([0.75, 0.25, 0.75, 0.25]);
  });

  it("collapses to one cell when time snap is off", () => {
    const cells = resolveTimeCells({ min: 1, max: 3 }, timeParams({ snapTime: false }));
    expect(cells).toEqual([{ start: 1, size: 2 }]);
  });

  it("gives each onset the span up to the next", () => {
    const onsets: Onset[] = [
      { timeSec: 0.2, strength: 1 },
      { timeSec: 0.9, strength: 1 },
      { timeSec: 1.4, strength: 1 },
    ];
    const cells = resolveTimeCells({ min: 0, max: 2 }, timeParams({ gridSizeBeats: ONSETS_GRID_VALUE, onsets }));
    expect(starts(cells)).toEqual([0.2, 0.9, 1.4]);
    expect(sizes(cells)).toEqual([0.7, 0.5, 0.6]);
  });

  it("keeps onsets outside the range out of the fill", () => {
    const onsets: Onset[] = [
      { timeSec: 0.1, strength: 1 },
      { timeSec: 1.0, strength: 1 },
      { timeSec: 5.0, strength: 1 },
    ];
    const cells = resolveTimeCells({ min: 0.5, max: 2 }, timeParams({ gridSizeBeats: ONSETS_GRID_VALUE, onsets }));
    expect(starts(cells)).toEqual([1]);
  });

  it("covers a range that starts mid-cell", () => {
    const cells = resolveTimeCells({ min: 0.75, max: 1.6 }, timeParams());
    // The cell holding 0.75 starts at 0.5, so the fill reaches back to cover it.
    expect(starts(cells)).toEqual([0.5, 1, 1.5]);
  });
});

describe("resolvePitchCells", () => {
  it("lays one cell per grid interval", () => {
    const cells = resolvePitchCells({ min: 0, max: 36 }, pitchParams());
    expect(starts(cells)).toEqual([0, 12, 24]);
    expect(sizes(cells)).toEqual([12, 12, 12]);
  });

  it("collapses to one cell when pitch snap is off", () => {
    const cells = resolvePitchCells({ min: 0, max: 48 }, pitchParams({ snapPitch: false }));
    expect(cells).toEqual([{ start: 0, size: 48 }]);
  });

  it("walks the scale's notes when the pitch grid is set to Scale", () => {
    const cells = resolvePitchCells({ min: 0, max: 12 }, pitchParams({ gridSizeSemis: 0 }));
    // C major from C0: the seven notes of the octave, with tone and semitone gaps.
    expect(starts(cells)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(sizes(cells)).toEqual([2, 2, 1, 2, 2, 2, 1]);
  });

  it("places scale notes against the file's own lowest frequency", () => {
    // A file analysed from D0 sits its lowest band on D, which is in C major, so
    // the fill starts there and steps to E. The bottom band reaches the scale
    // through a log, so this also covers a note landing a hair below the range.
    const dZero = C0_HZ * Math.pow(2, 2 / 12);
    const cells = resolvePitchCells({ min: 0, max: 12 }, pitchParams({ gridSizeSemis: 0, minFreq: dZero }));
    expect(starts(cells)[0]).toBeCloseTo(0, 5);
    expect(starts(cells)[1]).toBeCloseTo(2, 5);
  });

  it("follows the selected scale rather than assuming major", () => {
    const cells = resolvePitchCells({ min: 0, max: 12 }, pitchParams({ gridSizeSemis: 0, scaleType: "minor" }));
    expect(starts(cells)).toEqual([0, 2, 3, 5, 7, 8, 10]);
  });
});
