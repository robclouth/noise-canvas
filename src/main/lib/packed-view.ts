import type { PackedLayout } from "./types";

/** The packed pixels of one span of a file, and their map back into it. */
export type PackedView = {
  /** Absolute frame span the view holds; both edges sit on every band's grid. */
  startFrame: number;
  endFrame: number;
  /** The view's packed pixels as [start, count] pairs, per band in band order. */
  ranges: Uint32Array;
  /** Texel offset of each band's span inside the gathered buffer. */
  bandOffsets: Uint32Array;
  /** Absolute coefficient index of each band's first gathered texel. */
  bandK0: Uint32Array;
  /** Texels the view holds. */
  texels: number;
};

/** Frames rounded outward to the coarsest band's grid, and clipped to the file. */
export function alignToBandGrid(
  layout: PackedLayout,
  startFrame: number,
  endFrame: number,
): { startFrame: number; endFrame: number } {
  let maxStep = 0;
  for (let b = 0; b < layout.numBands; b++) maxStep = Math.max(maxStep, layout.bandStepLog2s[b]);
  const quantum = 1 << maxStep;
  return {
    startFrame: Math.max(0, Math.floor(startFrame / quantum) * quantum),
    endFrame: Math.min(layout.numFrames, Math.ceil(endFrame / quantum) * quantum),
  };
}

/**
 * The view over [startFrame, endFrame), whose edges must already sit on the
 * coarsest band's grid. A span reaching the end of the file takes each band to
 * its last bin, which the grid alone would leave short.
 */
export function packedViewOf(layout: PackedLayout, startFrame: number, endFrame: number): PackedView {
  const ranges = new Uint32Array(layout.numBands * 2);
  const bandOffsets = new Uint32Array(layout.numBands);
  const bandK0 = new Uint32Array(layout.numBands);
  let texels = 0;
  for (let b = 0; b < layout.numBands; b++) {
    const step = layout.bandStepLog2s[b];
    const len = layout.bandLengths[b];
    const k0 = Math.min(len, startFrame / 2 ** step);
    const kEnd = endFrame >= layout.numFrames ? len : Math.min(len, endFrame / 2 ** step);
    const count = Math.max(0, kEnd - k0);
    bandOffsets[b] = texels;
    bandK0[b] = k0;
    ranges[b * 2] = layout.bandOffsets[b] + k0;
    ranges[b * 2 + 1] = count;
    texels += count;
  }
  return { startFrame, endFrame, ranges, bandOffsets, bandK0, texels };
}
