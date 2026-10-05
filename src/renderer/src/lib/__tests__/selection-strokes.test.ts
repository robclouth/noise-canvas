import { describe, expect, it } from "vitest";
import { NEUTRAL_ALGORITHM } from "../constants";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { maskFromCells, type Selection, type SelectionMask } from "../selection";
import { pasteStrokes, regionAim, regionParts, silenceStrokes, type StrokeGeometry } from "../selection-strokes";
import { BRUSH_SIZE_TIME_FULL } from "../utils";

/** The state of the one stroke a region short enough for one brush makes. */
function only<T extends { state: unknown }>(strokes: T[]): T["state"] {
  expect(strokes).toHaveLength(1);
  return strokes[0].state;
}

const rect: Selection = { start: 1, end: 2, pitchLo: 0.25, pitchHi: 0.5 };

function makeGeometry(): StrokeGeometry {
  // 128 bands at 24 per octave: 2 bands per semitone. 120 bpm: 0.5 s per beat.
  const spec = createMockSpectrogramData({ numBands: 128, bandsPerOctave: 24 });
  return { bpm: 120, totalDuration: 10, spec };
}

describe("regionAim", () => {
  it("aims at the rectangle's bottom-left corner in UV", () => {
    const aim = regionAim(rect, makeGeometry());
    expect(aim.aimX).toBeCloseTo(0.1);
    expect(aim.aimY).toBe(rect.pitchLo);
  });
});

describe("silenceStrokes", () => {
  it("builds one brush of one step sized exactly to the rectangle", () => {
    const state = only(silenceStrokes(createMockState(), rect, makeGeometry(), "file-1"));
    expect(state.brushes).toHaveLength(1);
    expect(state.activeBrushIndex).toBe(0);
    const step = state.brushes[0].steps[0];
    expect(step.brushSizeTime).toBeCloseTo(2);
    expect(step.brushSizePitch).toBeCloseTo(16);
    expect(step.brushIterations).toBe(1);
    expect(step.accumulate).toBe(false);
    expect(step.effects).toEqual([
      { id: "selection-silence", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -80 } },
    ]);
  });

  it("carries no selection, so the stroke is never clipped to one", () => {
    const base = createMockState({ filesSelection: { "file-1": rect } });
    const state = only(silenceStrokes(base, rect, makeGeometry(), "file-1"));
    expect(state.filesSelection).toEqual({});
  });

  it("keeps a masked rectangle as the stroke's own clip", () => {
    const mask: SelectionMask = maskFromCells(4, 2, [255, 0, 0, 255, 0, 255, 255, 0]);
    const masked: Selection = { ...rect, mask };
    const state = only(silenceStrokes(createMockState(), masked, makeGeometry(), "file-1"));
    expect(state.filesSelection).toEqual({ "file-1": masked });
  });
});

describe("pasteStrokes", () => {
  const source = { path: "clipboard://selection", timeFraction: 0.125, pitchFraction: 0.25, secondsPerFraction: 40 };

  it("samples the named source at a fixed offset through a passthrough", () => {
    const state = only(pasteStrokes(createMockState(), rect, makeGeometry(), source, "file-1"));
    const step = state.brushes[0].steps[0];
    expect(step.effects).toEqual([{ id: "selection-paste", effect: "passthrough", enabled: true, params: {} }]);
    expect(step.sourceFile).toEqual({ path: source.path });
    expect(step.sourcePositionMode).toBe("fixed");
    expect(step.sourceTimeOffset).toBeCloseTo(12.5);
    expect(step.sourcePitchOffset).toBeCloseTo(25);
  });

  it("pins the faithful warp, whatever the step default becomes", () => {
    const state = only(pasteStrokes(createMockState(), rect, makeGeometry(), source, "file-1"));
    expect(state.brushes[0].steps[0].algorithm).toBe(NEUTRAL_ALGORITHM);
  });

  it("carries no selection, so a paste can land outside the one it came from", () => {
    const base = createMockState({ filesSelection: { "file-1": { ...rect, start: 8, end: 9 } } });
    const state = only(pasteStrokes(base, rect, makeGeometry(), source, "file-1"));
    expect(state.filesSelection).toEqual({});
  });

  it("keeps a masked drop rectangle as the paste's own clip", () => {
    const mask: SelectionMask = maskFromCells(2, 1, [255, 0]);
    const masked: Selection = { ...rect, mask };
    const state = only(pasteStrokes(createMockState(), masked, makeGeometry(), source, "file-1"));
    expect(state.filesSelection).toEqual({ "file-1": masked });
  });
});

describe("regionParts", () => {
  it("keeps a region a brush can span whole", () => {
    expect(regionParts(rect, makeGeometry())).toEqual([rect]);
  });

  it("cuts a region longer than any brush into equal parts none of them the whole file", () => {
    // Forty seconds at 120 bpm is eighty beats: three parts of about twenty-seven.
    const long: Selection = { start: 2, end: 42, pitchLo: 0.25, pitchHi: 0.5 };
    const parts = regionParts(long, makeGeometry());
    expect(parts).toHaveLength(3);
    expect(parts[0].start).toBe(2);
    expect(parts[2].end).toBe(42);
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBeCloseTo(parts[i - 1].end, 9);
    for (const stroke of silenceStrokes(createMockState(), long, makeGeometry(), "file-1")) {
      expect(stroke.state.brushes[0].steps[0].brushSizeTime).toBeLessThan(BRUSH_SIZE_TIME_FULL);
    }
  });

  it("reads each part of a long paste as far into the clipboard as it starts into the region", () => {
    const long: Selection = { start: 2, end: 42, pitchLo: 0.25, pitchHi: 0.5 };
    const source = { path: "clipboard://selection", timeFraction: 0.1, pitchFraction: 0.25, secondsPerFraction: 80 };
    const strokes = pasteStrokes(createMockState(), long, makeGeometry(), source, "file-1");
    expect(strokes).toHaveLength(3);
    for (const stroke of strokes) {
      const expected = 0.1 + (stroke.rect.start - long.start) / 80;
      expect(stroke.state.brushes[0].steps[0].sourceTimeOffset).toBeCloseTo(expected * 100, 9);
    }
  });

  it("clips every part of a masked region to the whole rectangle, so the mask lands as drawn", () => {
    const mask: SelectionMask = maskFromCells(2, 1, [255, 0]);
    const long: Selection = { start: 2, end: 42, pitchLo: 0.25, pitchHi: 0.5, mask };
    for (const stroke of silenceStrokes(createMockState(), long, makeGeometry(), "file-1")) {
      expect(stroke.state.filesSelection).toEqual({ "file-1": long });
    }
  });
});
