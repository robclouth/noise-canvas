import { describe, expect, it } from "vitest";

import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import type { ReachContext } from "../effect-reach";
import {
  liveReadRefusal,
  overReachNeeds,
  overReachRefusal,
  strokeRefusal,
  wholeBrushRefusal,
} from "../whole-file-gate";

// A 60-second file at 120 bpm, on a canvas holding 16 seconds of it.
const CTX: ReachContext = { bpm: 120, fileSeconds: 60, canvasSeconds: 16, bandsPerOctave: 24, numBands: 240 };

function stateOf(...steps: Array<Partial<TestBrushStep>>) {
  return createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides })));
}

describe("overReachNeeds", () => {
  function reachStep(overrides: Partial<TestBrushStep>): Partial<TestBrushStep> {
    return { ...overrides, effects: [{ id: "mock-transform", effect: "transform", enabled: true, params: {} }] };
  }

  it("finds nothing while the brush and its reach fit the canvas", () => {
    // A four-beat shift is two seconds, well inside the sixteen the canvas holds.
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 4, transformEdgeMode: 1 })), CTX)).toEqual([]);
  });

  it("names an effect that reads further than the canvas holds around one block", () => {
    // Twenty beats is ten seconds either side, more than the sixteen the canvas holds.
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 20, transformEdgeMode: 1 })), CTX)).toEqual([
      "Transform",
    ]);
    // Twelve beats is six seconds either side: with a two-second block, fourteen fit.
    const blocks = { ...CTX, blockSeconds: 2 };
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 12, transformEdgeMode: 1 })), blocks)).toEqual([]);
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 16, transformEdgeMode: 1 })), blocks)).toEqual([
      "Transform",
    ]);
  });

  it("finds nothing when the edge mode keeps the read inside the brush", () => {
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 16, transformEdgeMode: 0 })), CTX)).toEqual([]);
  });
});

describe("strokeRefusal", () => {
  it("says nothing while the canvas holds the whole file", () => {
    const state = stateOf({ sourceTimeOffset: 20 });
    expect(strokeRefusal(state, null)).toBeNull();
  });

  it("says nothing for a brush a window can serve", () => {
    expect(strokeRefusal(stateOf({}), CTX)).toBeNull();
  });

  it("lets a step read this file anywhere: a window of its own serves it", () => {
    expect(strokeRefusal(stateOf({ sourceTimeOffset: 20 }), CTX)).toBeNull();
    expect(strokeRefusal(stateOf({ sourcePositionMode: "fixed" }), CTX)).toBeNull();
  });

  it("reports a reach the canvas cannot hold", () => {
    const state = stateOf({
      transformShiftBeats: 20,
      transformEdgeMode: 1,
      effects: [{ id: "mock-transform", effect: "transform", enabled: true, params: {} }],
    });
    expect(strokeRefusal(state, CTX)).toBe("Transform reaches too far for this file. Turn it down to paint here.");
  });
});

describe("wholeBrushRefusal", () => {
  it("names what reads across the brush and agrees the verb with it", () => {
    expect(wholeBrushRefusal(["Transform"])).toBe(
      "Transform reads across the whole brush, and this brush is too long for this file. Shorten it to paint here.",
    );
    expect(wholeBrushRefusal(["Transform", "Sort"])).toBe(
      "Transform and Sort read across the whole brush, and this brush is too long for this file. Shorten it to paint here.",
    );
  });

  it("names Accumulate when the brush builds up on its own paint", () => {
    expect(liveReadRefusal()).toBe(
      "Accumulate reads what the brush has just painted, and this brush is too long for this file. Shorten it to paint here.",
    );
  });
});

describe("overReachRefusal", () => {
  it("reads as one sentence for a single effect", () => {
    expect(overReachRefusal(["Blur"])).toBe("Blur reaches too far for this file. Turn it down to paint here.");
  });

  it("joins several effects and agrees the verb with them", () => {
    expect(overReachRefusal(["Blur", "Repeat"])).toBe(
      "Blur and Repeat reach too far for this file. Turn them down to paint here.",
    );
  });
});
