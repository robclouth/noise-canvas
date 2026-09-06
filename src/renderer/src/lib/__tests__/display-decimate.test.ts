import { describe, expect, it } from "vitest";

import { clampToSourceBins } from "../display-decimate";

describe("clampToSourceBins", () => {
  it("keeps only bins whose tap lies inside the source bins", () => {
    expect(clampToSourceBins(2, 6, 4, 10, 19)).toEqual({ start: 3, end: 5 });
  });

  it("is the identity when the source spans every tap", () => {
    expect(clampToSourceBins(2, 6, 4, 0, 24)).toEqual({ start: 2, end: 6 });
  });

  it("keeps a tap on the first source bin and drops one on the end bin", () => {
    expect(clampToSourceBins(0, 10, 4, 8, 16)).toEqual({ start: 2, end: 4 });
  });

  it("returns an empty run when no tap lands inside", () => {
    const clamped = clampToSourceBins(0, 2, 4, 9, 11);
    expect(clamped.end).toBeLessThanOrEqual(clamped.start);
  });
});
