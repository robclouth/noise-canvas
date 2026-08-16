import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { EffectItem } from "../../effects/types";
import { clearLinkedEffectParam, matchingEffects, writeEffectParam } from "../../store/effect-param-linking";
import type { Brush, ParameterKey } from "../../store/types";

/**
 * "Step Linked" makes one control drive the same parameter in every step. Each
 * step owns its own effect instances with their own ids, so an id-based match
 * only ever finds the step the edit came from — and the switch appears on, and
 * does nothing, for every effect parameter.
 */

const THRESHOLD = "dynamicsThreshold" as ParameterKey;

function effect(id: string, type: string, params: Record<string, unknown> = {}): EffectItem {
  return { id, effect: type, enabled: true, params } as unknown as EffectItem;
}

/** Two steps, each with its own independently added effects. */
function brushWith(...stepEffects: EffectItem[][]): Brush {
  return {
    name: "B",
    linkedParams: [],
    macroValues: [],
    steps: stepEffects.map((effects) => ({ effects })),
  } as unknown as Brush;
}

/** The params of one step's effect, by position in that step's chain. */
function paramsOf(brush: Brush, stepIndex: number, effectIndex: number): Record<string, unknown> {
  const effects = (brush.steps[stepIndex]?.effects ?? []) as EffectItem[];
  return effects[effectIndex].params as Record<string, unknown>;
}

describe("linking an effect parameter across steps", () => {
  it("writes the value into the matching effect of every step", () => {
    const brush = brushWith([effect("s1-dyn", "dynamics")], [effect("s2-dyn", "dynamics")]);

    const next = produce(brush, (draft) => {
      writeEffectParam(draft, 0, "s1-dyn", THRESHOLD, -12, true);
    });

    expect(paramsOf(next, 0, 0)[THRESHOLD]).toBe(-12);
    expect(paramsOf(next, 1, 0)[THRESHOLD]).toBe(-12);
  });

  it("leaves the other steps alone when the parameter is not linked", () => {
    const brush = brushWith([effect("s1-dyn", "dynamics")], [effect("s2-dyn", "dynamics")]);

    const next = produce(brush, (draft) => {
      writeEffectParam(draft, 0, "s1-dyn", THRESHOLD, -12, false);
    });

    expect(paramsOf(next, 0, 0)[THRESHOLD]).toBe(-12);
    expect(paramsOf(next, 1, 0)).toEqual({});
  });

  it("follows position among same-typed effects, not order in the chain", () => {
    // The second Dynamics of each step must track the other step's second
    // Dynamics, across a differing effect sitting between them.
    const brush = brushWith(
      [effect("s1-dyn-a", "dynamics"), effect("s1-blur", "blur"), effect("s1-dyn-b", "dynamics")],
      [effect("s2-dyn-a", "dynamics"), effect("s2-dyn-b", "dynamics")],
    );

    const next = produce(brush, (draft) => {
      writeEffectParam(draft, 0, "s1-dyn-b", THRESHOLD, -6, true);
    });

    expect(paramsOf(next, 0, 2)[THRESHOLD]).toBe(-6);
    expect(paramsOf(next, 1, 1)[THRESHOLD]).toBe(-6);
    expect(paramsOf(next, 0, 0)).toEqual({});
    expect(paramsOf(next, 1, 0)).toEqual({});
  });

  it("skips a step with no effect of that type", () => {
    const brush = brushWith([effect("s1-dyn", "dynamics")], [effect("s2-blur", "blur")]);

    const next = produce(brush, (draft) => {
      writeEffectParam(draft, 0, "s1-dyn", THRESHOLD, -3, true);
    });

    expect(matchingEffects(brush, 0, "s1-dyn")).toHaveLength(1);
    expect(paramsOf(next, 1, 0)).toEqual({});
  });

  it("clears rather than storing undefined when the edited effect holds no value", () => {
    // getEffectParameterValue tests with `key in params`, so an explicit
    // undefined reads back as a set value instead of the step's.
    const brush = brushWith([effect("s1-dyn", "dynamics")], [effect("s2-dyn", "dynamics", { [THRESHOLD]: -20 })]);

    const next = produce(brush, (draft) => {
      clearLinkedEffectParam(draft, 0, "s1-dyn", THRESHOLD);
    });

    expect(THRESHOLD in paramsOf(next, 1, 0)).toBe(false);
  });
});
