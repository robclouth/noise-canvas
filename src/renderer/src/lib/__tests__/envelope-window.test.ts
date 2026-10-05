import { afterAll, describe, expect, it } from "vitest";
import { outliersByBand, paintStroke, parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";

/**
 * A brush driven by an envelope follower that smooths over beats and spreads
 * its channels paints the same through a canvas window as over the whole
 * file: the window holds what the follower reads, and the follower's widths
 * are the file's.
 */
const SECONDS = 120;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("an envelope-following brush through a canvas window", () => {
  it("paints what a canvas over the whole file paints", async () => {
    renderer ??= parityRenderer();
    const state = fixtureBrush("dynamics", {
      dynamicsGainDb: 0,
      dynamicsGainDbMod1Amount: 100,
      modulator1Mode: 1,
      modulator1EnvelopeSmoothingBeats: 4,
      modulator1StereoSpread: 100,
    });
    const aim = { x: 0.63, y: 0.5 };
    const whole = parityCanvas(parityData({ durationSeconds: SECONDS }), Infinity, renderer.gl);
    const windowed = parityCanvas(parityData({ durationSeconds: SECONDS }), 2, renderer.gl);
    try {
      const want = await paintStroke(whole, [{ ...aim, state }]);
      const have = await paintStroke(windowed, [{ ...aim, state }]);
      expect(want.refused).toBeNull();
      expect(have.refused).toBeNull();
      const wantValues = await whole.canvas.readPixelRanges(have.ranges!);
      // The modulator textures are half floats, so a read a hair apart can
      // land one step of one either side, and the follower reads its input
      // many times a texel: isolated texels a step out, never a run of them.
      for (const [band, entry] of outliersByBand(whole.data, have.ranges!, wantValues, have.values!)) {
        const detail = `band ${band}: ${entry.outliers} of ${entry.bins} out, ${entry.longestRun} in a row, magnitude ${entry.magnitude}`;
        expect(entry.longestRun <= 2 && entry.outliers <= entry.bins * 0.03 && entry.magnitude < 0.05, detail).toBe(
          true,
        );
      }
      // The follower moved the gain, so the comparison is not vacuous.
      const before = parityData({ durationSeconds: SECONDS }).packedData;
      let moved = 0;
      let at = 0;
      for (let r = 0; r < have.ranges!.length; r += 2) {
        for (let p = have.ranges![r]; p < have.ranges![r] + have.ranges![r + 1]; p++, at += 4) {
          if (Math.abs(have.values![at] - before[p * 4]) > 1e-2) moved++;
        }
      }
      expect(moved).toBeGreaterThan(100);
    } finally {
      whole.dispose();
      windowed.dispose();
    }
  }, 120_000);
});
