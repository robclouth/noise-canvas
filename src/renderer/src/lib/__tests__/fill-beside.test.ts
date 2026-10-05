import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer, worstDifference } from "../../test/canvas-parity";
import { transformBrush } from "../../test/transform-fixture";
import { prepareStrokeBatch, strokeRefusal } from "../file-stroke-dispatch";

/**
 * A Fill Grid dab that reads further than the canvas window holds paints
 * beside the window, as a pointer dab does, and lands what a canvas over the
 * whole file paints.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("a fill dab reading past the window", () => {
  it("paints beside the window what a whole-file canvas paints", async () => {
    renderer ??= parityRenderer();
    const state = transformBrush(6, { transformShiftBeats: 32, transformEdgeMode: 1 });
    const aim = { x: 0.3, y: 0.5 };

    const windowed = parityCanvas(parityData({ durationSeconds: 120 }), 2, renderer.gl);
    const whole = parityCanvas(parityData({ durationSeconds: 120 }), Infinity, renderer.gl);
    try {
      expect(strokeRefusal(windowed.context, state)).not.toBeNull();

      windowed.canvas.beginStroke();
      let painted: number;
      let ranges: Uint32Array | null;
      let values: Float32Array | null = null;
      try {
        painted = prepareStrokeBatch(windowed.context, windowed.canvas, [{ aimX: aim.x, aimY: aim.y, state }]).painted;
        expect((await windowed.canvas.settle()).status).toBe("completed");
        ranges = windowed.canvas.dirtyPixelRanges();
        if (ranges) values = await windowed.canvas.readPixelRanges(ranges);
      } finally {
        windowed.canvas.endStroke();
      }
      expect(painted).toBe(1);

      const want = await paintStroke(whole, [{ ...aim, state }]);
      expect(want.refused).toBeNull();
      expect(ranges).not.toBeNull();
      const wantValues = await whole.canvas.readPixelRanges(ranges!);
      const diff = worstDifference(wantValues, values!);
      expect(diff.magnitude).toBeLessThan(1e-4);
      expect(diff.phase).toBeLessThan(1e-2);
    } finally {
      windowed.dispose();
      whole.dispose();
    }
  }, 120_000);
});
