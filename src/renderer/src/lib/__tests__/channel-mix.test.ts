import { describe, expect, it } from "vitest";

import { toChannelCount } from "../channel-mix";

describe("toChannelCount", () => {
  it("keeps the channels it is given when the count already matches", () => {
    const channels = [new Float32Array([1, 2, 3])];
    expect(toChannelCount(channels, 1)).toBe(channels);
  });

  it("copies a mono channel across both stereo channels", () => {
    const [left, right] = toChannelCount([new Float32Array([0.5, -0.25])], 2);

    expect(Array.from(left)).toEqual([0.5, -0.25]);
    expect(Array.from(right)).toEqual([0.5, -0.25]);
    expect(left).not.toBe(right);
  });

  it("mixes stereo channels down at equal weight", () => {
    const mixed = toChannelCount([new Float32Array([1, 0, -1]), new Float32Array([0, 1, -1])], 1);

    expect(mixed).toHaveLength(1);
    expect(Array.from(mixed[0])).toEqual([0.5, 0.5, -1]);
  });

  it("leaves the source channels untouched", () => {
    const source = new Float32Array([1, 1]);
    toChannelCount([source, new Float32Array([-1, -1])], 1);
    expect(Array.from(source)).toEqual([1, 1]);
  });
});
