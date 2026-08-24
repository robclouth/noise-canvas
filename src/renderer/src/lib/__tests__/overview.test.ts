import { DataUtils } from "three";
import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  buildOverview,
  buildOverviewLayout,
  magnitudeToDb,
  OVERVIEW_DECIMATION,
  updateOverviewRanges,
} from "../overview";
import { fileLayoutOf, layoutPixelCount, type PackedLayout } from "../window-layout";

function mockFile(): { data: ReturnType<typeof createConstantQMockSpectrogramData>; layout: PackedLayout } {
  const data = createConstantQMockSpectrogramData({ durationSeconds: 4, sampleRate: 8000, bandsPerOctave: 4 });
  return { data, layout: fileLayoutOf(data) };
}

/** Magnitudes that differ everywhere, with an obvious peak inside one group. */
function stampMagnitudes(packedData: Float32Array, layout: PackedLayout): void {
  for (let b = 0; b < layout.numBands; b++) {
    for (let k = 0; k < layout.bandLengths[b]; k++) {
      const pixel = (layout.bandOffsets[b] + k) * 4;
      packedData[pixel] = 1e-4 * (1 + ((b * 7 + k * 13) % 97));
      packedData[pixel + 2] = 1e-4 * (1 + ((b * 11 + k * 5) % 89));
    }
  }
}

// Half float's smallest normal (2^-14) and largest finite value.
const SMALLEST_NORMAL_HALF = 2 ** -14;
const LARGEST_HALF = 65504;

function readBin(data: Uint16Array, pixel: number): { left: number; right: number } {
  return {
    left: DataUtils.fromHalfFloat(data[pixel * 2]),
    right: DataUtils.fromHalfFloat(data[pixel * 2 + 1]),
  };
}

describe("overview layout", () => {
  it("shifts each band's step by the decimation and keeps at least one bin", () => {
    const { layout } = mockFile();
    const overview = buildOverviewLayout(layout);
    for (let b = 0; b < layout.numBands; b++) {
      expect(overview.bandStepLog2s[b]).toBe(layout.bandStepLog2s[b] + 4);
      expect(overview.bandLengths[b]).toBe(Math.max(1, Math.ceil(layout.bandLengths[b] / OVERVIEW_DECIMATION)));
      expect(overview.bandLengths[b]).toBeGreaterThanOrEqual(1);
    }
  });

  // The bin an overview band covers must be exactly the frames its group of
  // file bins covers, or the display would read the wrong time when it falls
  // back to the overview.
  it("covers exactly the frames its file bins cover", () => {
    const { layout } = mockFile();
    const overview = buildOverviewLayout(layout);
    for (let b = 0; b < layout.numBands; b++) {
      const fileStep = 2 ** layout.bandStepLog2s[b];
      const overviewStep = 2 ** overview.bandStepLog2s[b];
      expect(overviewStep).toBe(fileStep * OVERVIEW_DECIMATION);
      for (let k = 0; k < overview.bandLengths[b]; k++) {
        expect(k * overviewStep).toBe(k * OVERVIEW_DECIMATION * fileStep);
      }
    }
  });

  it("costs a quarter of a byte per file texel", () => {
    const { layout } = mockFile();
    const overview = buildOverviewLayout(layout);
    const bytesPerOverviewTexel = 4; // RG16F
    const ratio = (layoutPixelCount(overview) * bytesPerOverviewTexel) / layoutPixelCount(layout);
    expect(ratio).toBeGreaterThan(0.24);
    expect(ratio).toBeLessThan(0.3);
  });

  it("rejects a decimation that is not a power of two", () => {
    const { layout } = mockFile();
    expect(() => buildOverviewLayout(layout, 10)).toThrow();
  });
});

describe("overview contents", () => {
  it("holds the max of each group, per channel", () => {
    const { data, layout } = mockFile();
    stampMagnitudes(data.packedData, layout);
    const overview = buildOverview(data.packedData, layout, data.metadata);

    for (let b = 0; b < layout.numBands; b++) {
      for (let k = 0; k < overview.layout.bandLengths[b]; k++) {
        const first = k * OVERVIEW_DECIMATION;
        const count = Math.min(OVERVIEW_DECIMATION, layout.bandLengths[b] - first);
        let left = 0;
        let right = 0;
        for (let i = 0; i < count; i++) {
          const pixel = (layout.bandOffsets[b] + first + i) * 4;
          left = Math.max(left, data.packedData[pixel]);
          right = Math.max(right, data.packedData[pixel + 2]);
        }
        const stored = readBin(overview.data, overview.layout.bandOffsets[b] + k);
        expect(stored.left).toBeCloseTo(magnitudeToDb(left), 1);
        expect(stored.right).toBeCloseTo(magnitudeToDb(right), 1);
      }
    }
  });

  // A transient must survive zoom-out. Averaging would bury a lone loud bin
  // among fifteen quiet ones; max keeps it at full height.
  it("keeps a lone transient at full level", () => {
    const { data, layout } = mockFile();
    data.packedData.fill(0);
    const band = 2;
    const spike = layout.bandOffsets[band] + 5;
    data.packedData[spike * 4] = 0.5;
    data.packedData[spike * 4 + 2] = 0.5;

    const overview = buildOverview(data.packedData, layout, data.metadata);
    const bin = overview.layout.bandOffsets[band] + Math.floor(5 / OVERVIEW_DECIMATION);
    expect(readBin(overview.data, bin).left).toBeCloseTo(magnitudeToDb(0.5), 1);
  });

  it("keeps quiet content out of half float's subnormal range", () => {
    const { data, layout } = mockFile();
    data.packedData.fill(0);
    // −110 dBFS is inside the Min dB control's range and far below half
    // float's smallest normal, 6.1e-5.
    const quiet = 10 ** (-110 / 20);
    expect(quiet).toBeLessThan(6.1e-5);
    const pixel = layout.bandOffsets[0];
    data.packedData[pixel * 4] = quiet;
    data.packedData[pixel * 4 + 2] = quiet;

    const overview = buildOverview(data.packedData, layout, data.metadata);
    const stored = readBin(overview.data, overview.layout.bandOffsets[0]);
    // Stored as dB it is an ordinary normal value; stored as a linear
    // magnitude it would be subnormal, and WebGL2 does not require a driver to
    // support those — a flush-to-zero driver floors the overview to black.
    expect(Math.abs(stored.left)).toBeGreaterThan(SMALLEST_NORMAL_HALF);
    expect(stored.left).toBeCloseTo(magnitudeToDb(quiet), 0);
    expect(DataUtils.fromHalfFloat(DataUtils.toHalfFloat(quiet))).toBeLessThan(SMALLEST_NORMAL_HALF);
  });

  it("holds a magnitude half float cannot reach", () => {
    const { data, layout } = mockFile();
    data.packedData.fill(0);
    const loud = 1e6;
    expect(loud).toBeGreaterThan(65504);
    const pixel = layout.bandOffsets[0];
    data.packedData[pixel * 4] = loud;

    const overview = buildOverview(data.packedData, layout, data.metadata);
    const stored = readBin(overview.data, overview.layout.bandOffsets[0]);
    expect(stored.left).toBeCloseTo(magnitudeToDb(loud), 0);
    // As a linear magnitude it saturates at half float's maximum, which reads
    // back 23 dB quieter than it is.
    const saturated = DataUtils.fromHalfFloat(DataUtils.toHalfFloat(loud));
    expect(saturated).toBe(LARGEST_HALF);
    expect(magnitudeToDb(loud) - magnitudeToDb(saturated)).toBeGreaterThan(20);
  });

  // Worst at the quiet end, where half float's exponent is largest: an eighth
  // of a dB at -140, and finer everywhere the display normally sits.
  it("stores dB to an eighth of a dB across the displayed range", () => {
    // An irrational step, so the probe lands between representable values
    // rather than on them.
    const step = Math.PI / 1000;
    let worst = 0;
    let worstAt = 0;
    for (let db = -140; db <= 24; db += step) {
      const error = Math.abs(DataUtils.fromHalfFloat(DataUtils.toHalfFloat(db)) - db);
      if (error > worst) {
        worst = error;
        worstAt = db;
      }
    }
    expect(worst).toBeLessThan(0.13);
    console.log(
      `[paging] overview dB quantisation: worst ${worst.toFixed(4)} dB (at ${worstAt.toFixed(1)} dB) over -140..+24`,
    );
  });
});

describe("overview updates", () => {
  it("re-decimates only the groups a range touches, and matches a full rebuild", () => {
    const { data, layout } = mockFile();
    stampMagnitudes(data.packedData, layout);
    const overview = buildOverview(data.packedData, layout, data.metadata);

    const band = 3;
    const start = layout.bandOffsets[band] + 20;
    const count = 35;
    for (let i = 0; i < count; i++) data.packedData[(start + i) * 4] = 0.9;

    const untouchedBand = 0;
    const before = readBin(overview.data, overview.layout.bandOffsets[untouchedBand]);
    updateOverviewRanges(overview, data.packedData, layout, Uint32Array.of(start, count));
    const after = readBin(overview.data, overview.layout.bandOffsets[untouchedBand]);
    expect(after).toEqual(before);

    const rebuilt = buildOverview(data.packedData, layout, data.metadata);
    expect(Array.from(overview.data)).toEqual(Array.from(rebuilt.data));
  });

  // A max is not incrementally updatable downwards: a patch that lowers the
  // group's peak must re-read every bin of the group, not just the changed one.
  it("follows a peak downwards", () => {
    const { data, layout } = mockFile();
    data.packedData.fill(0);
    const band = 1;
    const groupStart = layout.bandOffsets[band];
    for (let i = 0; i < OVERVIEW_DECIMATION; i++) data.packedData[(groupStart + i) * 4] = 0.1;
    data.packedData[(groupStart + 3) * 4] = 0.8;

    const overview = buildOverview(data.packedData, layout, data.metadata);
    expect(readBin(overview.data, overview.layout.bandOffsets[band]).left).toBeCloseTo(magnitudeToDb(0.8), 1);

    data.packedData[(groupStart + 3) * 4] = 0.05;
    updateOverviewRanges(overview, data.packedData, layout, Uint32Array.of(groupStart + 3, 1));
    expect(readBin(overview.data, overview.layout.bandOffsets[band]).left).toBeCloseTo(magnitudeToDb(0.1), 1);
  });

  it("updates every group a range straddles, including partial ones at both ends", () => {
    const { data, layout } = mockFile();
    stampMagnitudes(data.packedData, layout);
    const overview = buildOverview(data.packedData, layout, data.metadata);

    const band = 2;
    // Start and end inside groups rather than on their boundaries.
    const start = layout.bandOffsets[band] + OVERVIEW_DECIMATION + 3;
    const count = OVERVIEW_DECIMATION * 2 + 5;
    for (let i = 0; i < count; i++) data.packedData[(start + i) * 4] = 0.7;

    updateOverviewRanges(overview, data.packedData, layout, Uint32Array.of(start, count));
    const rebuilt = buildOverview(data.packedData, layout, data.metadata);
    expect(Array.from(overview.data)).toEqual(Array.from(rebuilt.data));
  });

  it("does not run past the end of a band", () => {
    const { data, layout } = mockFile();
    stampMagnitudes(data.packedData, layout);
    const overview = buildOverview(data.packedData, layout, data.metadata);
    // A range spanning several whole bands at once, as a wide patch would.
    const start = layout.bandOffsets[1];
    const count = layout.bandOffsets[4] - start;
    updateOverviewRanges(overview, data.packedData, layout, Uint32Array.of(start, count));
    const rebuilt = buildOverview(data.packedData, layout, data.metadata);
    expect(Array.from(overview.data)).toEqual(Array.from(rebuilt.data));
  });
});
