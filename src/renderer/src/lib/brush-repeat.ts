import { createStepStateView } from "../store";
import type { State } from "../store/types";

/** How many times a second a held brush paints again while Accumulate is on. */
const HELD_REPEAT_RATE_HZ = 20;

export const HELD_REPEAT_INTERVAL_MS = 1000 / HELD_REPEAT_RATE_HZ;

/**
 * Milliseconds between repeats of a held brush, or null when no step
 * accumulates. Only an accumulating step changes with each repeat: every other
 * step re-runs from the stroke's start state and lands on the same result.
 */
export function heldRepeatIntervalMs(state: State): number | null {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const stepCount = Math.max(steps.length, 1);
  for (let i = 0; i < stepCount; i++) {
    if (createStepStateView(state, i).accumulate) return HELD_REPEAT_INTERVAL_MS;
  }
  return null;
}
