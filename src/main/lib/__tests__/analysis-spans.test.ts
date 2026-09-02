import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

// The analysis adds a span of audio at a time, writes out the coefficients no
// later sample can change, and drops them, so its coefficient tree holds a span
// rather than the file. The seams must leave no mark: a span short enough to
// cut a file many times has to produce what one pass over the whole file does.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number; spanSeconds?: number },
  ) => Promise<GaboratorAnalysisResult>;
};

const SAMPLE_RATE = 44100;

/** A tone with an attack partway through, so the seams have transients to cross. */
function signal(seconds: number): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) {
    const t = i / SAMPLE_RATE;
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

/** The largest magnitude difference, and the largest difference in phase step, between two runs. */
function worstDifference(a: GaboratorAnalysisResult, b: GaboratorAnalysisResult): { mag: number; step: number } {
  let mag = 0;
  let step = 0;
  let compared = 0;
  for (let band = 0; band < a.numBands; band++) {
    const offset = a.bandOffsets[band];
    const length = a.bandLengths[band];
    for (let k = 0; k < length; k++) {
      const i = (offset + k) * 4;
      mag = Math.max(mag, Math.abs(a.data[i] - b.data[i]));
      if (k === 0 || a.data[i] <= SIGNAL_FLOOR || a.data[i - 4] <= SIGNAL_FLOOR) continue;
      const stepA = a.data[i + 1] - a.data[i - 3];
      const stepB = b.data[i + 1] - b.data[i - 3];
      step = Math.max(step, Math.abs(stepA - stepB));
      compared++;
    }
  }
  expect(compared).toBeGreaterThan(1000);
  return { mag, step };
}

describe("analysis in spans", () => {
  it("gives the same coefficients however many spans the file is cut into", async () => {
    const channel = signal(3);
    const params = { bandsPerOctave: 24, minFreq: 40 };
    const whole = await addon.analyze([channel], 1, SAMPLE_RATE, { ...params, spanSeconds: 60 });
    const cut = await addon.analyze([channel], 1, SAMPLE_RATE, { ...params, spanSeconds: 0.25 });

    expect(cut.texels).toBe(whole.texels);
    const { mag, step } = worstDifference(whole, cut);
    expect(mag, `largest magnitude difference ${mag}`).toBeLessThan(1e-5);
    expect(step, `largest phase-step difference ${step}`).toBeLessThan(1e-3);
  });

  it("writes every coefficient once, however short the span", async () => {
    const channel = signal(2);
    const params = { bandsPerOctave: 12, minFreq: 60, spanSeconds: 0.1 };
    const result = await addon.analyze([channel], 1, SAMPLE_RATE, params);
    // A coefficient the walk never reached would still hold the zero the
    // result array was filled with.
    let written = 0;
    for (let i = 0; i < result.texels; i++) if (result.data[i * 4] !== 0) written++;
    expect(written).toBeGreaterThan(result.texels * 0.9);
  });
});
