import { describe, expect, it } from "vitest";

import { getNumberParameterDef, getQuantizeParamKey } from "../../parameters";
import { createStepStateView } from "../../store";
import { State } from "../../store/types";
import { createMockState } from "../../test/mock-state";
import { getQuantizeListRange, getQuantizeLutTexture, quantizeParameterValue } from "../quantize-lut";
import { createModContext, NEUTRAL_STROKE_CONTEXT, parameterUniform } from "../static-modulation";

// The quantise toggle snaps a parameter's modulated value to the values its own
// control offers: the mark list where the slider has one, the step grid where it
// does not. The CPU zeroes the uniform fields whenever the snap must not run.

function stepStateWith(overrides: Record<string, unknown>): State {
  const state = createMockState(overrides as Partial<State>);
  Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
  return createStepStateView(state, 0);
}

function lutValues(offset: number, count: number): number[] {
  const data = getQuantizeLutTexture().image.data as Float32Array;
  return Array.from(data.slice(offset, offset + count));
}

describe("quantise value lists", () => {
  it("lists a marked slider's values sorted, inside its own range", () => {
    const def = getNumberParameterDef("transformShiftSemis");
    const range = getQuantizeListRange("transformShiftSemis");
    expect(range).not.toBeNull();
    const values = lutValues(range!.offset, range!.count);

    expect(values.length).toBeGreaterThan(10);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[0]).toBe(def.min);
    expect(values[values.length - 1]).toBe(def.max);
    expect(values).toContain(0);
  });

  it("gives no list to an unmarked parameter", () => {
    expect(getQuantizeListRange("dynamicsGainDb")).toBeNull();
  });

  it("gives no quantise toggle to modulator-own parameters", () => {
    expect(getQuantizeParamKey("modulator1Strength")).toBeNull();
    expect(getQuantizeParamKey("modulator1PatternRateBeats")).toBeNull();
    expect(getQuantizeParamKey("transformShiftSemis")).not.toBeNull();
  });

  it("snaps a value the way the shader will", () => {
    expect(quantizeParameterValue("transformShiftSemis", 2.3)).toBe(2);
    expect(quantizeParameterValue("transformShiftSemis", 2.6)).toBe(3);
    expect(quantizeParameterValue("transformShiftSemis", -0.05)).toBe(0);
    expect(quantizeParameterValue("dynamicsGainDb", -19.97)).toBeCloseTo(-20, 9);
  });
});

describe("quantise uniform fields", () => {
  const ctxFor = (step: State) => createModContext(step, NEUTRAL_STROKE_CONTEXT);

  it("stays off while the toggle is off", () => {
    const step = stepStateWith({ transformShiftSemisModMacro1Amount: 100 });
    const uniform = parameterUniform(step, "transformShiftSemis", ctxFor(step));
    expect(uniform.quantizeCount).toBe(0);
    expect(uniform.quantizeStep).toBe(0);
  });

  it("stays off while nothing modulates the parameter", () => {
    const step = stepStateWith({ transformShiftSemisModQuantize: true });
    const uniform = parameterUniform(step, "transformShiftSemis", ctxFor(step));
    expect(uniform.quantizeCount).toBe(0);
    expect(uniform.quantizeStep).toBe(0);
  });

  it("points a marked slider at its list", () => {
    const step = stepStateWith({
      transformShiftSemisModQuantize: true,
      transformShiftSemisModMacro1Amount: 100,
    });
    const uniform = parameterUniform(step, "transformShiftSemis", ctxFor(step));
    const range = getQuantizeListRange("transformShiftSemis");
    expect(uniform.quantizeOffset).toBe(range!.offset);
    expect(uniform.quantizeCount).toBe(range!.count);
    expect(uniform.quantizeStep).toBe(0);
  });

  it("snaps an unmarked slider by its own step", () => {
    const step = stepStateWith({
      dynamicsGainDbModQuantize: true,
      dynamicsGainDbModMacro1Amount: 100,
    });
    const uniform = parameterUniform(step, "dynamicsGainDb", ctxFor(step));
    expect(uniform.quantizeCount).toBe(0);
    expect(uniform.quantizeStep).toBeCloseTo(0.1, 9);
  });

  it("rescales the step into the shader's range", () => {
    const step = stepStateWith({
      brushIntensityModQuantize: true,
      brushIntensityModMacro1Amount: 100,
    });
    const uniform = parameterUniform(step, "brushIntensity", ctxFor(step), { value: 0.5, min: 0, max: 1 });
    expect(uniform.quantizeCount).toBe(0);
    expect(uniform.quantizeStep).toBeCloseTo(0.01, 9);
  });
});
