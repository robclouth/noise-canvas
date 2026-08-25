import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhaseTurns } from "../../../../main/lib/types";
import { applyPhaseTurns } from "../../../../main/lib/history-delta";
import {
  applyCanvasTurns,
  flattenPhaseTurns,
  resetCanvasTurnVerdict,
  samplePixelRanges,
  type PhaseTurnCanvas,
} from "../canvas-phase-turns";

const pixels = 64;

function makeTurns(start: number, count: number, c0: number, c1: number): PhaseTurns {
  return {
    pixelStarts: Uint32Array.from([start]),
    pixelCounts: Uint32Array.from([count]),
    offsets: Float32Array.from([c0, c1]),
    residuals: new Uint32Array(0),
  };
}

function makePacked(): Float32Array {
  const packed = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    packed[p * 4] = p;
    packed[p * 4 + 1] = Math.fround(1e4 + p);
    packed[p * 4 + 2] = -p;
    packed[p * 4 + 3] = Math.fround(-1e4 - p);
  }
  return packed;
}

/** A canvas that adds like the CPU, or, when `slip` is set, a little off. */
function makeCanvas(start: Float32Array, slip = 0): PhaseTurnCanvas & { canvas: Float32Array; patches: Uint32Array[] } {
  const canvas = new Float32Array(start);
  const patches: Uint32Array[] = [];
  return {
    canvas,
    patches,
    applyPhaseTurns: (flat) => {
      for (let i = 0; i + 3 < flat.length; i += 4) {
        for (let p = flat[i]; p < flat[i] + flat[i + 1]; p++) {
          if (flat[i + 2] !== 0) canvas[p * 4 + 1] = Math.fround(canvas[p * 4 + 1] + flat[i + 2] + slip);
          if (flat[i + 3] !== 0) canvas[p * 4 + 3] = Math.fround(canvas[p * 4 + 3] + flat[i + 3] + slip);
        }
      }
    },
    readPixelRanges: vi.fn(async (r: Uint32Array) => {
      let n = 0;
      for (let i = 1; i < r.length; i += 2) n += r[i];
      const out = new Float32Array(n * 4);
      let at = 0;
      for (let i = 0; i + 1 < r.length; i += 2) {
        out.set(canvas.subarray(r[i] * 4, (r[i] + r[i + 1]) * 4), at);
        at += r[i + 1] * 4;
      }
      return out;
    }),
    patchFBOData: (data, ranges) => {
      patches.push(ranges);
      for (let i = 0; i + 1 < ranges.length; i += 2) {
        canvas.set(data.subarray(ranges[i] * 4, (ranges[i] + ranges[i + 1]) * 4), ranges[i] * 4);
      }
    },
  };
}

describe("canvas phase turns", () => {
  afterEach(() => {
    resetCanvasTurnVerdict();
    vi.restoreAllMocks();
  });

  it("flattens a turn signed for its direction", () => {
    const turns = makeTurns(8, 10, 6.5, 0);
    expect(flattenPhaseTurns({ turns, invert: false })).toEqual([8, 10, 6.5, 0]);
    expect(flattenPhaseTurns({ turns, invert: true })).toEqual([8, 10, -6.5, -0]);
  });

  it("samples pixels spread over the ranges and skips the excepted ones", () => {
    const ranges = new Uint32Array([0, 10, 20, 10]);
    const sample = samplePixelRanges(ranges, 4);
    expect(Array.from(sample)).toEqual([2, 1, 7, 1, 22, 1, 27, 1]);
    const skipped = samplePixelRanges(ranges, 4, new Uint32Array([20, 10]));
    expect(Array.from(skipped)).toEqual([2, 1, 7, 1]);
  });

  it("checks the GPU once, then trusts its turns without a readback", async () => {
    const packed = makePacked();
    const canvas = makeCanvas(packed);
    const c0 = Math.fround(2 * Math.PI);
    const first = makeTurns(8, pixels - 8, c0, 0);
    applyPhaseTurns(packed, first, false);
    await applyCanvasTurns(canvas, packed, [{ turns: first, invert: false }], new Uint32Array([4, 4]));
    expect(canvas.readPixelRanges).toHaveBeenCalledTimes(1);
    expect(Array.from(canvas.canvas)).toEqual(Array.from(packed));
    expect(canvas.patches).toHaveLength(0);

    const second = makeTurns(16, pixels - 16, 0, -c0);
    applyPhaseTurns(packed, second, false);
    await applyCanvasTurns(canvas, packed, [{ turns: second, invert: false }]);
    expect(canvas.readPixelRanges).toHaveBeenCalledTimes(1);
    expect(Array.from(canvas.canvas)).toEqual(Array.from(packed));
    expect(canvas.patches).toHaveLength(0);
  });

  it("uploads the turned ranges when the GPU's add is off, from then on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const packed = makePacked();
    const canvas = makeCanvas(packed, 1e-3);
    const c0 = Math.fround(2 * Math.PI);
    const first = makeTurns(8, pixels - 8, c0, 0);
    applyPhaseTurns(packed, first, false);
    await applyCanvasTurns(canvas, packed, [{ turns: first, invert: false }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(canvas.patches.map((r) => Array.from(r))).toEqual([[8, pixels - 8]]);
    expect(Array.from(canvas.canvas)).toEqual(Array.from(packed));

    const second = makeTurns(16, pixels - 16, 0, -c0);
    applyPhaseTurns(packed, second, false);
    await applyCanvasTurns(canvas, packed, [{ turns: second, invert: false }]);
    expect(canvas.readPixelRanges).toHaveBeenCalledTimes(1);
    expect(canvas.patches.map((r) => Array.from(r))).toEqual([
      [8, pixels - 8],
      [16, pixels - 16],
    ]);
    expect(Array.from(canvas.canvas)).toEqual(Array.from(packed));
  });
});
