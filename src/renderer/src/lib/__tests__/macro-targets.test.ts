import { describe, expect, it } from "vitest";

import { getNumberParameterDef } from "../../parameters";
import type { ParameterKey } from "../../store/types";
import { normalizeParameterValue } from "../../store/utils";
import { createMockStateWithSteps, TestBrushStep } from "../../test/mock-state";
import {
  hasDynamicSources,
  macroTargets,
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
