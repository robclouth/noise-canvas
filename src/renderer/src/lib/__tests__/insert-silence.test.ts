import { describe, expect, it } from "vitest";
import { insertSilence, silenceCutSample } from "../insert-silence";

const ramp = (length: number): Float32Array => Float32Array.from({ length }, (_, i) => i + 1);

describe("silenceCutSample", () => {
  it("puts a start insert before the audio and an end insert after it", () => {
    expect(silenceCutSample("start", 100, 40)).toBe(0);
    expect(silenceCutSample("end", 100, 40)).toBe(100);
  });

  it("clamps the play start to the audio it splits", () => {
    expect(silenceCutSample("play-start", 100, 40.4)).toBe(40);
    expect(silenceCutSample("play-start", 100, 500)).toBe(100);
    expect(silenceCutSample("play-start", 100, -5)).toBe(0);
  });
});

describe("insertSilence", () => {
  it("keeps every sample, in order, around the gap", () => {
    const [result] = insertSilence([ramp(6)], "play-start", 3, 4);

    expect(result.length).toBe(9);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 0, 0, 0, 5, 6]);
  });

  it("pads the front for a start insert and the back for an end insert", () => {
    const [front] = insertSilence([ramp(3)], "start", 2, 0);
    const [back] = insertSilence([ramp(3)], "end", 2, 0);

    expect(Array.from(front)).toEqual([0, 0, 1, 2, 3]);
    expect(Array.from(back)).toEqual([1, 2, 3, 0, 0]);
  });

  it("splits every channel at the same sample", () => {
    const channels = insertSilence([ramp(4), ramp(4)], "play-start", 2, 2);

    expect(channels).toHaveLength(2);
    for (const channel of channels) expect(Array.from(channel)).toEqual([1, 2, 0, 0, 3, 4]);
  });

  it("returns the channels untouched when there is nothing to insert", () => {
    const channels = [ramp(4)];

    expect(insertSilence(channels, "end", 0, 0)).toBe(channels);
  });
});
