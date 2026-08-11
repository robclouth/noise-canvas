import { zoneSlice, inferZoneCount } from "@renderer/lib/generate/zones";
import { evaluatePattern, queryStamps, type StampEvent } from "@renderer/lib/generate/pattern-engine";
import { BRUSH_SIZE_PITCH_FULL } from "@renderer/lib/utils";
import { describe, expect, it } from "vitest";

const stampsFor = (code: string, cycles = 1) => queryStamps(evaluatePattern(code), cycles, 0);

describe("inferZoneCount", () => {
  it("counts the slices a pattern reaches", () => {
    expect(inferZoneCount(stampsFor('s("x*4").zone("0 1 2 3")'))).toBe(4);
    expect(inferZoneCount(stampsFor('s("x*3").zone("0 1 2")'))).toBe(3);
    expect(inferZoneCount(stampsFor('s("x*2").zone("0 2")'))).toBe(3);
  });

  it("falls back to one slice when the pattern names no zone", () => {
    expect(inferZoneCount(stampsFor('"x*4"'))).toBe(1);
  });

  it("ignores events that state their own count", () => {
    const events: StampEvent[] = [
      { beats: 0, durationBeats: 1, brushToken: "x", semis: 0, zoneIndex: 7, zoneCount: 8 },
      { beats: 1, durationBeats: 1, brushToken: "x", semis: 0, zoneIndex: 1 },
    ];
    expect(inferZoneCount(events)).toBe(2);
  });
});

describe("zoneSlice", () => {
  it("cuts the spectrum into equal slices from the bottom up", () => {
    expect(zoneSlice(0, 4, 120)).toEqual({ anchorSemis: 0, heightSemis: 30 });
    expect(zoneSlice(1, 4, 120)).toEqual({ anchorSemis: 30, heightSemis: 30 });
    expect(zoneSlice(3, 4, 120)).toEqual({ anchorSemis: 90, heightSemis: 30 });
  });

  it("uses the Full size for a single slice", () => {
    expect(zoneSlice(0, 1, 120)).toEqual({ anchorSemis: 0, heightSemis: BRUSH_SIZE_PITCH_FULL });
  });

  it("wraps indices past the top back to the bottom", () => {
    expect(zoneSlice(4, 4, 120).anchorSemis).toBe(0);
    expect(zoneSlice(5, 4, 120).anchorSemis).toBe(30);
    expect(zoneSlice(-1, 4, 120).anchorSemis).toBe(90);
  });

  it("treats a count below one as the whole spectrum", () => {
    expect(zoneSlice(0, 0, 120).heightSemis).toBe(BRUSH_SIZE_PITCH_FULL);
  });

  it("slices tile the spectrum without gaps or overlap", () => {
    const count = 6;
    const slices = Array.from({ length: count }, (_, i) => zoneSlice(i, count, 96));
    for (let i = 1; i < count; i++) {
      expect(slices[i].anchorSemis).toBeCloseTo(slices[i - 1].anchorSemis + slices[i - 1].heightSemis, 10);
    }
    expect(slices[0].anchorSemis).toBe(0);
    const top = slices[count - 1];
    expect(top.anchorSemis + top.heightSemis).toBeCloseTo(96, 10);
  });
});

describe("zone controls in patterns", () => {
  it("reads the slice index and count from the pattern", () => {
    const [first, second] = stampsFor('s("x*2").zone("0 1").zones("4")');
    expect(first.zoneIndex).toBe(0);
    expect(first.zoneCount).toBe(4);
    expect(second.zoneIndex).toBe(1);
  });

  it("leaves the fields unset when the pattern names no zone", () => {
    const [only] = stampsFor('"x"');
    expect(only.zoneIndex).toBeUndefined();
    expect(only.zoneCount).toBeUndefined();
  });
});
