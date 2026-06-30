import { describe, expect, it } from "vitest";

import type { ParameterKey } from "../../store/types";

// The modulator-view preview rebuilds when the active step object's reference
// changes (it subscribes to `state.brushes[ab].steps[as]`). That only works if
// every parameter the preview depends on — including the modulation amounts
// routed INTO a modulator (nested modulation) — is a step parameter, so editing
// one produces a fresh step object. A previous "cheap signature" optimization
// enumerated only the modulators' own params and silently missed nested amounts,
// so the preview went stale until an unrelated direct param was touched.
describe("modulator preview reactivity", () => {
  it("editing a nested modulation amount yields a new active-step reference", async () => {
    const { useStore } = await import("../../store");
    const activeStep = () => {
      const s = useStore.getState();
      return s.brushes[s.activeBrushIndex]?.steps?.[s.activeStepIndex];
    };

    const before = activeStep();
    useStore.getState().setParameter("modulator2StrengthMod1Amount" as ParameterKey, 50);
    const after = activeStep();

    expect(before).toBeDefined();
    // A new step object (so the step-ref subscription fires and the preview rebuilds).
    expect(after).not.toBe(before);
    // The value actually landed on the step (it is a per-step parameter).
    expect((after as Record<string, unknown>).modulator2StrengthMod1Amount).toBe(50);
  });

  it("editing a global (non-step) parameter leaves the active-step reference unchanged", async () => {
    const { useStore } = await import("../../store");
    const activeStep = () => {
      const s = useStore.getState();
      return s.brushes[s.activeBrushIndex]?.steps?.[s.activeStepIndex];
    };

    const before = activeStep();
    useStore.getState().setParameter("displayMinDb" as ParameterKey, -55);
    const after = activeStep();

    expect(after).toBe(before);
  });
});
