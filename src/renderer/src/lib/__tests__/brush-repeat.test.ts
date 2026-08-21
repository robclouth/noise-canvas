import { describe, expect, it } from "vitest";

import { createMockState, createMockStateWithSteps } from "../../test/mock-state";
import { heldRepeatIntervalMs, HELD_REPEAT_INTERVAL_MS } from "../brush-repeat";

describe("held repeat interval", () => {
  it("does not repeat when no step accumulates", () => {
    expect(heldRepeatIntervalMs(createMockState())).toBeNull();
  });

  it("repeats when the step accumulates", () => {
    const state = createMockStateWithSteps([{ name: "Test", overrides: { accumulate: true } }]);
    expect(heldRepeatIntervalMs(state)).toBe(HELD_REPEAT_INTERVAL_MS);
  });

  it("repeats when any step accumulates", () => {
    const state = createMockStateWithSteps([
      { name: "Off", overrides: { accumulate: false } },
      { name: "On", overrides: { accumulate: true } },
    ]);
    expect(heldRepeatIntervalMs(state)).toBe(HELD_REPEAT_INTERVAL_MS);
  });
});
