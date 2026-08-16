import { describe, expect, it } from "vitest";

import { channelsFromLayout } from "../ffmpeg";

/**
 * ffmpeg names a stream's channel layout rather than counting it. An
 * unrecognised name used to default to one channel, which opened a
 * multichannel file as a silent mono downmix.
 */
describe("ffmpeg channel layouts", () => {
  it("reads the named layouts", () => {
    expect(channelsFromLayout("mono")).toBe(1);
    expect(channelsFromLayout("stereo")).toBe(2);
    expect(channelsFromLayout("quad")).toBe(4);
    expect(channelsFromLayout("quad(side)")).toBe(4);
    expect(channelsFromLayout("hexagonal")).toBe(6);
    expect(channelsFromLayout("octagonal")).toBe(8);
    expect(channelsFromLayout("downmix")).toBe(2);
  });

  it("reads the surround layouts", () => {
    expect(channelsFromLayout("2.1")).toBe(3);
    expect(channelsFromLayout("5.1")).toBe(6);
    expect(channelsFromLayout("5.1(side)")).toBe(6);
    expect(channelsFromLayout("7.1")).toBe(8);
  });

  it("reads the bare count ffmpeg falls back to", () => {
    expect(channelsFromLayout("12 channels")).toBe(12);
    expect(channelsFromLayout("1 channels")).toBe(1);
  });

  it("reports nothing rather than a silent downmix for a layout it cannot read", () => {
    expect(channelsFromLayout("ambisonic gibberish")).toBe(0);
    expect(channelsFromLayout("")).toBe(0);
  });
});
