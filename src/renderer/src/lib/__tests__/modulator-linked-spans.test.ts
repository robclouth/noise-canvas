import { beforeAll, describe, expect, it } from "vitest";

import type { State } from "../../store/types";
import { createMockState } from "../../test/mock-state";
import {
  BRUSH_SPAN_BEATS_VALUE,
  BRUSH_SPAN_SEMIS_VALUE,
  GRID_SPAN_BEATS_VALUE,
  GRID_SPAN_SEMIS_VALUE,
  ONSETS_GRID_VALUE,
} from "../constants";

// A modulator rate or a sequencer loop set to Grid or Brush spans one grid cell
// or the whole brush, so it must resolve to exactly the same shader span as
// typing that size in by hand — and must follow the size as it changes.

const bpm = 120;
const totalDuration = 10;
// The app's default analysis, where a semitone is three bands: a span converted
// as if it were one band per semitone comes out three times short.
const bandsPerOctave = 36;
const numBands = 96;

let buildModulatorUniforms: typeof import("../modulator-utils").buildModulatorUniforms;

beforeAll(async () => {
  // The store has to initialise before anything that reads it at module scope.
  await import("../../store");
  ({ buildModulatorUniforms } = await import("../modulator-utils"));
});

function spans(overrides: Partial<State>) {
  const state = createMockState(overrides);
  const [modulator] = buildModulatorUniforms(bpm, totalDuration, bandsPerOctave, numBands, state);
  return {
    rateX: modulator.modulatorPatternRateX.value,
    rateY: modulator.modulatorPatternRateY.value,
    loopX: modulator.seqLoopX.value,
    loopY: modulator.seqLoopY.value,
  };
}

describe("grid-linked spans", () => {
  it("matches the same size typed in by hand", () => {
    const grid = spans({
      modulator1PatternRateBeats: GRID_SPAN_BEATS_VALUE,
      modulator1PatternRateSemis: GRID_SPAN_SEMIS_VALUE,
      gridSizeBeats: 2,
      gridSizeSemis: 24,
    });
    const typed = spans({ modulator1PatternRateBeats: 2, modulator1PatternRateSemis: 24 });
    expect(grid.rateX).toBe(typed.rateX);
    expect(grid.rateY).toBe(typed.rateY);
  });

  it("follows the grid as it changes", () => {
    const wide = spans({ modulator1PatternRateBeats: GRID_SPAN_BEATS_VALUE, gridSizeBeats: 4 });
    const narrow = spans({ modulator1PatternRateBeats: GRID_SPAN_BEATS_VALUE, gridSizeBeats: 1 / 2 });
    expect(wide.rateX).toBeCloseTo(narrow.rateX * 8, 10);
  });

  it("falls back to a fixed size where the grid has none of its own", () => {
    const onsets = spans({ modulator1PatternRateBeats: GRID_SPAN_BEATS_VALUE, gridSizeBeats: ONSETS_GRID_VALUE });
    expect(onsets.rateX).toBe(spans({ modulator1PatternRateBeats: 1 }).rateX);

    const scale = spans({ modulator1PatternRateSemis: GRID_SPAN_SEMIS_VALUE, gridSizeSemis: 0 });
    expect(scale.rateY).toBe(spans({ modulator1PatternRateSemis: 12 }).rateY);
  });
});

describe("brush-linked spans", () => {
  it("matches the brush's own size", () => {
    const brush = spans({
      modulator1PatternRateBeats: BRUSH_SPAN_BEATS_VALUE,
      modulator1PatternRateSemis: BRUSH_SPAN_SEMIS_VALUE,
      brushSizeTime: 2,
      brushSizePitch: 24,
    });
    const typed = spans({ modulator1PatternRateBeats: 2, modulator1PatternRateSemis: 24 });
    expect(brush.rateX).toBe(typed.rateX);
    expect(brush.rateY).toBe(typed.rateY);
  });

  it("follows a brush that is itself linked to the grid", () => {
    const linked = spans({
      modulator1PatternRateBeats: BRUSH_SPAN_BEATS_VALUE,
      brushSizeTime: 0,
      gridSizeBeats: 3,
    });
    expect(linked.rateX).toBe(spans({ modulator1PatternRateBeats: 3 }).rateX);
  });

  it("spans the whole file where the brush is Full", () => {
    const full = spans({
      modulator1PatternRateBeats: BRUSH_SPAN_BEATS_VALUE,
      modulator1PatternRateSemis: BRUSH_SPAN_SEMIS_VALUE,
      brushSizeTime: 32,
      brushSizePitch: 128,
    });
    expect(full.rateX).toBe(1);
    expect(full.rateY).toBe(1);
  });
});

describe("sequencer loops", () => {
  it("takes Grid and Brush on both axes", () => {
    const linked = spans({
      modulator1SeqLoopBeats: GRID_SPAN_BEATS_VALUE,
      modulator1SeqLoopSemis: BRUSH_SPAN_SEMIS_VALUE,
      gridSizeBeats: 2,
      brushSizePitch: 24,
    });
    const typed = spans({ modulator1SeqLoopBeats: 2, modulator1SeqLoopSemis: 24 });
    expect(linked.loopX).toBe(typed.loopX);
    expect(linked.loopY).toBe(typed.loopY);
  });

  it("measures a loop in the same space as a rate", () => {
    const both = spans({ modulator1SeqLoopBeats: 4, modulator1SeqLoopSemis: 24 });
    const rates = spans({ modulator1PatternRateBeats: 4, modulator1PatternRateSemis: 24 });
    expect(both.loopX).toBe(rates.rateX);
    expect(both.loopY).toBe(rates.rateY);
  });
});

describe("rate Off", () => {
  it("stays off", () => {
    const off = spans({ modulator1PatternRateBeats: 0, modulator1PatternRateSemis: 0, gridSizeBeats: 2 });
    expect(off.rateX).toBe(0);
    expect(off.rateY).toBe(0);
  });
});
