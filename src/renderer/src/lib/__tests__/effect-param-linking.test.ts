import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { EffectItem } from "../../effects/types";
import {
  clearLinkedEffectParam,
  matchingEffects,
  seedLinkedEffectParam,
  seedLinkedStepParam,
  writeEffectParam,
} from "../../store/effect-param-linking";
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

/**
 * Switching "Step Linked" on links every step of the brush at once, so the
 * value they all take must not depend on which step the switch was flipped
 * from. A step added later carries defaults, and seeding from it would wipe the
 * steps already tuned.
 */
describe("seeding a parameter when linking is switched on", () => {
  const SIZE = "brushSizeTime" as ParameterKey;

  /** Steps holding a plain step parameter, no effects. */
  function stepsWith(...values: number[]): Brush {
    return {
      name: "B",
      linkedParams: [],
      macroValues: [],
      steps: values.map((brushSizeTime) => ({ brushSizeTime, effects: [] })),
    } as unknown as Brush;
  }

  const sizeOf = (brush: Brush, stepIndex: number) =>
    (brush.steps[stepIndex] as unknown as Record<string, unknown>)[SIZE];

  it("takes a step parameter from the first step, not the step it was switched on from", () => {
    const brush = stepsWith(2, 4, 1);

    const next = produce(brush, (draft) => {
      seedLinkedStepParam(draft, SIZE);
    });

    expect([sizeOf(next, 0), sizeOf(next, 1), sizeOf(next, 2)]).toEqual([2, 2, 2]);
  });

  it("takes an effect parameter from the first step that holds the effect", () => {
    const brush = brushWith(
      [effect("s1-dyn", "dynamics", { [THRESHOLD]: -30 })],
      [effect("s2-dyn", "dynamics", { [THRESHOLD]: -6 })],
      [effect("s3-dyn", "dynamics", { [THRESHOLD]: -12 })],
    );

    // Switched on from the last step, which holds its own value.
    const next = produce(brush, (draft) => {
      seedLinkedEffectParam(draft, 2, "s3-dyn", THRESHOLD);
    });

    expect(paramsOf(next, 0, 0)[THRESHOLD]).toBe(-30);
    expect(paramsOf(next, 1, 0)[THRESHOLD]).toBe(-30);
    expect(paramsOf(next, 2, 0)[THRESHOLD]).toBe(-30);
  });

  it("drops the effect parameter everywhere when no step holds one", () => {
    const brush = brushWith([effect("s1-dyn", "dynamics")], [effect("s2-dyn", "dynamics", { [THRESHOLD]: -6 })]);

    const next = produce(brush, (draft) => {
      seedLinkedEffectParam(draft, 1, "s2-dyn", THRESHOLD);
    });

    expect(paramsOf(next, 0, 0)).toEqual({});
    expect(paramsOf(next, 1, 0)).toEqual({});
  });
});
