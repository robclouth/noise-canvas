import { describe, expect, it } from "vitest";

import { CarriedPaint, type CarriedRead } from "../carried-paint";

/** Four floats per pixel, distinct per pixel and per generation. */
function pixels(from: number, count: number, generation: number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = (from + i) * 10 + c + generation * 1000;
  }
  return out;
}

/** A read that brings back `values` and no stroke masks. */
function read(values: Float32Array): CarriedRead {
  return { values, masks: [] };
}

/** One mask weight per pixel, distinct per pixel and per generation. */
function weights(from: number, count: number, generation: number): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => (from + i) / 100 + generation);
}

describe("CarriedPaint", () => {
  it("writes what it carries into any range list, leaving the rest alone", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 6]), Promise.resolve(read(pixels(10, 6, 1))));
    carried.carry(
      Uint32Array.from([12, 2, 20, 3]),
      Promise.resolve(read(Float32Array.from([...pixels(12, 2, 2), ...pixels(20, 3, 2)]))),
    );
    await carried.settled();

    // Out of order, starting inside carried runs, and cutting across both carries.
    const ranges = Uint32Array.from([21, 2, 11, 4, 30, 2]);
    const out = new Float32Array(8 * 4).fill(-1);
    carried.copyInto(out, ranges);
    const expected = [
      ...pixels(21, 2, 2),
      ...pixels(11, 1, 1),
      ...pixels(12, 2, 2),
      ...pixels(14, 1, 1),
      ...new Array(8).fill(-1),
    ];
    expect([...out]).toEqual(expected);
  });

  it("gives back the pixels it took, as one ascending range list", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([40, 3]), Promise.resolve(read(pixels(40, 3, 0))));
    carried.carry(Uint32Array.from([10, 2]), Promise.resolve(read(pixels(10, 2, 0))));
    await carried.settled();

    const { ranges, values } = carried.snapshot();
    expect([...ranges]).toEqual([10, 2, 40, 3]);
    expect([...values]).toEqual([...pixels(10, 2, 0), ...pixels(40, 3, 0)]);
    expect(carried.size).toBe(5);
  });

  it("joins pixels that touch into one range", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 2]), Promise.resolve(read(pixels(10, 2, 0))));
    carried.carry(Uint32Array.from([12, 2]), Promise.resolve(read(pixels(12, 2, 0))));
    await carried.settled();
    expect([...carried.snapshot().ranges]).toEqual([10, 4]);
  });

  it("keeps the later carry of a pixel when an earlier read lands after it", async () => {
    const carried = new CarriedPaint();
    let landFirst!: (values: CarriedRead) => void;
    const first = new Promise<CarriedRead>((resolve) => {
      landFirst = resolve;
    });
    carried.carry(Uint32Array.from([7, 1]), first);
    carried.carry(Uint32Array.from([7, 1]), Promise.resolve(read(pixels(7, 1, 2))));
    landFirst(read(pixels(7, 1, 1)));
    await carried.settled();

    expect([...carried.snapshot().values]).toEqual([...pixels(7, 1, 2)]);
  });

  it("keeps the pixels a later carry does not cover", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 6]), Promise.resolve(read(pixels(10, 6, 1))));
    carried.carry(
      Uint32Array.from([12, 2, 20, 1]),
      Promise.resolve(read(Float32Array.from([...pixels(12, 2, 2), ...pixels(20, 1, 2)]))),
    );
    await carried.settled();

    const { ranges, values } = carried.snapshot();
    expect([...ranges]).toEqual([10, 6, 20, 1]);
    expect([...values]).toEqual([...pixels(10, 2, 1), ...pixels(12, 2, 2), ...pixels(14, 2, 1), ...pixels(20, 1, 2)]);
    expect(carried.size).toBe(7);
  });

  it("forgets dropped pixels, values and all", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 4]), Promise.resolve(read(pixels(10, 4, 0))));
    await carried.settled();
    carried.drop(Uint32Array.from([11, 2]));

    const { ranges, values } = carried.snapshot();
    expect([...ranges]).toEqual([10, 1, 13, 1]);
    expect([...values]).toEqual([...pixels(10, 1, 0), ...pixels(13, 1, 0)]);
  });

  it("ignores a read that lands after its pixels were dropped", async () => {
    const carried = new CarriedPaint();
    let land!: (values: CarriedRead) => void;
    const landing = new Promise<CarriedRead>((resolve) => {
      land = resolve;
    });
    carried.carry(Uint32Array.from([5, 2]), landing);
    carried.drop(Uint32Array.from([5, 2]));
    land(read(pixels(5, 2, 1)));
    await carried.settled();

    expect(carried.size).toBe(0);
    expect([...carried.snapshot().ranges]).toEqual([]);
  });

  it("takes back each step's mask weights with the pixels, the later carry winning", async () => {
    const carried = new CarriedPaint();
    carried.carry(
      Uint32Array.from([10, 4]),
      Promise.resolve({ values: pixels(10, 4, 1), masks: [weights(10, 4, 1), null] }),
    );
    carried.carry(
      Uint32Array.from([12, 4]),
      Promise.resolve({ values: pixels(12, 4, 2), masks: [weights(12, 4, 2), weights(12, 4, 2)] }),
    );
    await carried.settled();

    const taken = carried.take(Uint32Array.from([11, 4]));
    expect([...taken.ranges]).toEqual([11, 4]);
    expect([...taken.values]).toEqual([...pixels(11, 1, 1), ...pixels(12, 3, 2)]);
    expect(taken.masks).toHaveLength(2);
    expect([...taken.masks[0]!]).toEqual([...weights(11, 1, 1), ...weights(12, 3, 2)]);
    // The first carry had no mask for the second step, so its pixel weighs nothing there.
    expect([...taken.masks[1]!]).toEqual([0, ...weights(12, 3, 2)]);
    expect([...carried.snapshot().ranges]).toEqual([10, 1, 15, 1]);
  });

  it("widens its box over every carry and lets it go with the last pixel", () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([5, 2]), Promise.resolve(read(pixels(5, 2, 0))));
    carried.addBox({ timeMin: 0.2, timeMax: 0.3, pitchMin: 0.4, pitchMax: 0.5 });
    carried.addBox({ timeMin: 0.1, timeMax: 0.25, pitchMin: 0.45, pitchMax: 0.7 });
    expect(carried.paintBox()).toEqual({ timeMin: 0.1, timeMax: 0.3, pitchMin: 0.4, pitchMax: 0.7 });

    carried.drop(Uint32Array.from([5, 2]));
    expect(carried.paintBox()).toBeNull();
  });
});
