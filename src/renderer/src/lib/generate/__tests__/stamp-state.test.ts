import { aimUvToBrushBlUv } from "@renderer/lib/brush-anchor";
import { BRUSH_ANCHOR_MODE_CENTER, BRUSH_ANCHOR_MODE_CORNER } from "@renderer/lib/constants";
import {
  buildStampState,
  MAX_STAMP_BEATS,
  MIN_STAMP_BEATS,
  type ResolvedStamp,
} from "@renderer/lib/generate/stamp-state";
import { BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import { useStore } from "@renderer/store";
import type { BrushStep } from "@renderer/parameters";
import type { State } from "@renderer/store/types";
import { beforeEach, describe, expect, it } from "vitest";

const stamp = (overrides: Partial<ResolvedStamp> = {}): ResolvedStamp => ({
  beats: 0,
  durationBeats: 0.5,
  brushToken: "x",
  semis: 0,
  brushIndex: 0,
  pitchSemis: 24,
  ...overrides,
});

const stepValue = (state: State, brushIndex: number, stepIndex: number, key: keyof BrushStep) =>
  state.brushes[brushIndex].steps[stepIndex][key];

describe("buildStampState", () => {
  let base: State;

  beforeEach(() => {
    // The store's own default brushes, so the steps are real ones.
    base = useStore.getState();
  });

  it("selects the stamp's brush", () => {
    useStore.getState().addEmptyBrush();
    const withTwo = useStore.getState();
    expect(withTwo.brushes.length).toBeGreaterThan(1);

    const next = buildStampState(withTwo, stamp({ brushIndex: 1 }));
    expect(next.activeBrushIndex).toBe(1);
  });

  it("writes the event length onto every step of the brush", () => {
    const next = buildStampState(base, stamp({ durationBeats: 2.5 }));
    const steps = next.brushes[0].steps;
    expect(steps.length).toBeGreaterThan(0);
    for (let i = 0; i < steps.length; i++) {
      expect(stepValue(next, 0, i, "brushSizeTime")).toBe(2.5);
      expect(stepValue(next, 0, i, "brushAnchorMode")).toBe(BRUSH_ANCHOR_MODE_CORNER);
    }
  });

  it("keeps the size clear of the Grid and Full sentinels", () => {
    expect(stepValue(buildStampState(base, stamp({ durationBeats: 0 })), 0, 0, "brushSizeTime")).toBe(MIN_STAMP_BEATS);
    const full = buildStampState(base, stamp({ durationBeats: 64 }));
    const size = stepValue(full, 0, 0, "brushSizeTime");
    expect(size).toBe(MAX_STAMP_BEATS);
    expect(size).toBeLessThan(BRUSH_SIZE_TIME_FULL);
    expect(size).toBeGreaterThan(0);
  });

  it("leaves the base state and its steps untouched", () => {
    const originalSize = base.brushes[0].steps[0].brushSizeTime;
    const next = buildStampState(base, stamp({ durationBeats: 3 }));
    expect(base.brushes[0].steps[0].brushSizeTime).toBe(originalSize);
    expect(next.brushes[0]).not.toBe(base.brushes[0]);
    expect(next.brushes[0].steps[0]).not.toBe(base.brushes[0].steps[0]);
  });

  it("gives each stamp its own steps array", () => {
    const a = buildStampState(base, stamp({ durationBeats: 1 }));
    const b = buildStampState(base, stamp({ durationBeats: 2 }));
    expect(stepValue(a, 0, 0, "brushSizeTime")).toBe(1);
    expect(stepValue(b, 0, 0, "brushSizeTime")).toBe(2);
    expect(a.brushes[0].steps).not.toBe(b.brushes[0].steps);
  });

  it("overrides a centered anchor so stamps land on their onsets", () => {
    useStore.getState().setStepParameter("brushAnchorMode", BRUSH_ANCHOR_MODE_CENTER);
    const centered = useStore.getState();
    expect(centered.brushes[centered.activeBrushIndex].steps[centered.activeStepIndex].brushAnchorMode).toBe(
      BRUSH_ANCHOR_MODE_CENTER,
    );

    const next = buildStampState(centered, stamp({ brushIndex: centered.activeBrushIndex }));
    expect(stepValue(next, centered.activeBrushIndex, centered.activeStepIndex, "brushAnchorMode")).toBe(
      BRUSH_ANCHOR_MODE_CORNER,
    );
  });

  it("leaves the aim as the brush origin, which is what places the overlay", () => {
    // The overlay skips the anchor conversion because a stamp is always
    // corner-anchored. If that ever stops being true, this fails rather than
    // the blocks quietly drifting half a footprint off the stamps.
    useStore.getState().setStepParameter("brushAnchorMode", BRUSH_ANCHOR_MODE_CENTER);
    const centered = useStore.getState();
    const next = buildStampState(centered, stamp({ brushIndex: centered.activeBrushIndex }));

    const aim = { x: 0.4, y: 0.6 };
    const { blX, blY } = aimUvToBrushBlUv(next, aim.x, aim.y, 120, 10, 24, 240);
    expect(blX).toBe(aim.x);
    expect(blY).toBe(aim.y);
  });

  it("scales the brush's own strength by gain", () => {
    useStore.getState().setStepParameter("brushIntensity", 80);
    const withIntensity = useStore.getState();
    const brushIndex = withIntensity.activeBrushIndex;

    const half = buildStampState(withIntensity, stamp({ brushIndex, gain: 0.5 }));
    expect(stepValue(half, brushIndex, withIntensity.activeStepIndex, "brushIntensity")).toBe(40);

    const loud = buildStampState(withIntensity, stamp({ brushIndex, gain: 4 }));
    expect(stepValue(loud, brushIndex, withIntensity.activeStepIndex, "brushIntensity")).toBe(100);

    const untouched = buildStampState(withIntensity, stamp({ brushIndex }));
    expect(stepValue(untouched, brushIndex, withIntensity.activeStepIndex, "brushIntensity")).toBe(80);
  });

  it("writes pan and pitch size onto every step", () => {
    const next = buildStampState(base, stamp({ pan: -0.5, heightSemis: 24 }));
    for (let i = 0; i < next.brushes[0].steps.length; i++) {
      expect(stepValue(next, 0, i, "brushPan")).toBe(-50);
      expect(stepValue(next, 0, i, "brushSizePitch")).toBe(24);
    }
    // Nothing set means the brush keeps its own.
    const plain = buildStampState(base, stamp());
    expect(stepValue(plain, 0, 0, "brushSizePitch")).toBe(base.brushes[0].steps[0].brushSizePitch);
  });

  it("lets an explicit width override the event length", () => {
    const next = buildStampState(base, stamp({ durationBeats: 0.5, widthBeats: 8 }));
    expect(stepValue(next, 0, 0, "brushSizeTime")).toBe(8);
  });

  it("sets only the macros the pattern named", () => {
    const originals = base.brushes[0].macroValues;
    const next = buildStampState(base, stamp({ macros: [0.25, undefined, 1, undefined] }));
    expect(next.brushes[0].macroValues[0]).toBe(25);
    expect(next.brushes[0].macroValues[1]).toBe(originals[1]);
    expect(next.brushes[0].macroValues[2]).toBe(100);
    expect(next.brushes[0].macroValues[3]).toBe(originals[3]);
    expect(base.brushes[0].macroValues).toEqual(originals);
  });

  it("returns the base state when the brush index is out of range", () => {
    expect(buildStampState(base, stamp({ brushIndex: 99 }))).toBe(base);
  });
});
