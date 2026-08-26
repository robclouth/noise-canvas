import { describe, expect, it } from "vitest";

import { bandAtPixel, coarsestStepLog2, layoutTexels, type BandLayout } from "../band-layout";

/** Bands laid out by hand, so a test can name every offset and step. */
function handLayout(steps: number[], lengths: number[]): BandLayout {
  const metadata = new Float32Array(steps.length * 4);
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
