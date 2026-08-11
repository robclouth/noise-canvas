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

  it("blames the band that carries the energy", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const result = computeClipAttribution(data, data.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);

    const start = 10 * data.numFrames;
    let peak = 0;
    for (let i = start; i < start + data.numFrames; i++) peak = Math.max(peak, Math.abs(result[i]));
    expect(peak).toBeGreaterThan(0);
  });

  it("flips the blame when the partial is inverted", () => {
    // Same magnitude, opposite phase: the partial now pulls the waveform back
    // from the peak instead of driving it, so every contribution negates.
    const inPhase = spectrogramWithBand(10, 0.5, 0);
    const inverted = spectrogramWithBand(10, 0.5, Math.PI);

    const a = computeClipAttribution(inPhase, inPhase.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    const b = computeClipAttribution(inverted, inverted.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);

    const start = 10 * inPhase.numFrames;
    for (let i = start; i < start + inPhase.numFrames; i++) {
      expect(b[i]).toBeCloseTo(-a[i], 5);
    }
  });

  it("flips the blame when the overload is a negative peak", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const positive = computeClipAttribution(data, data.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);
    const negative = computeClipAttribution(
      data,
      data.packedData,
      [{ sample: 128, sign: -1, excessDb: 3 }],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );

    const start = 10 * data.numFrames;
    for (let i = start; i < start + data.numFrames; i++) {
      expect(negative[i]).toBeCloseTo(-positive[i], 5);
    }
  });

  it("keeps values inside [-1, 1] and peaks at the overload's severity", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const result = computeClipAttribution(data, data.packedData, overloads, ANALYSIS_OVERLAP, CLIP_FULL_TINT_DB);

    let peak = 0;
    for (const v of result) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
      peak = Math.max(peak, Math.abs(v));
    }
    // 3 dB of overshoot against a 6 dB full-tint reference.
    expect(peak).toBeCloseTo(3 / CLIP_FULL_TINT_DB, 6);
  });

  it("saturates once the overshoot reaches the full-tint reference", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    const result = computeClipAttribution(
      data,
      data.packedData,
      [{ sample: 128, sign: 1, excessDb: CLIP_FULL_TINT_DB * 2 }],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );

    let peak = 0;
    for (const v of result) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(1, 6);
  });

  it("fades the whole map as the overshoot shrinks", () => {
    // The property that makes "reduce until the red is gone" converge: halving
    // the overshoot must halve the tint everywhere, not merely re-rank it.
    const data = spectrogramWithBand(10, 0.5, 0);
    const loud = computeClipAttribution(
      data,
      data.packedData,
      [{ sample: 128, sign: 1, excessDb: 4 }],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );
    const quiet = computeClipAttribution(
      data,
      data.packedData,
      [{ sample: 128, sign: 1, excessDb: 2 }],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );

    const start = 10 * data.numFrames;
    for (let i = start; i < start + data.numFrames; i++) {
      expect(quiet[i]).toBeCloseTo(loud[i] / 2, 6);
    }
  });

  it("scales blame with how badly the sample overloaded", () => {
    const data = spectrogramWithBand(10, 0.5, 0);
    // Two overloads of differing severity at well-separated times: the harder
    // one must dominate the normalized map.
    const result = computeClipAttribution(
      data,
      data.packedData,
      [
        { sample: 40, sign: 1, excessDb: 1 },
        { sample: 200, sign: 1, excessDb: 8 },
      ],
      ANALYSIS_OVERLAP,
      CLIP_FULL_TINT_DB,
    );

    const start = 10 * data.numFrames;
    expect(Math.abs(result[start + 200])).toBeGreaterThan(Math.abs(result[start + 40]));
  });
});
