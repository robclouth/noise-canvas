import { describe, expect, it } from "vitest";
import { Vector2 } from "three";
import { screenToZoomed, stepSwungGrid, swungGridCellWidthUv, zoomedToScreen } from "../utils";

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
      const z = screenToZoomed(new Vector2(0.5, 0.5), new Vector2(1, 2), new Vector2(0, 0));
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

describe("swungGridCellWidthUv", () => {
  // 120 bpm, 1-beat grid → 0.5s cells; 8s file → 16 straight cells.
  const bpm = 120;
  const totalDuration = 8;
  const gridSizeBeats = 1;
  const gridInterval = (60 / bpm) * gridSizeBeats; // 0.5s
  const gridIntervalUv = gridInterval / totalDuration;

  const opts = (over: Partial<Parameters<typeof swungGridCellWidthUv>[1]> = {}) => ({
    brushSizeTime: 0,
    gridSizeBeats,
    gridSwing: 0,
    snapTime: true,
    ...over,
  });

  it("returns null when snap is off or the brush size is not Grid", () => {
    expect(swungGridCellWidthUv(0.25, opts({ snapTime: false }), bpm, totalDuration)).toBeNull();
    expect(swungGridCellWidthUv(0.25, opts({ brushSizeTime: 1 }), bpm, totalDuration)).toBeNull();
  });

  it("equals the constant grid width when swing is zero", () => {
    const w = swungGridCellWidthUv(0.25, opts({ gridSwing: 0 }), bpm, totalDuration);
    expect(w).toBeCloseTo(gridIntervalUv, 6);
  });

  it("alternates wide/narrow cells that sum to two grid intervals under swing", () => {
    const swing = 60;
    const even = swungGridCellWidthUv(0, opts({ gridSwing: swing }), bpm, totalDuration)!;
    // Sample inside the first odd cell to land on it.
    const oddStartUv = stepSwungGrid(0, gridInterval, swing / 100, 1) / totalDuration;
    const odd = swungGridCellWidthUv(oddStartUv + 1e-6, opts({ gridSwing: swing }), bpm, totalDuration)!;
    expect(even).toBeGreaterThan(odd);
    expect(even + odd).toBeCloseTo(2 * gridIntervalUv, 6);
  });

  it("makes corner-anchor stamps tile with no gaps or overlaps under swing", () => {
    const swing = 60;
    // Walk the swung cells across the file; each stamp's BL is the cell start and
    // its width is the swung cell width. The right edge must land exactly on the
    // next cell start — no gap, no overlap — at every cell.
    let cellStart = 0;
    while (cellStart < totalDuration - 1e-9) {
      const blUv = cellStart / totalDuration;
      const width = swungGridCellWidthUv(blUv, opts({ gridSwing: swing }), bpm, totalDuration)!;
      const nextCellStart = stepSwungGrid(cellStart, gridInterval, swing / 100, 1);
      expect(blUv + width).toBeCloseTo(nextCellStart / totalDuration, 6);
      cellStart = nextCellStart;
    }
  });
});
