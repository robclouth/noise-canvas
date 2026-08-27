import { describe, expect, it } from "vitest";

import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import { BRUSH_SIZE_TIME_FULL } from "../utils";
import { wholeFileNeeds, wholeFileRefusal } from "../whole-file-gate";

function needsOf(...steps: Array<Partial<TestBrushStep>>): string[] {
  return wholeFileNeeds(createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides }))));
}

function withEffect(effect: string, enabled = true): Partial<TestBrushStep> {
  return { effects: [{ id: `mock-${effect}`, effect, enabled, params: {} }] };
}

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

  it.each(["attract", "convolve", "evolve", "sort", "transmute"])("names %s by its label", (effect) => {
    expect(needsOf(withEffect(effect))).toHaveLength(1);
  });

  it.each(["blur", "clone", "dynamics", "transform"])("leaves %s alone", (effect) => {
    expect(needsOf(withEffect(effect))).toEqual([]);
  });

  it("ignores an effect that is switched off", () => {
    expect(needsOf(withEffect("sort", false))).toEqual([]);
  });

  it("reads every step of the brush, not only the active one", () => {
    expect(needsOf({}, withEffect("evolve"))).toEqual(["Evolve"]);
  });

  it("names each thing once, however many steps ask for it", () => {
    expect(needsOf(withEffect("sort"), withEffect("sort"))).toEqual(["Sort"]);
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
