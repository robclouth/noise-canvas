import { describe, expect, it } from "vitest";
import { insertSpan, removeSpan } from "../ripple-edits";

const channel = (...values: number[]) => new Float32Array(values);

describe("removeSpan", () => {
  it("removes the span and closes the gap on every channel", () => {
    const out = removeSpan([channel(0, 1, 2, 3, 4, 5), channel(10, 11, 12, 13, 14, 15)], 2, 4);
    expect(Array.from(out[0])).toEqual([0, 1, 4, 5]);
    expect(Array.from(out[1])).toEqual([10, 11, 14, 15]);
  });

  it("clamps a span that runs past the ends", () => {
    const out = removeSpan([channel(0, 1, 2, 3)], -3, 99);
    expect(out[0].length).toBe(0);
  });

  it("leaves the audio alone for an empty span", () => {
    const out = removeSpan([channel(0, 1, 2, 3)], 2, 2);
    expect(Array.from(out[0])).toEqual([0, 1, 2, 3]);
  });
});

describe("removeSpan declick", () => {
  it("ramps both sides of the join to silence at the seam", () => {
    const source = new Float32Array(8).fill(1);
    const out = removeSpan([source], 2, 6, 2);
    // Join lands at index 2: both sides reach 0 at the seam and ramp away.
    expect(Array.from(out[0])).toEqual([0.5, 0, 0, 0.5]);
  });
});

describe("insertSpan", () => {
  it("splices the insert in and pushes what follows later", () => {
    const out = insertSpan([channel(0, 1, 2, 3)], 2, [channel(8, 9)]);
    expect(Array.from(out[0])).toEqual([0, 1, 8, 9, 2, 3]);
  });

  it("repeats a mono insert into every channel", () => {
    const out = insertSpan([channel(0, 1), channel(10, 11)], 1, [channel(7)]);
    expect(Array.from(out[0])).toEqual([0, 7, 1]);
    expect(Array.from(out[1])).toEqual([10, 7, 11]);
  });

  it("clamps the splice point into the file", () => {
    const out = insertSpan([channel(0, 1)], 99, [channel(5)]);
    expect(Array.from(out[0])).toEqual([0, 1, 5]);
  });

  it("ramps both sides of both seams to silence", () => {
    const source = new Float32Array(4).fill(1);
    const insert = new Float32Array(4).fill(1);
    const out = insertSpan([source], 2, [insert], 2);
    // Seams at 2 and 6; each has a 0 and a 0.5 on either side.
    expect(Array.from(out[0])).toEqual([0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5]);
  });
});
