/** A packed spectrogram's per-band layout, as `SpectrogramData.metadata` holds it. */
export type BandLayout = {
  numBands: number;
  /** RGBA per band: packed offset, bin count, time step log2, centre frequency. */
  metadata: Float32Array;
};

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
