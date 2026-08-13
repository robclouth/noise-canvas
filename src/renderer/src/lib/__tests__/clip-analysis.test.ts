import { describe, expect, it } from "vitest";
import { computeClipAttribution, findOverloads, type Overload } from "../clip-analysis";
import { ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB, FULL_SCALE_DB_OFFSET, FULL_SCALE_MAGNITUDE } from "../constants";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";

/** Silent buffer with a single peak of the given amplitude. */
function bufferWithPeak(length: number, at: number, amplitude: number): Float32Array[] {
  const channel = new Float32Array(length);
  channel[at] = amplitude;
  return [channel, channel.slice()];
}

describe("full-scale calibration", () => {
  it("maps the measured full-scale magnitude to 0 dBFS", () => {
    const dbfs = 20 * Math.log10(FULL_SCALE_MAGNITUDE) + FULL_SCALE_DB_OFFSET;
    expect(dbfs).toBeCloseTo(0, 10);
  });

  it("puts magnitude 1.0 above full scale", () => {
    const dbfs = 20 * Math.log10(1) + FULL_SCALE_DB_OFFSET;
    expect(dbfs).toBeGreaterThan(6);
    expect(dbfs).toBeLessThan(7);
  });
});

describe("findOverloads", () => {
  it("finds the peak sample when the limiter is bypassed", () => {
    const channels = bufferWithPeak(1000, 400, 1.5);
    const overloads = findOverloads(channels, 44100, null);

    expect(overloads).toHaveLength(1);
    expect(overloads[0].sample).toBe(400);
    expect(overloads[0].sign).toBe(1);
    expect(overloads[0].excessDb).toBeCloseTo(20 * Math.log10(1.5), 5);
  });

  it("records the sign of a negative peak", () => {
    const channels = bufferWithPeak(1000, 400, -1.5);
    const overloads = findOverloads(channels, 44100, null);

    expect(overloads).toHaveLength(1);
    expect(overloads[0].sign).toBe(-1);
  });

  it("ignores samples that stay below full scale", () => {
    const channels = bufferWithPeak(1000, 400, 0.9);
    expect(findOverloads(channels, 44100, null)).toHaveLength(0);
  });

  it("uses the gain-reduction envelope when the limiter is engaged", () => {
    const sampleRate = 44100;
    const hop = Math.round(sampleRate * 0.005);
    // Audio stays under the ceiling — the limiter already pulled it back — so
    // the overload is only discoverable through the envelope.
    const channel = new Float32Array(hop * 6);
    const peakAt = hop * 2 + 37;
    channel[peakAt] = 0.79;
    const gainReductionDb = new Float32Array(6);
    gainReductionDb[2] = 3.5;

    const overloads = findOverloads([channel], sampleRate, gainReductionDb);

    expect(overloads).toHaveLength(1);
    expect(overloads[0].sample).toBe(peakAt);
    expect(overloads[0].excessDb).toBeCloseTo(3.5, 5);
  });

  it("reports nothing when the envelope shows no reduction", () => {
    const gainReductionDb = new Float32Array(6);
    expect(findOverloads([new Float32Array(1000)], 44100, gainReductionDb)).toHaveLength(0);
  });
});

describe("computeClipAttribution", () => {
  const overloads: Overload[] = [{ sample: 128, sign: 1, excessDb: 3 }];

  /** Mock spectrogram with one band carrying a constant magnitude at `phase`. */
  function spectrogramWithBand(band: number, magnitude: number, phase: number) {
    const data = createMockSpectrogramData({ numFrames: 256, numBands: 128, pattern: "silence" });
    const { numFrames } = data;
    for (let frame = 0; frame < numFrames; frame++) {
      const index = (band * numFrames + frame) * 4;
      data.packedData[index] = magnitude;
      data.packedData[index + 1] = phase;
      data.packedData[index + 2] = magnitude;
      data.packedData[index + 3] = phase;
    }
    return data;
  }

  it("returns an all-zero map when nothing overloaded", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const result = computeClipAttribution(data, data.packedData, [], ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    expect(result.some((v) => v !== 0)).toBe(false);
  });

  it("leaves silent coefficients unblamed", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const result = computeClipAttribution(data, data.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);

    // Band 40 was never filled, so none of its coefficients may be blamed.
    const start = 40 * data.numFrames;
    for (let i = start; i < start + data.numFrames; i++) expect(result[i]).toBe(0);
  });

  function peakOf(map: Float32Array): number {
    let peak = 0;
    for (const value of map) peak = Math.max(peak, value);
    return peak;
  }

  // Every coefficient in a band shares the carrier evaluated at the overload,
  // so one phase drives the peak outwards and the opposite one holds it back.
  // Only the first is blamed; the caller gets whichever that is.
  function blamedBand(list: Overload[], band = 10): Float32Array {
    const inPhase = spectrogramWithBand(band, 0.5, 0);
    const inverted = spectrogramWithBand(band, 0.5, Math.PI);
    const a = computeClipAttribution(inPhase, inPhase.packedData, list, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    const b = computeClipAttribution(inverted, inverted.packedData, list, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    return peakOf(a) > 0 ? a : b;
  }

  it("blames the phase that drives the peak outwards, and only that one", () => {
    const inPhase = spectrogramWithBand(10, 0.5, 0);
    const inverted = spectrogramWithBand(10, 0.5, Math.PI);

    const a = computeClipAttribution(inPhase, inPhase.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    const b = computeClipAttribution(inverted, inverted.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);

    // Attenuating the other phase would make the clipping worse, so it stays
    // unmarked rather than being blamed alongside.
    expect(Math.min(peakOf(a), peakOf(b))).toBe(0);
    expect(Math.max(peakOf(a), peakOf(b))).toBeGreaterThan(0);
  });

  it("swaps which phase it blames when the overload is a negative peak", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const positive = computeClipAttribution(data, data.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    const negative = computeClipAttribution(
      data,
      data.packedData,
      [{ sample: 128, sign: -1, excessDb: 3 }],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );

    expect(Math.min(peakOf(positive), peakOf(negative))).toBe(0);
    expect(Math.max(peakOf(positive), peakOf(negative))).toBeGreaterThan(0);
  });

  it("keeps values inside [0, 1] and peaks at the overload's severity", () => {
    const result = blamedBand(overloads);

    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
    // 3 dB of overshoot against a 6 dB full-tint reference.
    expect(peakOf(result)).toBeCloseTo(3 / CLIP_FULL_TINT_DB, 6);
  });

  it("saturates once the overshoot reaches the full-tint reference", () => {
    const result = blamedBand([{ sample: 128, sign: 1, excessDb: CLIP_FULL_TINT_DB * 2 }]);
    expect(peakOf(result)).toBeCloseTo(1, 6);
  });

  it("fades the whole map as the overshoot shrinks", () => {
    // The property that makes "reduce until the red is gone" converge: halving
    // the overshoot must halve the tint everywhere, not merely re-rank it.
    const loud = blamedBand([{ sample: 128, sign: 1, excessDb: 4 }]);
    const quiet = blamedBand([{ sample: 128, sign: 1, excessDb: 2 }]);

    expect(peakOf(loud)).toBeGreaterThan(0);
    for (let i = 0; i < loud.length; i++) expect(quiet[i]).toBeCloseTo(loud[i] / 2, 6);
  });

  it("scales blame with how badly the sample overloaded", () => {
    // Two overloads of differing severity, on a band whose atom is narrow
    // enough that neither reaches the other's sample.
    const band = 110;
    const result = blamedBand(
      [
        { sample: 40, sign: 1, excessDb: 1 },
        { sample: 200, sign: 1, excessDb: 4 },
      ],
      band,
    );

    const start = band * 256;
    expect(result[start + 40]).toBeGreaterThan(0);
    expect(result[start + 200]).toBeGreaterThan(result[start + 40]);
  });
});
