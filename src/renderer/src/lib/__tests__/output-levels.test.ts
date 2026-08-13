import { describe, expect, it } from "vitest";
import { getOutputLevels, LEVEL_HOP_SECONDS } from "../output-levels";

const SR = 48000;
const HOP = Math.round(SR * LEVEL_HOP_SECONDS);

function makeBuffer(channels: Float32Array[]): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0].length, SR);
  const buffer = ctx.createBuffer(channels.length, channels[0].length, SR);
  channels.forEach((data, index) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, index));
  return buffer;
}

function levelsOf(channels: Float32Array[], gainReductionDb?: Float32Array) {
  return getOutputLevels(makeBuffer(channels), gainReductionDb);
}

describe("getOutputLevels", () => {
  it("returns nothing for a file with no audio yet", () => {
    expect(getOutputLevels(undefined, undefined)).toBeNull();
  });

  it("takes the peak of each hop, not its average", () => {
    const channel = new Float32Array(HOP * 3);
    // One lone spike in the middle hop; everything else is quiet.
    channel.fill(0.05);
    channel[HOP + 7] = 0.8;
    const levels = levelsOf([channel])!;
    expect(levels.peaks).toHaveLength(3);
    expect(levels.peaks[0]).toBeCloseTo(0.05, 5);
    expect(levels.peaks[1]).toBeCloseTo(0.8, 5);
    expect(levels.peaks[2]).toBeCloseTo(0.05, 5);
  });

  it("takes the loudest channel", () => {
    const quiet = new Float32Array(HOP).fill(0.1);
    const loud = new Float32Array(HOP).fill(0.6);
    expect(levelsOf([quiet, loud])!.peaks[0]).toBeCloseTo(0.6, 5);
  });

  it("marks samples past full scale when the limiter is bypassed", () => {
    const channel = new Float32Array(HOP * 3).fill(0.2);
    channel[HOP + 3] = 1.4;
    const levels = levelsOf([channel])!;
    expect(Array.from(levels.clipped)).toEqual([0, 1, 0]);
  });

  it("marks where the limiter is holding the output down", () => {
    // Nothing reaches full scale — the limiter already pulled it back — so the
    // envelope is the only thing that says the headroom ran out.
    const channel = new Float32Array(HOP * 4).fill(0.7);
    const gainReductionDb = Float32Array.from([0, 0, 3.5, 0]);
    const levels = levelsOf([channel], gainReductionDb)!;
    expect(Math.max(...levels.peaks)).toBeLessThan(1);
    expect(Array.from(levels.clipped)).toEqual([0, 0, 1, 0]);
  });

  it("reuses the result until the audio is replaced", () => {
    const buffer = makeBuffer([new Float32Array(HOP).fill(0.3)]);

    const first = getOutputLevels(buffer, undefined)!;
    expect(getOutputLevels(buffer, undefined)).toBe(first);

    const second = levelsOf([new Float32Array(HOP).fill(0.9)])!;
    expect(second).not.toBe(first);
    expect(second.peaks[0]).toBeCloseTo(0.9, 5);
  });
});
