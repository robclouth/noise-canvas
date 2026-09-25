import { describe, expect, it } from "vitest";

import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import type { ReachContext } from "../effect-reach";
import { BRUSH_SIZE_TIME_FULL } from "../utils";
import { overReachNeeds, overReachRefusal, strokeRefusal, wholeFileNeeds, wholeFileRefusal } from "../whole-file-gate";

// A 60-second file at 120 bpm, on a canvas holding 16 seconds of it.
const CTX: ReachContext = { bpm: 120, fileSeconds: 60, canvasSeconds: 16, bandsPerOctave: 24, numBands: 240 };

function stateOf(...steps: Array<Partial<TestBrushStep>>) {
  return createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides })));
}

function needsOf(...steps: Array<Partial<TestBrushStep>>): string[] {
  return wholeFileNeeds(createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides }))));
}

function withEffect(effect: string): Partial<TestBrushStep> {
  return { effects: [{ id: `mock-${effect}`, effect, enabled: true, params: {} }] };
}

describe("wholeFileNeeds", () => {
  it("finds nothing in a brush that reads only around itself", () => {
    expect(needsOf({})).toEqual([]);
  });

  it.each([0, 1, 2, 3])("leaves wrap mode %s alone: a wrapped dab is painted at both ends", (wrapMode) => {
    expect(needsOf({ brushWrapMode: wrapMode })).toEqual([]);
  });

  it("leaves a brush as long as the file alone: it is painted a window at a time", () => {
    expect(needsOf({ brushSizeTime: BRUSH_SIZE_TIME_FULL })).toEqual([]);
  });

  // Every effect reads a span around the brush that its own settings bound,
  // which `effect-reach.ts` declares and the canvas holds.
  it.each(["attract", "blur", "clone", "convolve", "dynamics", "evolve", "sort", "transform", "transmute"])(
    "leaves %s alone",
    (effect) => {
      expect(needsOf(withEffect(effect))).toEqual([]);
    },
  );

  it("reads every step of the brush, not only the active one", () => {
    expect(needsOf({}, { sourceTimeOffset: 20 })).toEqual(["A source time offset"]);
  });

  it("names each thing once, however many steps ask for it", () => {
    expect(needsOf({ sourceTimeOffset: 20 }, { sourceTimeOffset: 40 })).toEqual(["A source time offset"]);
  });

  it.each(["fixed", "anchored"])("names %s source tracking, which reads the canvas from anywhere", (mode) => {
    expect(needsOf({ sourcePositionMode: mode })).toEqual(["Source tracking"]);
  });

  it("names a source time offset", () => {
    expect(needsOf({ sourceTimeOffset: 20 })).toEqual(["A source time offset"]);
  });

  it("leaves the source alone when the step names a file of its own to read", () => {
    const step = { sourcePositionMode: "fixed", sourceTimeOffset: 20, sourceFile: { path: "/other.wav" } };
    expect(needsOf(step)).toEqual([]);
  });
});

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

  it("puts what reads the whole file before what reads too far", () => {
    const state = stateOf({
      sourceTimeOffset: 20,
      transformShiftBeats: 20,
      transformEdgeMode: 1,
      effects: [{ id: "mock-transform", effect: "transform", enabled: true, params: {} }],
    });
    expect(strokeRefusal(state, CTX)).toBe(
      "A source time offset reads the whole file, and this file is too long for that. Switch it off to paint here.",
    );
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

describe("wholeFileRefusal", () => {
  it("reads as one sentence for a single need", () => {
    expect(wholeFileRefusal(["Sort"])).toBe(
      "Sort reads the whole file, and this file is too long for that. Switch it off to paint here.",
    );
  });

  it("joins several needs and agrees the verb with them", () => {
    expect(wholeFileRefusal(["Sort", "Evolve", "Wrap in time"])).toBe(
      "Sort, Evolve and Wrap in time read the whole file, and this file is too long for that. Switch them off to paint here.",
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
