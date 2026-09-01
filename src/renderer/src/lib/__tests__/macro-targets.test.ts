import { describe, expect, it } from "vitest";

import { getNumberParameterDef } from "../../parameters";
import type { ParameterKey } from "../../store/types";
import { normalizeParameterValue } from "../../store/utils";
import { createMockStateWithSteps, TestBrushStep } from "../../test/mock-state";
import {
  formatModulationReach,
  hasDynamicSources,
  macroTargets,
  modulationReach,
  resolvedStaticValue,
  scopedStateView,
  totalModulationWeight,
} from "../macro-targets";

const twoSteps = (first: Partial<TestBrushStep>, second: Partial<TestBrushStep> = {}) =>
  createMockStateWithSteps([
    { name: "Step 1", overrides: first },
    { name: "Step 2", overrides: second },
  ]);

describe("macroTargets", () => {
  it("finds step-level and effect-level targets across every step", () => {
    const state = twoSteps(
      {
        brushIntensityModMacro1Amount: 100,
        effects: [{ id: "fx-a", effect: "dynamics", enabled: true, params: { dynamicsGainDbModMacro1Amount: -50 } }],
      } as Partial<TestBrushStep>,
      { brushPanModMacro1Amount: 25, brushPanModMacro2Amount: 100 } as Partial<TestBrushStep>,
    );
    expect(macroTargets(state, 0)).toEqual([
      { key: "brushIntensity", stepIndex: 0, amount: 100 },
      { key: "dynamicsGainDb", stepIndex: 0, effectId: "fx-a", amount: -50 },
      { key: "brushPan", stepIndex: 1, amount: 25 },
    ]);
    expect(macroTargets(state, 1)).toEqual([{ key: "brushPan", stepIndex: 1, amount: 100 }]);
    expect(macroTargets(state, 2)).toEqual([]);
  });
});

describe("scopedStateView", () => {
  it("reads each layer: effect params, then the step, then the default", () => {
    const state = twoSteps(
      {
        brushIntensity: 40,
        effects: [{ id: "fx-a", effect: "dynamics", enabled: true, params: { dynamicsGainDb: 6 } }],
      } as Partial<TestBrushStep>,
      { brushIntensity: 70 } as Partial<TestBrushStep>,
    );
    const inEffect = scopedStateView(state, 0, "fx-a");
    expect(inEffect.dynamicsGainDb).toBe(6);
    expect(inEffect.brushIntensity).toBe(40);
    expect(scopedStateView(state, 1).brushIntensity).toBe(70);
    expect(scopedStateView(state, 1).dynamicsGainDb).toBe(getNumberParameterDef("dynamicsGainDb").default);
    expect(scopedStateView(state, 0)["macro1Value" as ParameterKey]).toBe(50);
  });

  it("reads through a frozen state, as the store hands out", () => {
    const state = Object.freeze(
      twoSteps(
        { brushIntensityModMacro1Amount: 100 } as Partial<TestBrushStep>,
        {
          brushIntensityModMacro1Amount: 25,
        } as Partial<TestBrushStep>,
      ),
    );
    expect(scopedStateView(state, 0).brushIntensityModMacro1Amount).toBe(100);
    expect(scopedStateView(state, 1).brushIntensityModMacro1Amount).toBe(25);
    expect(scopedStateView(state, 1).activeBrushIndex).toBe(0);
    expect("brushes" in scopedStateView(state, 1)).toBe(true);
  });
});

describe("resolvedStaticValue", () => {
  it("parks a linear parameter where the macro knob puts it", () => {
    const state = twoSteps({ brushIntensity: 20, brushIntensityModMacro1Amount: 100 } as Partial<TestBrushStep>);
    state.brushes[0].macroValues = [25, 50, 50, 50];
    expect(resolvedStaticValue(scopedStateView(state, 0), "brushIntensity")).toBeCloseTo(25, 9);
  });

  it("sweeps a log slider along its arc", () => {
    const state = twoSteps({
      effects: [
        {
          id: "fx-t",
          effect: "transform",
          enabled: true,
          params: { transformScaleTime: 1, transformScaleTimeModMacro1Amount: 100 },
        },
      ],
    } as Partial<TestBrushStep>);
    state.brushes[0].macroValues = [normalizeParameterValue("transformScaleTime", 8) * 100, 50, 50, 50];
    expect(resolvedStaticValue(scopedStateView(state, 0, "fx-t"), "transformScaleTime")).toBeCloseTo(8, 6);
  });

  it("blends towards the base below full weight", () => {
    const state = twoSteps({ brushIntensity: 0, brushIntensityModMacro1Amount: 50 } as Partial<TestBrushStep>);
    state.brushes[0].macroValues = [100, 50, 50, 50];
    expect(resolvedStaticValue(scopedStateView(state, 0), "brushIntensity")).toBeCloseTo(50, 9);
  });
});

describe("modulation weight", () => {
  it("sums static and modulator amounts and clamps at one", () => {
    const state = twoSteps({
      brushIntensityModMacro1Amount: 60,
      brushIntensityMod1Amount: -60,
      brushIntensityModPressure: 30,
    } as Partial<TestBrushStep>);
    const view = scopedStateView(state, 0);
    expect(totalModulationWeight(view, "brushIntensity")).toBe(1);
    expect(totalModulationWeight(view, "brushPan")).toBe(0);
    expect(hasDynamicSources(view, "brushIntensity")).toBe(true);
    expect(hasDynamicSources(view, "brushPan")).toBe(false);
  });
});

/** The reach a control shows: `weight` wide in knob position, with the base value at its own position inside it. */
function reachOf(state: ReturnType<typeof twoSteps>, key: ParameterKey) {
  const view = scopedStateView(state, 0);
  return modulationReach(view, key, totalModulationWeight(view, key));
}

describe("modulationReach", () => {
  it("is null while nothing modulates the parameter", () => {
    expect(reachOf(twoSteps({ brushIntensity: 50 } as Partial<TestBrushStep>), "brushIntensity")).toBeNull();
  });

  it("spans the weight in knob position, around the base value's own position", () => {
    const state = twoSteps({ brushIntensity: 50, brushIntensityModMacro1Amount: 50 } as Partial<TestBrushStep>);
    const reach = reachOf(state, "brushIntensity")!;
    const span =
      normalizeParameterValue("brushIntensity", reach.upper) - normalizeParameterValue("brushIntensity", reach.lower);
    expect(span).toBeCloseTo(0.5, 9);
    expect(reach.lower).toBeCloseTo(25, 9);
    expect(reach.upper).toBeCloseTo(75, 9);
    expect(formatModulationReach("brushIntensity", reach)).toBe("25–75%");
  });

  it("spans the weight on a log slider too, measured in knob position", () => {
    const state = twoSteps({
      effects: [
        {
          id: "fx-t",
          effect: "transform",
          enabled: true,
          params: { transformScaleTime: 1, transformScaleTimeModMacro1Amount: 40 },
        },
      ],
    } as Partial<TestBrushStep>);
    const view = scopedStateView(state, 0, "fx-t");
    const reach = modulationReach(view, "transformScaleTime", totalModulationWeight(view, "transformScaleTime"))!;
    const span =
      normalizeParameterValue("transformScaleTime", reach.upper) -
      normalizeParameterValue("transformScaleTime", reach.lower);
    expect(span).toBeCloseTo(0.4, 9);
  });

  it("reaches one way only from the bottom of the slider", () => {
    const state = twoSteps({ brushIntensity: 0, brushIntensityModMacro1Amount: 40 } as Partial<TestBrushStep>);
    const reach = reachOf(state, "brushIntensity")!;
    expect(reach.lower).toBeCloseTo(0, 9);
    expect(reach.upper).toBeCloseTo(40, 9);
  });

  it("names the marks it lands on, and folds a symmetric reach to ±", () => {
    const state = twoSteps({
      transformShiftSemis: 0,
      transformShiftSemisModMacro1Amount: 50,
    } as Partial<TestBrushStep>);
    const reach = reachOf(state, "transformShiftSemis")!;
    expect(reach.lower).toBeCloseTo(-48, 9);
    expect(formatModulationReach("transformShiftSemis", reach)).toBe("±48");
  });

  it("leaves the dash bare when only the lower end is negative", () => {
    const state = twoSteps({
      transformShiftSemis: 24,
      transformShiftSemisModMacro1Amount: 50,
    } as Partial<TestBrushStep>);
    const reach = reachOf(state, "transformShiftSemis")!;
    expect(formatModulationReach("transformShiftSemis", reach)).toBe("-36–60");
  });

  it("spaces the dash off a negative upper end, which would read as one glyph", () => {
    const state = twoSteps({
      transformShiftSemis: -60,
      transformShiftSemisModMacro1Amount: 10,
    } as Partial<TestBrushStep>);
    const reach = reachOf(state, "transformShiftSemis")!;
    expect(formatModulationReach("transformShiftSemis", reach)).toBe("-64 – -44");
  });

  it("snaps both ends to the valid values while Quantise is on", () => {
    const overrides = {
      transformShiftSemis: 0,
      transformShiftSemisModMacro1Amount: 10,
    } as Partial<TestBrushStep>;
    const free = reachOf(twoSteps(overrides), "transformShiftSemis")!;
    expect(free.lower).toBeCloseTo(-9.6, 9);
    expect(free.upper).toBeCloseTo(9.6, 9);

    const snapped = reachOf(
      twoSteps({ ...overrides, transformShiftSemisModQuantize: true } as Partial<TestBrushStep>),
      "transformShiftSemis",
    )!;
    expect(snapped.lower).toBe(-10);
    expect(snapped.upper).toBe(10);
    expect(formatModulationReach("transformShiftSemis", snapped)).toBe("±10");
  });

  it("collapses to one value when an amount is too small to leave the mark", () => {
    const state = twoSteps({
      transformShiftSemis: 0,
      transformShiftSemisModMacro1Amount: 0.05,
      transformShiftSemisModQuantize: true,
    } as Partial<TestBrushStep>);
    const reach = reachOf(state, "transformShiftSemis")!;
    expect(formatModulationReach("transformShiftSemis", reach)).toBe("0");
  });
});
