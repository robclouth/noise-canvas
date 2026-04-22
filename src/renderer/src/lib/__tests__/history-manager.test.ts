import { describe, expect, it } from "vitest";
import { applyDelta, computeDeltaRect } from "../history-manager";

function makeRGBA(width: number, height: number, fill: number): Float32Array {
  const arr = new Float32Array(width * height * 4);
  for (let i = 0; i < arr.length; i++) arr[i] = fill;
  return arr;
}

describe("history-manager codec", () => {
  describe("computeDeltaRect", () => {
    it("returns null when nothing changed", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.25);
      const after = new Float32Array(before);
      expect(computeDeltaRect(before, after, w, h)).toBeNull();
    });

    it("picks a 1×1 rect for a single-pixel change", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      const x = 5,
        y = 2;
      const i = (y * w + x) * 4;
      after[i + 0] = 1;
      after[i + 1] = 2;
      after[i + 2] = 3;
      after[i + 3] = 4;
      const diff = computeDeltaRect(before, after, w, h);
      expect(diff).not.toBeNull();
      expect(diff!.rect).toEqual({ x, y, w: 1, h: 1 });
      expect(Array.from(diff!.patch)).toEqual([1, 2, 3, 4]);
    });

    it("bounds multiple changed pixels with a tight rect", () => {
      const w = 8,
        h = 6;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      const write = (x: number, y: number, v: number) => {
        const i = (y * w + x) * 4;
        after[i] = v;
        after[i + 1] = v;
        after[i + 2] = v;
        after[i + 3] = v;
      };
      write(2, 1, 1);
      write(4, 3, 2);
      write(3, 2, 3);
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 2, y: 1, w: 3, h: 3 });
      // Patch value at local (0,0) maps to global (2,1) — value 1.
      expect(diff.patch[0]).toBe(1);
      // Patch value at local (2,2) maps to global (4,3) — value 2.
      const localI = (2 * diff.rect.w + 2) * 4;
      expect(diff.patch[localI]).toBe(2);
    });

    it("detects change in any channel", () => {
      const w = 4,
        h = 4;
      const before = makeRGBA(w, h, 1);
      const after = new Float32Array(before);
      after[(1 * w + 1) * 4 + 3] = 99; // alpha only
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 1, y: 1, w: 1, h: 1 });
      // Patch stores `after - before`: RGB are unchanged (diff 0), alpha jumped
      // from 1 → 99, so the recorded diff is 98.
      expect(diff.patch[0]).toBe(0);
      expect(diff.patch[1]).toBe(0);
      expect(diff.patch[2]).toBe(0);
      expect(diff.patch[3]).toBe(98);
    });

    it("records zero for untouched pixels inside the bounding box", () => {
      // Non-zero base so patch values can be distinguished from 'after'.
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.5);
      const after = new Float32Array(before);
      // Only the two corners of the bbox actually change.
      const writePixel = (x: number, y: number, v: number) => {
        const i = (y * w + x) * 4;
        after[i] = v;
        after[i + 1] = v;
        after[i + 2] = v;
        after[i + 3] = v;
      };
      writePixel(2, 1, 0.9);
      writePixel(4, 2, 0.1);
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 2, y: 1, w: 3, h: 2 });
      // Middle pixel of the bbox at local (1, 0) → global (3, 1) is untouched.
      // Because we store diffs, its patch entry must be exactly zero.
      const localI = (0 * diff.rect.w + 1) * 4;
      expect(diff.patch[localI]).toBe(0);
      expect(diff.patch[localI + 1]).toBe(0);
      expect(diff.patch[localI + 2]).toBe(0);
      expect(diff.patch[localI + 3]).toBe(0);
    });
  });

  describe("applyDelta", () => {
    it("reproduces the after buffer from before + delta", () => {
      const w = 16,
        h = 8;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      // Scatter some changes in a region.
      for (let y = 2; y < 6; y++) {
        for (let x = 3; x < 11; x++) {
          const i = (y * w + x) * 4;
          after[i] = x + y;
          after[i + 1] = x * 2;
          after[i + 2] = y * 3;
          after[i + 3] = 1;
        }
      }
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      expect(Array.from(reconstructed)).toEqual(Array.from(after));
    });

    it("does not touch pixels outside the rect", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.5);
      const after = new Float32Array(before);
      const i = (1 * w + 1) * 4;
      after[i] = 7;
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      // Check an arbitrary untouched pixel retained its value.
      const untouched = (3 * w + 6) * 4;
      expect(reconstructed[untouched]).toBe(0.5);
    });

    it("round-trips correctly when base values are non-zero inside the bbox", () => {
      // This is the scenario diff-based deltas are designed to handle: a base
      // with non-zero values, only a few pixels inside the bbox actually
      // change. Reconstruction must equal `after` exactly.
      const w = 10,
        h = 6;
      const before = new Float32Array(w * h * 4);
      for (let p = 0; p < w * h; p++) {
        before[p * 4] = (p % 7) * 0.125; // R
        before[p * 4 + 1] = (p % 5) * 0.25; // G
        before[p * 4 + 2] = ((p * 3) % 11) * 0.0625; // B
        before[p * 4 + 3] = 1;
      }
      const after = new Float32Array(before);
      // Two scattered changes inside a 4×3 bbox.
      const writePixel = (x: number, y: number, r: number) => {
        const i = (y * w + x) * 4;
        after[i] = r;
        after[i + 1] = r + 0.1;
        after[i + 2] = r + 0.2;
        after[i + 3] = r + 0.3;
      };
      writePixel(3, 2, 0.9);
      writePixel(5, 4, 0.4);
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      expect(Array.from(reconstructed)).toEqual(Array.from(after));
    });
  });
});
