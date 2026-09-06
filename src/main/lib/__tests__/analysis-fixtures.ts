import { expect } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

export const SAMPLE_RATE = 44100;

/** A tone with an attack partway through, so a seam has a transient to cross. */
export function signal(seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const hit = Math.exp(-8 * Math.abs(t - seconds * 0.37));
    data[i] = 0.4 * Math.sin(2 * Math.PI * 330 * t) + 0.3 * hit * Math.sin(2 * Math.PI * 1870 * t);
  }
  return data;
}

// Below this a coefficient is numerical noise: full scale is about 0.46, so
// this is 53 dB down. Its phase is arbitrary, and an unwrapped phase carries
// the arbitrariness of every bin before it in the band, so only bins that
// carry signal — and the step between two of them — can be compared.
const SIGNAL_FLOOR = 1e-3;

/** The per-band layout of a packed run, however it was produced. */
export type CoefficientLayout = {
  numBands: number;
  bandOffsets: ArrayLike<number>;
  bandLengths: ArrayLike<number>;
};

/** The largest magnitude difference, and the largest difference in phase step, between two runs. */
export function worstDifference(
  layout: CoefficientLayout,
  a: Float32Array,
  b: Float32Array,
): { mag: number; step: number } {
  let mag = 0;
  let step = 0;
  let compared = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const offset = layout.bandOffsets[band];
    const length = layout.bandLengths[band];
    for (let k = 0; k < length; k++) {
      const i = (offset + k) * 4;
      mag = Math.max(mag, Math.abs(a[i] - b[i]));
      if (k === 0 || a[i] <= SIGNAL_FLOOR || a[i - 4] <= SIGNAL_FLOOR) continue;
      step = Math.max(step, Math.abs(a[i + 1] - a[i - 3] - (b[i + 1] - b[i - 3])));
      compared++;
    }
  }
  expect(compared).toBeGreaterThan(1000);
  return { mag, step };
}

/** The same comparison between two whole analysis results. */
export function worstResultDifference(a: GaboratorAnalysisResult, b: GaboratorAnalysisResult) {
  return worstDifference(a, a.data, b.data);
}
