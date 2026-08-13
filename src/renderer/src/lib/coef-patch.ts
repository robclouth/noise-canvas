import type { CoefficientPatch } from "../../../main/lib/types";

/** Where a patch reached, in packed pixels and in the canvas's own axes. */
export interface PatchExtent {
  /** Flat [pixelStart, pixelCount, ...] over the packed array. */
  pixelRanges: Uint32Array;
  minFrame: number;
  maxFrame: number;
  minBand: number;
  maxBand: number;
}

/**
 * Writes a coefficient patch into `data` in place and reports where it
 * reached. The patch's ranges are per band ([band, k0, count]) and its pixels
 * run in the same order.
 */
export function applyCoefficientPatch(
  data: Float32Array,
  patch: CoefficientPatch,
  bandOffsets: number[] | Uint32Array,
  bandStepLog2s: number[] | Int32Array,
): PatchExtent | null {
  const { ranges, pixels } = patch;
  if (!ranges.length) return null;

  const pixelRanges = new Uint32Array((ranges.length / 3) * 2);
  let srcOffset = 0;
  let minFrame = Infinity;
  let maxFrame = -Infinity;
  let minBand = Infinity;
  let maxBand = -Infinity;

  for (let i = 0; i < ranges.length; i += 3) {
    const band = ranges[i];
    const k0 = ranges[i + 1];
    const count = ranges[i + 2];
    const pixelStart = bandOffsets[band] + k0;
    data.set(pixels.subarray(srcOffset, srcOffset + count * 4), pixelStart * 4);
    srcOffset += count * 4;
    pixelRanges[(i / 3) * 2] = pixelStart;
    pixelRanges[(i / 3) * 2 + 1] = count;

    const stepLog2 = bandStepLog2s[band];
    minFrame = Math.min(minFrame, k0 << stepLog2);
    maxFrame = Math.max(maxFrame, (k0 + count) << stepLog2);
    minBand = Math.min(minBand, band);
    maxBand = Math.max(maxBand, band);
  }

  return { pixelRanges, minFrame, maxFrame, minBand, maxBand };
}
