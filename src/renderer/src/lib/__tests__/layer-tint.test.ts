import { describe, expect, it } from "vitest";
import { hueToRgb, layerTint, LONE_LAYER_TINT } from "../layer-tint";

describe("hueToRgb", () => {
  it("gives the colours the picture has always used", () => {
    expect(hueToRgb(30)).toEqual([1, 0.5, 0]);
    expect(hueToRgb(210)).toEqual([0, 0.5, 1]);
  });

  it("wraps the wheel", () => {
    expect(hueToRgb(390)).toEqual(hueToRgb(30));
    expect(hueToRgb(-150)).toEqual(hueToRgb(210));
  });
});

describe("layerTint", () => {
  it("leaves a lone layer exactly as it was", () => {
    expect(LONE_LAYER_TINT).toEqual({ left: [1, 0.5, 0], right: [0, 0.5, 1] });
    expect(layerTint(0, 1)).toEqual(LONE_LAYER_TINT);
  });

  it("adds a lone layer's two halves to white", () => {
    const { left, right } = LONE_LAYER_TINT;
    expect(left.map((c, i) => c + right[i])).toEqual([1, 1, 1]);
  });

  it("fans a stack's layers around the wheel", () => {
    const hues = [0, 1, 2, 3].map((i) => layerTint(i, 4));
    const centres = hues.map(({ left, right }) => left.map((c, i) => c + right[i]));
    // No two layers share a centre colour.
    const seen = new Set(centres.map((c) => c.join(",")));
    expect(seen.size).toBe(4);
  });

  it("narrows the spread as the stack grows, so hues never meet", () => {
    for (const count of [2, 3, 4, 6, 8]) {
      const step = 360 / count;
      // Two adjacent layers: this one's right lean and the next one's left.
      const spread = Math.min(90, (0.4 * 360) / count);
      expect(spread * 2).toBeLessThan(step);
    }
  });

  it("treats a stack of one like a lone layer", () => {
    expect(layerTint(0, 0)).toEqual(LONE_LAYER_TINT);
  });
});
