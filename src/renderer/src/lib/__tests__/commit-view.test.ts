import { describe, expect, it } from "vitest";

import { applyPhaseTurns, applyPhaseTurnsCollecting } from "../../../../main/lib/history-delta";
import type { PackedLayout, PhaseTurns } from "../../../../main/lib/types";
import { commitViewOf, composeViewBuffer, scatterCommitPatch } from "../commit-view";
import { gatherPixelRanges } from "../pixel-ranges";

// A windowed commit hands the addon a buffer holding only the window's reach.
// These pin the view's shape — aligned to every band's grid, mapped exactly
// back into the file — and the caller's half of the tail turns.

const SR = 100;

function layoutOf(numFrames: number, steps: number[]): PackedLayout {
  const bandStepLog2s = Int32Array.from(steps);
  const bandLengths = Uint32Array.from(steps.map((s) => ((numFrames - 1) >> s) + 1));
  const bandOffsets = new Uint32Array(steps.length);
  for (let b = 1; b < steps.length; b++) bandOffsets[b] = bandOffsets[b - 1] + bandLengths[b - 1];
  return { numFrames, numChannels: 2, numBands: steps.length, bandOffsets, bandStepLog2s, bandLengths };
}

function texelCount(layout: PackedLayout): number {
  let texels = 0;
  for (let b = 0; b < layout.numBands; b++) texels += layout.bandLengths[b];
  return texels;
}

describe("commitViewOf", () => {
  const layout = layoutOf(4001, [0, 1, 2]);
  const window = { startFrame: 1000, endFrame: 1100, startBand: 0, endBand: 3 };

  it("aligns the view to every band's grid and pads it past the window", () => {
    const view = commitViewOf(layout, window, SR);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.startFrame % 4).toBe(0);
    expect(view.endFrame % 4).toBe(0);
    expect(view.startFrame).toBeGreaterThan(0);
    expect(view.startFrame).toBeLessThan(window.startFrame);
    expect(view.endFrame).toBeGreaterThan(window.endFrame);
    expect(view.endFrame).toBeLessThan(layout.numFrames);
    for (let b = 0; b < layout.numBands; b++) {
      const step = layout.bandStepLog2s[b];
      const k0 = view.ranges[b * 2] - layout.bandOffsets[b];
      expect(k0 * 2 ** step).toBe(view.startFrame);
      expect((k0 + view.ranges[b * 2 + 1]) * 2 ** step).toBe(view.endFrame);
      expect(view.bandK0[b]).toBe(k0);
    }
    expect(view.texels).toBe(gatherPixelRanges(new Float32Array(texelCount(layout) * 4), view.ranges).length / 4);
  });

  it("returns null when the padding swallows the file", () => {
    expect(commitViewOf(layoutOf(900, [0, 1, 2]), { ...window, startFrame: 600, endFrame: 700 }, SR)).toBeNull();
  });

  it("clips the view at the file's end and keeps each band's true tail", () => {
    const view = commitViewOf(layout, { ...window, startFrame: 3800, endFrame: 3900 }, SR);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.endFrame).toBe(layout.numFrames);
    for (let b = 0; b < layout.numBands; b++) {
      const k0 = view.ranges[b * 2] - layout.bandOffsets[b];
      expect(k0 + view.ranges[b * 2 + 1]).toBe(layout.bandLengths[b]);
    }
  });

  it("scatters a patch back through the view's map, touching nothing else", () => {
    const data = new Float32Array(texelCount(layout) * 4);
    for (let i = 0; i < data.length; i++) data[i] = i;
    const before = new Float32Array(data);
    const view = commitViewOf(layout, window, SR);
    expect(view).not.toBeNull();
    if (!view) return;
    const buffer = gatherPixelRanges(data, view.ranges);

    const band = 1;
    const k0 = view.bandK0[band] + 3;
    const count = 5;
    const src = (view.bandOffsets[band] + (k0 - view.bandK0[band])) * 4;
    for (let i = 0; i < count * 4; i++) buffer[src + i] = -1000 - i;

    scatterCommitPatch(data, view, buffer, Uint32Array.from([band, k0, count]), layout);

    const dst = (layout.bandOffsets[band] + k0) * 4;
    for (let i = 0; i < data.length; i++) {
      const inPatch = i >= dst && i < dst + count * 4;
      expect(data[i]).toBe(inPatch ? -1000 - (i - dst) : before[i]);
    }
  });
});

describe("composeViewBuffer", () => {
  const layout = layoutOf(4001, [0, 1, 2]);
  const window = { startFrame: 1000, endFrame: 1100, startBand: 0, endBand: 3 };

  it("equals a gather of the painted state when the stroke lands inside the view", () => {
    const view = commitViewOf(layout, window, SR);
    expect(view).not.toBeNull();
    if (!view) return;
    const pre = new Float32Array(texelCount(layout) * 4);
    for (let i = 0; i < pre.length; i++) pre[i] = Math.sin(i * 0.37);
    const after = new Float32Array(pre);
    // A footprint inside the window: a run in band 0 and one in band 2.
    const strokeRanges = Uint32Array.from([layout.bandOffsets[0] + 1000, 40, layout.bandOffsets[2] + 250, 10]);
    for (let r = 0; r < strokeRanges.length; r += 2) {
      for (let p = strokeRanges[r]; p < strokeRanges[r] + strokeRanges[r + 1]; p++) {
        for (let c = 0; c < 4; c++) after[p * 4 + c] = -((p * 3 + c) % 17) - 1;
      }
    }
    const composed = composeViewBuffer(
      gatherPixelRanges(pre, view.ranges),
      view,
      gatherPixelRanges(after, strokeRanges),
      strokeRanges,
    );
    expect(composed).not.toBeNull();
    expect(Array.from(composed!)).toEqual(Array.from(gatherPixelRanges(after, view.ranges)));
  });

  it("refuses a footprint that reaches outside the view", () => {
    const view = commitViewOf(layout, window, SR);
    expect(view).not.toBeNull();
    if (!view) return;
    const outside = Uint32Array.from([layout.bandOffsets[0] + view.bandK0[0] - 2, 4]);
    expect(composeViewBuffer(new Float32Array(view.texels * 4), view, new Float32Array(4 * 4), outside)).toBeNull();
  });
});

describe("applyPhaseTurnsCollecting", () => {
  // A phase whose shift by `c` cannot be subtracted back exactly in float32 —
  // the case the residuals exist for.
  function inexactPhase(c: number): number {
    for (let x = 100; x < 1e7; x = x * 1.0003 + 0.001) {
      const v = Math.fround(x);
      if (Math.fround(Math.fround(v + c) - c) !== v) return v;
    }
    throw new Error("no inexact phase found");
  }

  const turns: PhaseTurns = {
    pixelStarts: Uint32Array.from([2, 9]),
    pixelCounts: Uint32Array.from([5, 4]),
    offsets: Float32Array.from([Math.fround(2 * Math.PI), Math.fround(-6 * Math.PI), Math.fround(6 * Math.PI), 0]),
    residuals: new Uint32Array(0),
  };

  function packedFixture(): Float32Array {
    const data = new Float32Array(16 * 4);
    for (let p = 0; p < 16; p++) {
      data[p * 4] = 0.5;
      data[p * 4 + 1] = p * 0.25;
      data[p * 4 + 2] = 0.25;
      data[p * 4 + 3] = -p * 0.5;
    }
    data[3 * 4 + 1] = inexactPhase(turns.offsets[0]);
    data[4 * 4 + 3] = inexactPhase(turns.offsets[1]);
    data[10 * 4 + 1] = inexactPhase(turns.offsets[2]);
    return data;
  }

  it("shifts exactly as the plain apply does and finds every residual", () => {
    const original = packedFixture();
    const plain = new Float32Array(original);
    applyPhaseTurns(plain, turns, false);

    const collected = new Float32Array(original);
    const residuals = applyPhaseTurnsCollecting(collected, turns);
    expect(residuals.length).toBeGreaterThan(0);
    expect(collected).toEqual(plain);

    const inverted = new Float32Array(collected);
    applyPhaseTurns(inverted, { ...turns, residuals }, true);
    expect(inverted).toEqual(original);
  });
});
