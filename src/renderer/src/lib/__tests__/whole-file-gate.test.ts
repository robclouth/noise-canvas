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

function withEffect(effect: string, enabled = true): Partial<TestBrushStep> {
  return { effects: [{ id: `mock-${effect}`, effect, enabled, params: {} }] };
}

const RESPONSE = { path: "/response.wav", name: "response.wav" };

describe("wholeFileNeeds", () => {
  it("finds nothing in a brush that reads only around itself", () => {
    expect(needsOf({})).toEqual([]);
  });

  it.each([
    { wrapMode: 0, named: false },
    { wrapMode: 1, named: true },
    { wrapMode: 2, named: false },
    { wrapMode: 3, named: true },
  ])("names wrap mode $wrapMode as reading the file: $named", ({ wrapMode, named }) => {
    expect(needsOf({ brushWrapMode: wrapMode }).includes("Wrap in time")).toBe(named);
  });

  it("names a brush as long as the file", () => {
    expect(needsOf({ brushSizeTime: BRUSH_SIZE_TIME_FULL })).toEqual(["A brush the length of the file"]);
    expect(needsOf({ brushSizeTime: BRUSH_SIZE_TIME_FULL - 1 })).toEqual([]);
  });

  it("names a convolve with no response file of its own", () => {
    expect(needsOf(withEffect("convolve"))).toEqual(["Convolve with no IR"]);
  });

  it("leaves a convolve alone once a response file is named", () => {
    const step = { effects: [{ id: "ir", effect: "convolve", enabled: true, params: { convolveIrFile: RESPONSE } }] };
    expect(needsOf(step)).toEqual([]);
  });

  // These read a span around the brush that their own settings bound, which
  // `effect-reach.ts` declares and the canvas holds.
  it.each(["attract", "blur", "clone", "dynamics", "evolve", "sort", "transform", "transmute"])(
    "leaves %s alone",
    (effect) => {
      expect(needsOf(withEffect(effect))).toEqual([]);
    },
  );

  it("ignores an effect that is switched off", () => {
    expect(needsOf(withEffect("convolve", false))).toEqual([]);
  });

  it("reads every step of the brush, not only the active one", () => {
    expect(needsOf({}, withEffect("convolve"))).toEqual(["Convolve with no IR"]);
  });

  it("names each thing once, however many steps ask for it", () => {
    expect(needsOf(withEffect("convolve"), withEffect("convolve"))).toEqual(["Convolve with no IR"]);
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

  it("names an effect that reads further than the canvas holds", () => {
    // Sixteen beats is eight seconds either side, so the brush needs more than
    // sixteen seconds of the file.
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 16, transformEdgeMode: 1 })), CTX)).toEqual([
      "Transform",
    ]);
  });

  it("finds nothing when the edge mode keeps the read inside the brush", () => {
    expect(overReachNeeds(stateOf(reachStep({ transformShiftBeats: 16, transformEdgeMode: 0 })), CTX)).toEqual([]);
  });
});

describe("strokeRefusal", () => {
  it("says nothing while the canvas holds the whole file", () => {
    const state = stateOf({ brushWrapMode: 1 });
    expect(strokeRefusal(state, null)).toBeNull();
  });

  it("says nothing for a brush a window can serve", () => {
    expect(strokeRefusal(stateOf({}), CTX)).toBeNull();
  });

  it("puts what reads the whole file before what reads too far", () => {
    const state = stateOf({
      brushWrapMode: 1,
      transformShiftBeats: 16,
      transformEdgeMode: 1,
      effects: [{ id: "mock-transform", effect: "transform", enabled: true, params: {} }],
    });
    expect(strokeRefusal(state, CTX)).toBe(
      "Wrap in time reads the whole file, and this file is too long for that. Switch it off to paint here.",
    );
  });

  it("reports a reach the canvas cannot hold", () => {
    const state = stateOf({
      transformShiftBeats: 16,
      transformEdgeMode: 1,
      effects: [{ id: "mock-transform", effect: "transform", enabled: true, params: {} }],
    });
    expect(strokeRefusal(state, CTX)).toBe(
      "Transform reaches too far for this file. Turn it down, or paint a shorter brush, to paint here.",
    );
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
    expect(overReachRefusal(["Blur"])).toBe(
      "Blur reaches too far for this file. Turn it down, or paint a shorter brush, to paint here.",
    );
  });

  it("joins several effects and agrees the verb with them", () => {
    expect(overReachRefusal(["Blur", "Repeat"])).toBe(
      "Blur and Repeat reach too far for this file. Turn them down, or paint a shorter brush, to paint here.",
    );
  });
});
