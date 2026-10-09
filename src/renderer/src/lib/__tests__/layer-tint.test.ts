import { describe, expect, it } from "vitest";
import { greyscaleTint, STEREO_TINT } from "../layer-tint";

describe("STEREO_TINT", () => {
  it("paints left orange and right blue", () => {
    expect(STEREO_TINT).toEqual({ left: [1, 0.5, 0], right: [0, 0.5, 1] });
  });

  it("adds its two halves to white", () => {
    const { left, right } = STEREO_TINT;
    expect(left.map((c, i) => c + right[i])).toEqual([1, 1, 1]);
  });
});

describe("greyscaleTint", () => {
  it("takes the hue out of each channel", () => {
    const { left, right } = greyscaleTint(STEREO_TINT);
    for (const [r, g, b] of [left, right]) {
      expect(g).toBe(r);
      expect(b).toBe(r);
    }
  });
});
