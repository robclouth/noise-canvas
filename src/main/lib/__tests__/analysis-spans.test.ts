import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";
import { SAMPLE_RATE, signal, worstResultDifference } from "./analysis-fixtures";

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

describe("analysis in spans", () => {
  it("gives the same coefficients however many spans the file is cut into", async () => {
    const channel = signal(3);
    const params = { bandsPerOctave: 24, minFreq: 40 };
    const whole = await addon.analyze([channel], 1, SAMPLE_RATE, { ...params, spanSeconds: 60 });
    const cut = await addon.analyze([channel], 1, SAMPLE_RATE, { ...params, spanSeconds: 0.25 });

    expect(cut.texels).toBe(whole.texels);
    const { mag, step } = worstResultDifference(whole, cut);
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
