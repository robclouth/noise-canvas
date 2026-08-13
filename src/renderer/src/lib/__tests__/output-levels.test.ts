import { describe, expect, it } from "vitest";
import { computeOutputLevels, LEVEL_HOP_SECONDS, outputLevelPoints, spliceOutputLevels } from "../output-levels";

const SR = 48000;
const HOP = Math.round(SR * LEVEL_HOP_SECONDS);

function makeBuffer(channels: Float32Array[]): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0].length, SR);
  const buffer = ctx.createBuffer(channels.length, channels[0].length, SR);
  channels.forEach((data, index) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, index));
  return buffer;
}

function levelsOf(channels: Float32Array[]) {
  return computeOutputLevels(makeBuffer(channels));
}

describe("computeOutputLevels", () => {
  it("returns nothing for a file with no audio yet", () => {
    expect(computeOutputLevels(undefined)).toBeNull();
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

  it("marks the slices that reach full scale", () => {
    const channel = new Float32Array(HOP * 3).fill(0.2);
    channel[HOP + 3] = 1.4;
    const levels = levelsOf([channel])!;
    expect(Array.from(levels.clipped)).toEqual([0, 1, 0]);
  });

  it("counts one point per hop of the buffer", () => {
    expect(outputLevelPoints(makeBuffer([new Float32Array(HOP * 3)]))).toBe(3);
    expect(outputLevelPoints(makeBuffer([new Float32Array(HOP * 3 + 1)]))).toBe(4);
  });
});

/** Float32 rounds, so peaks compare within a tolerance rather than exactly. */
function expectPeaks(actual: Float32Array, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 6));
}

describe("spliceOutputLevels", () => {
  const whole = {
    peaks: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]),
    clipped: Uint8Array.from([0, 0, 0, 0, 1]),
  };

  it("writes a commit's window over the levels it replaced, and leaves the rest", () => {
    const spliced = spliceOutputLevels(
      whole,
      { startHop: 1, peaks: Float32Array.from([0.9, 0.8]), clipped: Uint8Array.from([1, 0]) },
      5,
    );
    expectPeaks(spliced.peaks, [0.1, 0.9, 0.8, 0.4, 0.5]);
    expect(Array.from(spliced.clipped)).toEqual([0, 1, 0, 0, 1]);
  });

  it("hands back a new object, so a repaint keyed on identity sees the change", () => {
    const spliced = spliceOutputLevels(whole, { startHop: 0, peaks: whole.peaks, clipped: whole.clipped }, 5);
    expect(spliced).not.toBe(whole);
    expect(spliced.peaks).not.toBe(whole.peaks);
  });

  it("grows and shrinks with the buffer", () => {
    const longer = spliceOutputLevels(
      whole,
      { startHop: 5, peaks: Float32Array.from([0.7]), clipped: Uint8Array.from([0]) },
      6,
    );
    expectPeaks(longer.peaks, [0.1, 0.2, 0.3, 0.4, 0.5, 0.7]);

    const shorter = spliceOutputLevels(
      whole,
      { startHop: 0, peaks: Float32Array.from([0.6]), clipped: Uint8Array.from([0]) },
      3,
    );
    expectPeaks(shorter.peaks, [0.6, 0.2, 0.3]);
  });

  it("drops a window that runs past the end rather than overflowing", () => {
    const spliced = spliceOutputLevels(
      whole,
      { startHop: 4, peaks: Float32Array.from([0.9, 0.9, 0.9]), clipped: Uint8Array.from([1, 1, 1]) },
      5,
    );
    expectPeaks(spliced.peaks, [0.1, 0.2, 0.3, 0.4, 0.9]);
  });

  it("starts from nothing when the file has no levels yet", () => {
    const spliced = spliceOutputLevels(
      undefined,
      { startHop: 1, peaks: Float32Array.from([0.5]), clipped: Uint8Array.from([1]) },
      3,
    );
    expectPeaks(spliced.peaks, [0, 0.5, 0]);
    expect(Array.from(spliced.clipped)).toEqual([0, 1, 0]);
  });
});
