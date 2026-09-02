import { alignToBandGrid, packedViewOf, type PackedView } from "../../../main/lib/packed-view";
import type { CommitWindow, PackedLayout } from "../../../main/lib/types";
import { copyCompactOverlap, subtractPixelRanges } from "./pixel-ranges";

/** The packed pixels a windowed commit works on, and their map back into the file. */
export type CommitView = PackedView;

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
  const quantumSec = (1 << maxStep) / sampleRate;
  const leadSec = 0.25 + 6.0 + 0.08 + 2 * quantumSec + 0.5;
  const trailSec = Math.max(0.1 + 2.0 + quantumSec, 0.25 + 0.19 + 2 * quantumSec) + 0.5;
  const span = alignToBandGrid(
    layout,
    window.startFrame - leadSec * sampleRate,
    window.endFrame + trailSec * sampleRate,
  );
  if ((span.startFrame <= 0 && span.endFrame >= layout.numFrames) || span.endFrame <= span.startFrame) return null;
  return packedViewOf(layout, span.startFrame, span.endFrame);
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

/**
 * The view's pixels for the addon: the pre-stroke values with the stroke's
 * footprint written over them, in place in `preStroke`. Null when the
 * footprint reaches outside the view, which would leave stroke pixels out of
 * the buffer.
 */
export function composeViewBuffer(
  preStroke: Float32Array,
  view: CommitView,
  strokeValues: Float32Array,
  strokeRanges: Uint32Array,
): Float32Array | null {
  if (subtractPixelRanges(strokeRanges, view.ranges).length > 0) return null;
  copyCompactOverlap(preStroke, view.ranges, strokeValues, strokeRanges);
  return preStroke;
}
