/** A packed spectrogram's per-band layout, as `SpectrogramData.metadata` holds it. */
export type BandLayout = {
  numBands: number;
  /**
   * Four per band: packed offset, bin count, time step log2, centre frequency.
   * Doubles, not the floats the metadata texture carries: a float counts
   * integers exactly only to 2^24, and a ten-minute file has 119M
   * coefficients, so its offsets would round to multiples of eight.
   */
  metadata: Float64Array;
};

/** A band layout from the exact per-band arrays an analysis carries. */
export function bandLayoutOf(
  numBands: number,
  bandOffsets: ArrayLike<number>,
  bandLengths: ArrayLike<number>,
  bandStepLog2s: ArrayLike<number>,
  bandFreqs: ArrayLike<number>,
): BandLayout {
  const metadata = new Float64Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    metadata[band * 4] = bandOffsets[band];
    metadata[band * 4 + 1] = bandLengths[band];
    metadata[band * 4 + 2] = bandStepLog2s[band];
    metadata[band * 4 + 3] = bandFreqs[band];
  }
  return { numBands, metadata };
}

/**
 * A layout as the two-row RGBA32F texture the shaders sample. Row 0 is the
 * metadata as floats. Row 1 holds each band's centre in cycles per frame as a
 * float and the float remainder, so their sum carries the double: a phase
 * that multiplies the centre by a time ten minutes into a file needs more bits
 * than one float holds.
 */
export function metadataTextureRows(layout: BandLayout, sampleRate: number): Float32Array {
  const { numBands, metadata } = layout;
  const rows = new Float32Array(numBands * 8);
  rows.set(metadata);
  for (let band = 0; band < numBands; band++) {
    const rate = metadata[band * 4 + 3] / sampleRate;
    const high = Math.fround(rate);
    rows[(numBands + band) * 4] = high;
    rows[(numBands + band) * 4 + 1] = rate - high;
  }
  return rows;
}

/** The coarsest time step any band uses, as a log2 of frames. */
export function coarsestStepLog2(layout: BandLayout): number {
  let coarsest = 0;
  for (let band = 0; band < layout.numBands; band++) {
    coarsest = Math.max(coarsest, layout.metadata[band * 4 + 2]);
  }
  return coarsest;
}

/** The band holding packed pixel `pixel`, or the last band starting at or before it. */
export function bandAtPixel(layout: BandLayout, pixel: number): number {
  let low = 0;
  let high = layout.numBands - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (layout.metadata[mid * 4] <= pixel) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Packed texels a run of band lengths holds. */
export function bandLengthsTexels(bandLengths: ArrayLike<number>): number {
  let texels = 0;
  for (let i = 0; i < bandLengths.length; i++) texels += bandLengths[i];
  return texels;
}

/** Packed texels the whole layout holds, from the last band's offset and length. */
export function layoutTexels(layout: BandLayout): number {
  const last = (layout.numBands - 1) * 4;
  return layout.metadata[last] + layout.metadata[last + 1];
}
