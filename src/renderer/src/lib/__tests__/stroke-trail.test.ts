import { describe, expect, it } from "vitest";
import { MAX_TRAIL_POINTS, strokeTrail } from "../stroke-trail";

const cell = (size: number) => (p: { x: number; y: number }) => ({
  x: Math.floor(p.x / size),
  y: Math.floor(p.y / size),
});
const sameCell = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;

describe("strokeTrail", () => {
  it("fills every grid cell a fast move skips, without either end", () => {
    const trail = strokeTrail(
      [
        { x: 5, y: 5 },
        { x: 95, y: 5 },
      ],
      5,
      5,
      cell(10),
      sameCell,
    );
    expect(trail.map((p) => p.x)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("follows every segment of a coalesced path", () => {
    const trail = strokeTrail(
      [
        { x: 5, y: 5 },
        { x: 35, y: 5 },
        { x: 35, y: 35 },
      ],
      5,
      5,
      cell(10),
      sameCell,
    );
    expect(trail).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ]);
  });

  it("queues nothing for a move inside one cell", () => {
    expect(
      strokeTrail(
        [
          { x: 1, y: 1 },
          { x: 8, y: 3 },
        ],
        5,
        5,
        cell(10),
        sameCell,
      ),
    ).toEqual([]);
  });

  it("skips positions that resolve to nothing", () => {
    const trail = strokeTrail(
      [
        { x: 5, y: 5 },
        { x: 55, y: 5 },
      ],
      5,
      5,
      (p) => (p.x > 20 && p.x < 40 ? null : cell(10)(p)),
      sameCell,
    );
    expect(trail.map((p) => p.x)).toEqual([1, 2, 4]);
  });

  it("spaces a very long jump wider rather than queueing without bound", () => {
    const trail = strokeTrail(
      [
        { x: 0, y: 0 },
        { x: 100000, y: 0 },
      ],
      1,
      1,
      (p) => ({ x: p.x, y: p.y }),
      (a, b) => a.x === b.x,
    );
    expect(trail.length).toBeLessThanOrEqual(MAX_TRAIL_POINTS);
    expect(trail.length).toBeGreaterThan(MAX_TRAIL_POINTS / 2);
  });
});
