import { describe, expect, it } from "vitest";
import { applyAudioEdits, audioHopBytes, buildAudioHop, editsAlongHops, type AudioHop } from "../audio-hop";

function ramp(length: number, offset = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i + offset;
  return out;
}

describe("buildAudioHop", () => {
  it("cuts the rewritten span from both sides and keeps each side's readings", () => {
    const existing = [ramp(20), ramp(20, 100)];
    const result = [ramp(20, 1000), ramp(20, 2000)];
    const hop = buildAudioHop({
      existing,
      result,
      start: 5,
      end: 9,
      beforeMeta: { peak: 0.4 },
      afterMeta: { peak: 0.8, maxGainReductionDb: 2 },
    })!;
    expect(hop.start).toBe(5);
    expect(hop.end).toBe(9);
    expect(Array.from(hop.before[0])).toEqual([5, 6, 7, 8]);
    expect(Array.from(hop.before[1])).toEqual([105, 106, 107, 108]);
    expect(Array.from(hop.after[0])).toEqual([1005, 1006, 1007, 1008]);
    expect(hop.afterMeta.maxGainReductionDb).toBe(2);
    expect(audioHopBytes(hop)).toBe(4 * 4 * 4);
  });

  it("clamps the span to the buffer and refuses mismatched channels", () => {
    const hop = buildAudioHop({
      existing: [ramp(10)],
      result: [ramp(10, 50)],
      start: -3,
      end: 40,
      beforeMeta: { peak: 1 },
      afterMeta: { peak: 1 },
    })!;
    expect(hop.start).toBe(0);
    expect(hop.end).toBe(10);
    expect(
      buildAudioHop({
        existing: [ramp(10)],
        result: [ramp(10), ramp(10)],
        start: 0,
        end: 5,
        beforeMeta: { peak: 1 },
        afterMeta: { peak: 1 },
      }),
    ).toBeNull();
    expect(
      buildAudioHop({
        existing: [ramp(9)],
        result: [ramp(10)],
        start: 0,
        end: 5,
        beforeMeta: { peak: 1 },
        afterMeta: { peak: 1 },
      }),
    ).toBeNull();
  });
});

describe("applyAudioEdits", () => {
  it("writes each edit in order so a later one wins where they overlap, and reports the span", () => {
    const channels = [new Float32Array(12), new Float32Array(12)];
    const span = applyAudioEdits(channels, [
      { start: 2, channels: [Float32Array.from([1, 1, 1]), Float32Array.from([5, 5, 5])] },
      { start: 3, channels: [Float32Array.from([2, 2]), Float32Array.from([6, 6])] },
    ]);
    expect(span).toEqual({ start: 2, end: 5 });
    expect(Array.from(channels[0])).toEqual([0, 0, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(channels[1])).toEqual([0, 0, 5, 6, 6, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("stops at the end of the buffer", () => {
    const channels = [new Float32Array(4)];
    const span = applyAudioEdits(channels, [{ start: 2, channels: [Float32Array.from([7, 7, 7, 7])] }]);
    expect(span).toEqual({ start: 2, end: 4 });
    expect(Array.from(channels[0])).toEqual([0, 0, 7, 7]);
    expect(applyAudioEdits(channels, [])).toBeNull();
  });
});

describe("editsAlongHops", () => {
  const hopA: AudioHop = {
    start: 0,
    end: 2,
    before: [Float32Array.from([1, 1])],
    after: [Float32Array.from([2, 2])],
    beforeMeta: { peak: 0.1 },
    afterMeta: { peak: 0.2 },
  };
  const hopB: AudioHop = {
    start: 1,
    end: 3,
    before: [Float32Array.from([3, 3])],
    after: [Float32Array.from([4, 4])],
    beforeMeta: { peak: 0.3 },
    afterMeta: { peak: 0.4 },
  };

  it("undoes with each hop's before, in walking order, and arrives at the last hop's readings", () => {
    const walk = editsAlongHops([hopB, hopA], [])!;
    expect(walk.edits).toEqual([
      { start: 1, channels: hopB.before },
      { start: 0, channels: hopA.before },
    ]);
    expect(walk.meta).toBe(hopA.beforeMeta);
  });

  it("crosses a fork: up with befores, then down with afters", () => {
    const walk = editsAlongHops([hopA], [hopB])!;
    expect(walk.edits).toEqual([
      { start: 0, channels: hopA.before },
      { start: 1, channels: hopB.after },
    ]);
    expect(walk.meta).toBe(hopB.afterMeta);
    expect(editsAlongHops([], [])).toBeNull();
  });
});
