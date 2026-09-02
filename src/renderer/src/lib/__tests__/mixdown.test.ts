import { describe, expect, it } from "vitest";

import { toChannelCount } from "../channel-mix";
import { mixdown, mixdownShape } from "../mixdown";
import { setChannelsLength } from "../set-length";

describe("mixdownShape", () => {
  it("takes the widest channel count and the longest length", () => {
    const shape = mixdownShape([
      [new Float32Array(4)],
      [new Float32Array(9), new Float32Array(9)],
      [new Float32Array(2)],
    ]);

    expect(shape).toEqual({ numChannels: 2, length: 9 });
  });

  it("reports nothing for no parts", () => {
    expect(mixdownShape([])).toEqual({ numChannels: 0, length: 0 });
  });
});

describe("mixdown", () => {
  it("sums parts sample by sample", () => {
    const mix = mixdown([[Float32Array.from([1, 2, 3])], [Float32Array.from([10, 20, 30])]]);

    expect(Array.from(mix[0])).toEqual([11, 22, 33]);
  });

  it("runs a short part out into silence", () => {
    const mix = mixdown([[Float32Array.from([1, 1, 1, 1])], [Float32Array.from([5, 5])]]);

    expect(Array.from(mix[0])).toEqual([6, 6, 1, 1]);
  });

  it("fits a narrow part the way a file changing channel count is fitted", () => {
    const mono = Float32Array.from([1, 2]);
    const stereo = [Float32Array.from([10, 20]), Float32Array.from([30, 40])];

    const mix = mixdown([stereo, [mono]]);
    const fitted = toChannelCount([mono], 2);

    expect(mix).toHaveLength(2);
    expect(Array.from(mix[0])).toEqual([10 + fitted[0][0], 20 + fitted[0][1]]);
    expect(Array.from(mix[1])).toEqual([30 + fitted[1][0], 40 + fitted[1][1]]);
  });

  it("leaves a single part as it was", () => {
    const mix = mixdown([[Float32Array.from([0.25, -0.5])]]);

    expect(Array.from(mix[0])).toEqual([0.25, -0.5]);
  });

  it("returns nothing for no parts", () => {
    expect(mixdown([])).toEqual([]);
  });
});

describe("setChannelsLength", () => {
  it("cuts every channel at the target", () => {
    const cut = setChannelsLength([Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])], 2);

    expect(Array.from(cut[0])).toEqual([1, 2]);
    expect(Array.from(cut[1])).toEqual([5, 6]);
  });

  it("pads with silence past the end of the source", () => {
    const padded = setChannelsLength([Float32Array.from([1, 2])], 5);

    expect(Array.from(padded[0])).toEqual([1, 2, 0, 0, 0]);
  });

  it("hands back the same arrays at the length they already are", () => {
    const channels = [Float32Array.from([1, 2, 3])];

    expect(setChannelsLength(channels, 3)[0]).toBe(channels[0]);
  });

  it("makes every channel the same length whatever they started at", () => {
    const evened = setChannelsLength([new Float32Array(3), new Float32Array(9)], 6);

    expect(evened.map((channel) => channel.length)).toEqual([6, 6]);
  });
});
