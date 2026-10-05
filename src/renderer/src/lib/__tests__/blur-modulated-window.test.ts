import { afterAll, describe, expect, it } from "vitest";
import { expectSameStroke, paintStroke, parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";

/**
 * A Blur whose size a modulator sweeps paints the same through a canvas
 * window as over the whole file: the sweep covers the beats the slider names,
 * not a share of the span the canvas holds.
 */
const SECONDS = 120;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("a modulated blur through a canvas window", () => {
  it("paints what a canvas over the whole file paints", async () => {
    renderer ??= parityRenderer();
    const state = fixtureBrush("blur", {
      blurAmountTime: 30,
      blurAmountTimeMod1Amount: 100,
      blurEdgeMode: 1,
      modulator1Mode: 0,
    });
    const aim = { x: 0.37, y: 0.5 };
    const whole = parityCanvas(parityData({ durationSeconds: SECONDS }), Infinity, renderer.gl);
    const windowed = parityCanvas(parityData({ durationSeconds: SECONDS }), 3, renderer.gl);
    try {
      const want = await paintStroke(whole, [{ ...aim, state }]);
      const have = await paintStroke(windowed, [{ ...aim, state }]);
      expect(await expectSameStroke(whole, want, have)).toBeGreaterThan(100);
    } finally {
      whole.dispose();
      windowed.dispose();
    }
  }, 120_000);
});
