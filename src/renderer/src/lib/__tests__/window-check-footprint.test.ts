import { describe, expect, it } from "vitest";
import {
  committedFootprints,
  drag,
  expectedStrokeSpan,
  scriptedPositions,
  strokeSpanFailure,
  type TimeSpan,
} from "../../../../../scripts/window-check-footprint";

function commitLines(bounds: TimeSpan): string[] {
  return [
    `[timing] addStroke footprint time bounds {fileId: fixture, timeMin: ${bounds.timeMin}, timeMax: ${bounds.timeMax}}`,
    "[timing] addStroke footprint delta {ms: 1, ranges: 153, footprintPixels: 2100000}",
  ];
}

describe("window-check stroke coverage", () => {
  it("derives both edges from the scripted drag and return", () => {
    expect(scriptedPositions).toHaveLength(drag.steps + 2);
    expect(expectedStrokeSpan().timeMin).toBeCloseTo(0.025, 12);
    expect(expectedStrokeSpan().timeMax).toBeCloseTo(0.925, 12);
    expect(strokeSpanFailure(committedFootprints(commitLines(expectedStrokeSpan()))[0])).toBeNull();
  });

  it.each([
    { name: "left end", positions: scriptedPositions.slice(0, -1), absent: "right end" },
    { name: "right end", positions: scriptedPositions.filter((position) => position <= 0.5), absent: "left end" },
  ])("names a missing $name even when the pixel count meets the floor", ({ name, positions, absent }) => {
    const [footprint] = committedFootprints(commitLines(expectedStrokeSpan(positions)));
    const failure = strokeSpanFailure(footprint);
    expect(failure).toContain(`missing ${name}`);
    expect(failure).not.toContain(absent);
    expect(failure).toContain("comparison is inconclusive");
  });

  it("names both missing ends when a drag finishes before reaching either extreme", () => {
    const [footprint] = committedFootprints(commitLines(expectedStrokeSpan(scriptedPositions.slice(0, 11))));
    expect(strokeSpanFailure(footprint)).toContain("left end");
    expect(strokeSpanFailure(footprint)).toContain("right end");
  });

  it("keeps each commit's bounds separate and never borrows the preceding commit's bounds", () => {
    const full = commitLines(expectedStrokeSpan());
    const partial = commitLines(expectedStrokeSpan(scriptedPositions.slice(0, -1)));
    const footprints = committedFootprints([...full, ...partial, full[1]]);
    expect(footprints).toHaveLength(3);
    expect(strokeSpanFailure(footprints[0])).toBeNull();
    expect(strokeSpanFailure(footprints[1])).toContain("left end");
    expect(footprints[2].bounds).toBeNull();
    expect(strokeSpanFailure(footprints[2])).toContain("coverage is unknown");
    expect(committedFootprints([])).toEqual([]);
  });

  it.each(["timeMin: null, timeMax: null", "timeMin: 0.9, timeMax: 0.1", "timeMin: -1e999, timeMax: 1e999"])(
    "refuses unusable bounds: %s",
    (bounds) => {
      const [footprint] = committedFootprints([
        `[timing] addStroke footprint time bounds {fileId: fixture, ${bounds}}`,
        commitLines(expectedStrokeSpan())[1],
      ]);
      expect(strokeSpanFailure(footprint)).toContain("coverage is unknown");
    },
  );
});
