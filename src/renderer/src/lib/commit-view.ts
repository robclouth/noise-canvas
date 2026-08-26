import type { CommitWindow, PackedLayout } from "../../../main/lib/types";

/** The packed pixels a windowed commit works on, and their map back into the file. */
export type CommitView = {
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

/**
 * The view a commit over `window` needs: the window plus the reach of every
 * pass the commit runs — synthesis fill, projection margins, and the onset
 * pass's warm-up — aligned outward to the coarsest band's grid. The addon
 * checks the true reaches itself and refuses a view that falls short, so
 * these paddings only have to err on the wide side. Null when the view would
 * be the whole file anyway.
 */
export function commitViewOf(layout: PackedLayout, window: CommitWindow, sampleRate: number): CommitView | null {
  let maxStep = 0;
  for (let b = 0; b < layout.numBands; b++) maxStep = Math.max(maxStep, layout.bandStepLog2s[b]);
  const quantum = 1 << maxStep;
  const quantumSec = quantum / sampleRate;
  const leadSec = 0.25 + 6.0 + 0.08 + 2 * quantumSec + 0.5;
  const trailSec = Math.max(0.1 + 2.0 + quantumSec, 0.25 + 0.19 + 2 * quantumSec) + 0.5;
  const startFrame = Math.max(0, Math.floor((window.startFrame - leadSec * sampleRate) / quantum) * quantum);
  const endFrame = Math.min(layout.numFrames, Math.ceil((window.endFrame + trailSec * sampleRate) / quantum) * quantum);
  if ((startFrame <= 0 && endFrame >= layout.numFrames) || endFrame <= startFrame) return null;

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

/**
 * Writes a windowed commit's patch — the pass wrote it into the view buffer —
 * back into the whole packed state, range by range.
 */
export function scatterCommitPatch(
  data: Float32Array,
  view: CommitView,
  viewBuffer: Float32Array,
  patchRanges: Uint32Array,
  layout: PackedLayout,
): void {
  for (let i = 0; i + 2 < patchRanges.length; i += 3) {
    const band = patchRanges[i];
    const k0 = patchRanges[i + 1];
    const count = patchRanges[i + 2];
    const src = (view.bandOffsets[band] + (k0 - view.bandK0[band])) * 4;
    data.set(viewBuffer.subarray(src, src + count * 4), (layout.bandOffsets[band] + k0) * 4);
  }
}
