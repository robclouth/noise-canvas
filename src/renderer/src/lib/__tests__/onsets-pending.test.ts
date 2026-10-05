import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";
import { onsetsPendingRefusal, strokeRefusal } from "../file-stroke-dispatch";

/**
 * A long file opens before the pass that finds its onsets, and every read
 * through the default warp follows them, so a stroke reading the file waits
 * until they are found, as one on a short file never has to.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("a file still finding its onsets", () => {
  it("refuses a stroke on it until they are found", async () => {
    renderer ??= parityRenderer();
    const target = parityCanvas(parityData({ durationSeconds: 60 }), 2, renderer.gl);
    try {
      const state = fixtureBrush("dynamics", { dynamicsGainDb: 6 });
      target.file.onsetsPending = true;
      const refusal = onsetsPendingRefusal(target.file.displayName);
      expect(strokeRefusal(target.context, state, { x: 0.5, y: 0.5 })).toBe(refusal);
      expect((await paintStroke(target, [{ x: 0.5, y: 0.5, state }])).refused).toBe(refusal);

      target.file.onsetsPending = false;
      expect(strokeRefusal(target.context, state, { x: 0.5, y: 0.5 })).toBeNull();
      expect((await paintStroke(target, [{ x: 0.5, y: 0.5, state }])).refused).toBeNull();
    } finally {
      target.dispose();
    }
  });

  it("refuses a stroke reading it from another file", async () => {
    renderer ??= parityRenderer();
    const source = parityCanvas(parityData({ durationSeconds: 60 }), 2, renderer.gl, undefined, undefined, {
      id: "source",
      filePath: "/source.wav",
    });
    const target = parityCanvas(parityData({ durationSeconds: 60 }), Infinity, renderer.gl, undefined, undefined, {
      others: [source],
    });
    try {
      const state = fixtureBrush("dynamics", { sourceFile: { path: "/source.wav" } });
      source.file.onsetsPending = true;
      expect(strokeRefusal(target.context, state, { x: 0.5, y: 0.5 })).toBe(onsetsPendingRefusal("source.wav"));
      source.file.onsetsPending = false;
      expect(strokeRefusal(target.context, state, { x: 0.5, y: 0.5 })).toBeNull();
    } finally {
      target.dispose();
      source.dispose();
    }
  });
});
