import { describe, expect, it } from "vitest";

import { CarriedPaint } from "../carried-paint";

/** Four floats per pixel, distinct per pixel and per generation. */
function pixels(from: number, count: number, generation: number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = (from + i) * 10 + c + generation * 1000;
  }
  return out;
}

describe("CarriedPaint", () => {
  it("gives back the pixels it took, as one ascending range list", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([40, 3]), Promise.resolve(pixels(40, 3, 0)));
    carried.carry(Uint32Array.from([10, 2]), Promise.resolve(pixels(10, 2, 0)));
    await carried.settled();

    const { ranges, values } = carried.snapshot();
    expect([...ranges]).toEqual([10, 2, 40, 3]);
    expect([...values]).toEqual([...pixels(10, 2, 0), ...pixels(40, 3, 0)]);
    expect(carried.size).toBe(5);
  });

  it("joins pixels that touch into one range", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 2]), Promise.resolve(pixels(10, 2, 0)));
    carried.carry(Uint32Array.from([12, 2]), Promise.resolve(pixels(12, 2, 0)));
    await carried.settled();
    expect([...carried.snapshot().ranges]).toEqual([10, 4]);
  });

  it("keeps the later carry of a pixel when an earlier read lands after it", async () => {
    const carried = new CarriedPaint();
    let landFirst!: (values: Float32Array) => void;
    const first = new Promise<Float32Array>((resolve) => {
      landFirst = resolve;
    });
    carried.carry(Uint32Array.from([7, 1]), first);
    carried.carry(Uint32Array.from([7, 1]), Promise.resolve(pixels(7, 1, 2)));
    landFirst(pixels(7, 1, 1));
    await carried.settled();

    expect([...carried.snapshot().values]).toEqual([...pixels(7, 1, 2)]);
  });

  it("forgets dropped pixels, values and all", async () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([10, 4]), Promise.resolve(pixels(10, 4, 0)));
    await carried.settled();
    carried.drop(Uint32Array.from([11, 2]));

    const { ranges, values } = carried.snapshot();
    expect([...ranges]).toEqual([10, 1, 13, 1]);
    expect([...values]).toEqual([...pixels(10, 1, 0), ...pixels(13, 1, 0)]);
  });

  it("ignores a read that lands after its pixels were dropped", async () => {
    const carried = new CarriedPaint();
    let land!: (values: Float32Array) => void;
    const read = new Promise<Float32Array>((resolve) => {
      land = resolve;
    });
    carried.carry(Uint32Array.from([5, 2]), read);
    carried.drop(Uint32Array.from([5, 2]));
    land(pixels(5, 2, 1));
    await carried.settled();

    expect(carried.size).toBe(0);
    expect([...carried.snapshot().ranges]).toEqual([]);
  });

  it("widens its box over every carry and lets it go with the last pixel", () => {
    const carried = new CarriedPaint();
    carried.carry(Uint32Array.from([5, 2]), Promise.resolve(pixels(5, 2, 0)));
    carried.addBox({ timeMin: 0.2, timeMax: 0.3, pitchMin: 0.4, pitchMax: 0.5 });
    carried.addBox({ timeMin: 0.1, timeMax: 0.25, pitchMin: 0.45, pitchMax: 0.7 });
    expect(carried.paintBox()).toEqual({ timeMin: 0.1, timeMax: 0.3, pitchMin: 0.4, pitchMax: 0.7 });

    carried.drop(Uint32Array.from([5, 2]));
    expect(carried.paintBox()).toBeNull();
  });
});
