import { describe, expect, it } from "vitest";

import { parameterDefs } from "../../parameters";
import type { SliderMark } from "../../store/types";
import { advanceMarkFraction, markFraction, markIndexFromFraction, pixelsPerMark } from "../numbox-drag";

/** Every parameter that offers preset values, which a plain drag now walks. */
const markedParameters = Object.entries(parameterDefs).flatMap(([key, def]) => {
  const marks = "marks" in def ? (def.marks as SliderMark[] | undefined) : undefined;
  return marks?.length ? [{ key, def, marks }] : [];
});

/** Walks a mark list with the same maths the control drags with. */
function dragThrough(marks: SliderMark[], startValue: number, deltaPxPerStep: number, steps: number): number[] {
  let fraction = markFraction(startValue, marks);
  const visited: number[] = [];
  for (let i = 0; i < steps; i++) {
    fraction = advanceMarkFraction(fraction, deltaPxPerStep, marks.length);
    visited.push(marks[markIndexFromFraction(fraction, marks.length)].value);
  }
  return visited;
}

describe("mark lists", () => {
  it("finds parameters to check", () => {
    expect(markedParameters.length).toBeGreaterThan(10);
  });

  it.each(markedParameters.map((p) => [p.key, p.marks] as const))("%s is in ascending value order", (_key, marks) => {
    const values = marks.map((m) => m.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it.each(markedParameters.map((p) => [p.key, p.marks] as const))("%s has no repeated value", (_key, marks) => {
    const values = marks.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("pixelsPerMark", () => {
  it("holds a full sweep near the plain-drag travel of 200px", () => {
    for (const count of [12, 24, 29, 57]) {
      const sweep = pixelsPerMark(count) * (count - 1);
      expect(sweep).toBeGreaterThanOrEqual(150);
      expect(sweep).toBeLessThanOrEqual(400);
    }
  });

  it("never asks for a sub-pixel step", () => {
    for (const count of [2, 50, 500, 5000]) expect(pixelsPerMark(count)).toBeGreaterThanOrEqual(3);
  });
});

describe("markFraction", () => {
  const marks: SliderMark[] = [
    { value: 0, label: "0" },
    { value: 1, label: "1" },
    { value: 4, label: "4" },
  ];

  it("returns the index of a value sitting on a mark", () => {
    expect(markFraction(0, marks)).toBe(0);
    expect(markFraction(1, marks)).toBe(1);
    expect(markFraction(4, marks)).toBe(2);
  });

  it("returns a fraction between the two marks a free value sits on", () => {
    expect(markFraction(2.5, marks)).toBeCloseTo(1.5, 10);
  });

  it("clamps outside the list", () => {
    expect(markFraction(-99, marks)).toBe(0);
    expect(markFraction(99, marks)).toBe(2);
  });

  it("is empty-safe", () => {
    expect(markFraction(3, [])).toBe(0);
  });
});

describe("stepped drag", () => {
  it.each(markedParameters.map((p) => [p.key, p.marks] as const))(
    "%s reaches every one of its marks in one sweep",
    (_key, marks) => {
      const px = pixelsPerMark(marks.length);
      const swept = dragThrough(marks, marks[0].value, px, marks.length * 2);
      expect(new Set([marks[0].value, ...swept]).size).toBe(marks.length);
    },
  );

  it.each(markedParameters.map((p) => [p.key, p.marks] as const))("%s never goes backwards", (_key, marks) => {
    const visited = dragThrough(marks, marks[0].value, pixelsPerMark(marks.length) / 4, marks.length * 12);
    for (let i = 1; i < visited.length; i++) expect(visited[i]).toBeGreaterThanOrEqual(visited[i - 1]);
  });

  it("steps one mark at a time, not one per pixel", () => {
    const marks = markedParameters.find((p) => p.key === "gridSizeBeats")?.marks;
    if (!marks) throw new Error("gridSizeBeats has no marks");
    const px = pixelsPerMark(marks.length);
    expect(dragThrough(marks, marks[0].value, px, 3)).toEqual([marks[1].value, marks[2].value, marks[3].value]);
  });

  it("resumes from a value a fine drag left off the grid", () => {
    const marks: SliderMark[] = [
      { value: 0, label: "0" },
      { value: 1, label: "1" },
      { value: 2, label: "2" },
    ];
    const px = pixelsPerMark(marks.length);
    // 1.4 sits nearer 1, so the smallest nudge each way lands on 1 then 2.
    expect(dragThrough(marks, 1.4, -1, 1)).toEqual([1]);
    expect(dragThrough(marks, 1.4, px, 1)).toEqual([2]);
  });

  it("holds the ends of the list", () => {
    const marks: SliderMark[] = [
      { value: 0, label: "0" },
      { value: 1, label: "1" },
    ];
    expect(dragThrough(marks, 0, -500, 3)).toEqual([0, 0, 0]);
    expect(dragThrough(marks, 1, 500, 3)).toEqual([1, 1, 1]);
  });
});

describe("markIndexFromFraction", () => {
  it("rounds to the nearer mark", () => {
    expect(markIndexFromFraction(1.4, 5)).toBe(1);
    expect(markIndexFromFraction(1.6, 5)).toBe(2);
  });

  it("clamps to the list", () => {
    expect(markIndexFromFraction(-3, 5)).toBe(0);
    expect(markIndexFromFraction(99, 5)).toBe(4);
    expect(markIndexFromFraction(0, 0)).toBe(0);
  });
});
