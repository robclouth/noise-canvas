import { afterAll, describe, expect, it } from "vitest";
import { parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { gatherPixelRanges } from "../pixel-ranges";

/**
 * Another file reads this one as its canvas shows it: a stroke whose commit
 * the store does not hold yet still shows over what the store gives back.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("a read of a file with paint still to commit", () => {
  it("lays the held paint over the store's values, on a copy", async () => {
    renderer ??= parityRenderer();
    const data = parityData({ durationSeconds: 60 });
    const target = parityCanvas(data, 2, renderer.gl);
    try {
      const painted = Uint32Array.from([1000, 50, 5000, 20]);
      const paint = new Float32Array(70 * 4).fill(7);
      const revision = target.canvas.pendingPaintRevision;
      const release = target.canvas.holdPaint(painted, Promise.resolve(paint));
      expect(target.canvas.pendingPaintRevision).not.toBe(revision);

      const read = Uint32Array.from([990, 30, 4990, 100]);
      const stored = gatherPixelRanges(data.packedData, read);
      const before = stored.slice();
      const shown = await target.canvas.withPendingPaint(read, stored);

      expect(Array.from(stored)).toEqual(Array.from(before));
      // Pixels 990–999 and 4990–4999 are outside the paint; 1000–1019 and 5000–5019 inside.
      expect(Array.from(shown.subarray(0, 40))).toEqual(Array.from(before.subarray(0, 40)));
      expect(Array.from(shown.subarray(40, 120))).toEqual(new Array(80).fill(7));
      expect(Array.from(shown.subarray(120, 160))).toEqual(Array.from(before.subarray(120, 160)));
      expect(Array.from(shown.subarray(160, 240))).toEqual(new Array(80).fill(7));
      expect(Array.from(shown.subarray(240))).toEqual(Array.from(before.subarray(240)));

      await release(false);
      const after = await target.canvas.withPendingPaint(read, stored);
      expect(Array.from(after)).toEqual(Array.from(before));
    } finally {
      target.dispose();
    }
  });
});
