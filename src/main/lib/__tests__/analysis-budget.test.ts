import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

// Exercises the analysis-side coefficient budget: a caller passes the packed
// coefficient count its GPU memory allows, and analysis must refuse a file
// that needs more before allocating anything, with the same maximum-duration
// message the texture cap produces.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number; maxCoefficients?: number },
  ) => Promise<GaboratorAnalysisResult>;
  getGpuMemoryInfo: () => { bytes: number; unified: boolean; name: string };
};

const SAMPLE_RATE = 44100;

function noiseChannel(seconds: number): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 1234;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff - 1) * 0.5;
  }
  return data;
}

describe("analysis coefficient budget", () => {
  it("analyses a file that fits the budget", async () => {
    const result = await addon.analyze([noiseChannel(1)], 1, SAMPLE_RATE, {
      bandsPerOctave: 12,
      minFreq: 40,
      maxCoefficients: 10_000_000,
    });
    expect(result.textureWidth * result.textureHeight).toBeGreaterThan(0);
    expect(result.textureWidth * result.textureHeight).toBeLessThanOrEqual(10_000_000);
  });

  it("refuses a file that exceeds the budget, quoting the allowed duration", async () => {
    const channel = noiseChannel(2);
    const fits = await addon.analyze([channel], 1, SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 40 });
    const needed = fits.textureWidth * fits.textureHeight;

    await expect(
      addon.analyze([channel], 1, SAMPLE_RATE, {
        bandsPerOctave: 12,
        minFreq: 40,
        maxCoefficients: Math.floor(needed / 2),
      }),
    ).rejects.toThrow(/maximum audio duration/);
  });

  it("accepts and refuses the same file at every resolution", async () => {
    const resolutions = [12, 24, 36, 48, 60];
    // Just above what the file needs at its densest resolution, so a limit that
    // tracked the resolution in use would split the verdicts across the set.
    const channel = noiseChannel(1);
    const budget = Math.ceil(channel.length * 4.79) + 1;

    const accepted = await Promise.all(
      resolutions.map((bandsPerOctave) =>
        addon
          .analyze([channel], 1, SAMPLE_RATE, { bandsPerOctave, minFreq: 40, maxCoefficients: budget })
          .then(() => true)
          .catch(() => false),
      ),
    );
    expect(accepted).toEqual(resolutions.map(() => true));

    const refused = await Promise.all(
      resolutions.map((bandsPerOctave) =>
        addon
          .analyze([channel], 1, SAMPLE_RATE, { bandsPerOctave, minFreq: 40, maxCoefficients: budget - budget / 2 })
          .then(() => true)
          .catch(() => false),
      ),
    );
    expect(refused).toEqual(resolutions.map(() => false));
  });

  it("ignores a zero or missing budget", async () => {
    const channel = noiseChannel(0.5);
    const withZero = await addon.analyze([channel], 1, SAMPLE_RATE, {
      bandsPerOctave: 12,
      minFreq: 40,
      maxCoefficients: 0,
    });
    const without = await addon.analyze([channel], 1, SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 40 });
    expect(withZero.textureWidth).toBe(without.textureWidth);
    expect(withZero.textureHeight).toBe(without.textureHeight);
  });

  it("reports GPU memory as a non-negative number", () => {
    const { bytes } = addon.getGpuMemoryInfo();
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThanOrEqual(0);
  });
});
