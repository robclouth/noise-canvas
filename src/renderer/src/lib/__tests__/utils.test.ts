import { describe, expect, it } from "vitest";
import { Vector2 } from "three";
import { screenToZoomed, zoomedToScreen } from "../utils";

describe("screenToZoomed / zoomedToScreen", () => {
  describe("scalar (x-only) backwards-compat", () => {
    it("passes through when zoom is 0", () => {
      const uv = new Vector2(0.3, 0.7);
      const z = screenToZoomed(uv, 0, 0);
      expect(z.x).toBeCloseTo(0.3);
      expect(z.y).toBeCloseTo(0.7);
    });

    it("zooms x only at offset 0", () => {
      // power=1 → zoom 2x → view width 0.5 → uv.x=0.5 maps to 0.25
      const z = screenToZoomed(new Vector2(0.5, 0.5), 1, 0);
      expect(z.x).toBeCloseTo(0.25);
      expect(z.y).toBeCloseTo(0.5);
    });

    it("round-trips via zoomedToScreen", () => {
      const original = new Vector2(0.42, 0.88);
      const zoomed = screenToZoomed(original, 2, 0.3);
      const back = zoomedToScreen(zoomed, 2, 0.3);
      expect(back.x).toBeCloseTo(original.x);
      expect(back.y).toBeCloseTo(original.y);
    });
  });

  describe("2D (Vector2) mode", () => {
    it("passes through when both zooms are 0", () => {
      const uv = new Vector2(0.25, 0.75);
      const z = screenToZoomed(uv, new Vector2(0, 0), new Vector2(0, 0));
      expect(z.x).toBeCloseTo(0.25);
      expect(z.y).toBeCloseTo(0.75);
    });

    it("zooms y only", () => {
      // y-zoom power=1 → 2x, offset y=0 → top half of data
      const z = screenToZoomed(new Vector2(0.5, 0.5), new Vector2(0, 1), new Vector2(0, 0));
      expect(z.x).toBeCloseTo(0.5);
      expect(z.y).toBeCloseTo(0.25);
    });

    it("zooms both axes independently", () => {
      const z = screenToZoomed(
        new Vector2(0.5, 0.5),
        new Vector2(1, 2),
        new Vector2(0, 0),
      );
      expect(z.x).toBeCloseTo(0.25); // 2x on x
      expect(z.y).toBeCloseTo(0.125); // 4x on y
    });

    it("applies y offset", () => {
      // zoom 2x, offset 1 → viewStart 0.5 → centre screen = 0.75 in zoomed
      const z = screenToZoomed(new Vector2(0.5, 0.5), new Vector2(0, 1), new Vector2(0, 1));
      expect(z.y).toBeCloseTo(0.75);
    });

    it("round-trips in 2D", () => {
      const original = new Vector2(0.33, 0.66);
      const zp = new Vector2(1.5, 2.5);
      const of = new Vector2(0.4, 0.2);
      const zoomed = screenToZoomed(original, zp, of);
      const back = zoomedToScreen(zoomed, zp, of);
      expect(back.x).toBeCloseTo(original.x);
      expect(back.y).toBeCloseTo(original.y);
    });
  });
});
