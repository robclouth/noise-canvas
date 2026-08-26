import { describe, expect, it } from "vitest";
import { insertSilence, silenceCutSample } from "../insert-silence";

const ramp = (length: number): Float32Array => Float32Array.from({ length }, (_, i) => i + 1);

describe("silenceCutSample", () => {
  it("clamps the cut to the audio it splits", () => {
    expect(silenceCutSample(100, 40.4)).toBe(40);
    expect(silenceCutSample(100, 500)).toBe(100);
    expect(silenceCutSample(100, -5)).toBe(0);
  });
});

describe("insertSilence", () => {
  it("keeps every sample, in order, around the gap", () => {
    const [result] = insertSilence([ramp(6)], 4, 3);

    expect(result.length).toBe(9);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 0, 0, 0, 5, 6]);
  });

  it("pads the front for a cut at zero and the back for a cut at the end", () => {
    const [front] = insertSilence([ramp(3)], 0, 2);
    const [back] = insertSilence([ramp(3)], 3, 2);

    expect(Array.from(front)).toEqual([0, 0, 1, 2, 3]);
    expect(Array.from(back)).toEqual([1, 2, 3, 0, 0]);
  });

  it("splits every channel at the same sample", () => {
    const channels = insertSilence([ramp(4), ramp(4)], 2, 2);

    expect(channels).toHaveLength(2);
    for (const channel of channels) expect(Array.from(channel)).toEqual([1, 2, 0, 0, 3, 4]);
  });

  it("returns the channels untouched when there is nothing to insert", () => {
    const channels = [ramp(4)];

    expect(insertSilence(channels, 4, 0)).toBe(channels);
  });
});
