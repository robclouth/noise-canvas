import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { transformBrush } from "../../test/transform-fixture";

/**
 * A reverse mirrors the brush about its own middle, however long the file:
 * the plain algorithm turns each band by the time the read and the write sum
 * to, as the neutral rule does, rather than by the file's length.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

async function reversed(algorithm: number, seconds: number) {
  renderer ??= parityRenderer();
  const canvas = parityCanvas(parityData({ durationSeconds: seconds }), Infinity, renderer.gl);
  try {
    const stroke = await paintStroke(canvas, [
      { x: 0.42, y: 0.55, state: transformBrush(algorithm, { transformScaleTime: -1 }) },
    ]);
    expect(stroke.refused).toBeNull();
    return stroke.values!;
  } finally {
    canvas.dispose();
  }
}

describe("a reverse with the plain algorithm", () => {
  it.each([30, 240])(
    "turns the bands as the neutral rule does on a %i-second file",
    async (seconds) => {
      const plain = await reversed(0, seconds);
      const neutral = await reversed(4, seconds);
      let loud = 0;
      let apart = 0;
      for (let i = 0; i < plain.length; i += 2) {
        if (Math.min(plain[i], neutral[i]) < 1e-2) continue;
        loud++;
        const d = plain[i + 1] - neutral[i + 1];
        if (Math.abs(d - 2 * Math.PI * Math.round(d / (2 * Math.PI))) > 0.1) apart++;
      }
      expect(loud).toBeGreaterThan(1000);
      expect(apart, `${apart} of ${loud} loud texels apart`).toBeLessThanOrEqual(loud * 0.001);
    },
    120_000,
  );
});
