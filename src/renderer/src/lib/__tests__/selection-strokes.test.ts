import { describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import type { Selection } from "../selection";
import { pasteStrokeState, regionAim, silenceStrokeState, type StrokeGeometry } from "../selection-strokes";

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

describe("silenceStrokeState", () => {
  it("builds one brush of one step sized exactly to the rectangle", () => {
    const state = silenceStrokeState(createMockState(), rect, makeGeometry());
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
    const state = silenceStrokeState(base, rect, makeGeometry());
    expect(state.filesSelection).toEqual({});
  });
});

describe("pasteStrokeState", () => {
  const source = { path: "clipboard://selection", timeFraction: 0.125, pitchFraction: 0.25 };

  it("samples the named source at a fixed offset through a passthrough", () => {
    const state = pasteStrokeState(createMockState(), rect, makeGeometry(), source);
    const step = state.brushes[0].steps[0];
    expect(step.effects).toEqual([{ id: "selection-paste", effect: "passthrough", enabled: true, params: {} }]);
    expect(step.sourceFile).toEqual({ path: source.path });
    expect(step.sourcePositionMode).toBe("fixed");
    expect(step.sourceTimeOffset).toBeCloseTo(12.5);
    expect(step.sourcePitchOffset).toBeCloseTo(25);
  });

  it("carries no selection, so a paste can land outside the one it came from", () => {
    const base = createMockState({ filesSelection: { "file-1": { ...rect, start: 8, end: 9 } } });
    const state = pasteStrokeState(base, rect, makeGeometry(), source);
    expect(state.filesSelection).toEqual({});
  });
});
