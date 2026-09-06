import { describe, expect, it } from "vitest";

import {
  bandAtPixel,
  bandLayoutOf,
  coarsestStepLog2,
  layoutTexels,
  metadataTextureRows,
  type BandLayout,
} from "../band-layout";

/** Bands laid out by hand, so a test can name every offset and step. */
function handLayout(steps: number[], lengths: number[]): BandLayout {
  const metadata = new Float64Array(steps.length * 4);
  let offset = 0;
  for (let band = 0; band < steps.length; band++) {
    metadata[band * 4] = offset;
    metadata[band * 4 + 1] = lengths[band];
    metadata[band * 4 + 2] = steps[band];
    metadata[band * 4 + 3] = 1000 - band;
    offset += lengths[band];
  }
  return { numBands: steps.length, metadata };
}

describe("coarsestStepLog2", () => {
  it("takes the largest step any band uses", () => {
    expect(coarsestStepLog2(handLayout([0, 1, 5, 3], [64, 32, 2, 8]))).toBe(5);
  });

  it("is zero when every band is at the finest step", () => {
    expect(coarsestStepLog2(handLayout([0, 0], [16, 16]))).toBe(0);
  });
});

describe("bandAtPixel", () => {
  const layout = handLayout([0, 1, 2], [64, 32, 16]);

  it("finds the band a pixel falls in", () => {
    expect(bandAtPixel(layout, 0)).toBe(0);
    expect(bandAtPixel(layout, 63)).toBe(0);
    expect(bandAtPixel(layout, 64)).toBe(1);
    expect(bandAtPixel(layout, 95)).toBe(1);
    expect(bandAtPixel(layout, 96)).toBe(2);
  });

  it("stops at the last band past the end", () => {
    expect(bandAtPixel(layout, 1000)).toBe(2);
  });
});

describe("layoutTexels", () => {
  it("reaches the end of the last band", () => {
    expect(layoutTexels(handLayout([0, 1, 2], [64, 32, 16]))).toBe(112);
  });
});

describe("bandLayoutOf", () => {
  // A ten-minute file has more coefficients than a float counts one by one, so
  // a layout held as floats rounds its offsets while its lengths come from
  // exact integers. The two then disagree, a pixel at the end of one band
  // reads as the start of the next, and the range arithmetic sends it nowhere.
  const numBands = 200;
  const offsets = new Uint32Array(numBands);
  const lengths = new Uint32Array(numBands);
  const steps = new Int32Array(numBands);
  const freqs = new Float64Array(numBands);
  let at = 0;
  for (let band = 0; band < numBands; band++) {
    lengths[band] = 600_000 + band;
    offsets[band] = at;
    freqs[band] = 20 * 2 ** (band / 36);
    at += lengths[band];
  }
  const layout = bandLayoutOf(numBands, offsets, lengths, steps, freqs);

  it("counts past what a float steps through one by one", () => {
    expect(layoutTexels(layout)).toBeGreaterThan(2 ** 24);
  });

  it("leaves no gap and no overlap between one band and the next", () => {
    for (let band = 0; band + 1 < numBands; band++) {
      expect(layout.metadata[(band + 1) * 4], `band ${band}`).toBe(
        layout.metadata[band * 4] + layout.metadata[band * 4 + 1],
      );
    }
  });

  it("finds the band of the last pixel of every band", () => {
    for (let band = 0; band < numBands; band++) {
      const last = offsets[band] + lengths[band] - 1;
      expect(bandAtPixel(layout, last), `band ${band}`).toBe(band);
      expect(bandAtPixel(layout, offsets[band]), `band ${band}`).toBe(band);
    }
  });

  it("hands the texture the same rows as floats", () => {
    const rows = metadataTextureRows(layout);
    expect(rows).toBeInstanceOf(Float32Array);
    expect(rows.length).toBe(numBands * 4);
    expect(rows[3]).toBeCloseTo(freqs[0], 3);
  });
});
