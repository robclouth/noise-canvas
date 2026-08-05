import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

// Exercises the coefficient-domain separators against real Gaborator output.
// The property that matters for both is conservation: NMF's masks sum to 1
// across parts and leave phase alone, so the parts add back up to what they
// were split from, and mergeSpectrograms is what adds them up. Everything here
// runs on a spectrogram produced by the addon's own analyze() rather than a
// hand-built buffer, so the band layout the maskers walk is the real one.

const require = createRequire(import.meta.url);

type BandLayout = {
  numBands: number;
  numChannels: number;
  bandOffsets: Uint32Array;
  bandLengths: Uint32Array;
};

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
  nmf: (
    packedData: Float32Array,
    meta: BandLayout,
    numComponents: number,
    iterations?: number,
    seed?: number,
  ) => Promise<{ parts: Float32Array[] }>;
  mergeSpectrograms: (parts: Float32Array[], meta: BandLayout) => Promise<{ merged: Float32Array }>;
  hpss: (
    packedData: Float32Array,
    meta: BandLayout,
    kernelH?: number,
    kernelV?: number,
  ) => Promise<{ harmonic: Float32Array; percussive: Float32Array }>;
};

const SR = 44100;
const DURATION = 1.0;
const FLOATS_PER_PIXEL = 4;
// The addon walks every coefficient of a real analysis, so each case is well
// past vitest's 5 s default.
const TIMEOUT = 120_000;

/**
 * A low sustained tone plus a high one that pulses, in stereo. Two sources this
 * far apart in both frequency and time envelope is the case NMF should have no
 * trouble pulling apart.
 */
function makeTwoSourceSignal(): Float32Array[] {
  const length = Math.floor(SR * DURATION);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const low = 0.4 * Math.sin(2 * Math.PI * 220 * t);
    // Eight bursts of a high tone, so its activation is distinct in time.
    const gate = Math.floor(t * 8) % 2 === 0 ? 1 : 0;
    const high = 0.3 * gate * Math.sin(2 * Math.PI * 3520 * t);
    left[i] = low + high;
    right[i] = low + high;
  }
  return [left, right];
}

/** Smallest signed angle congruent to `radians`, for comparing unwrapped phases. */
function wrapToPi(radians: number): number {
  return radians - 2 * Math.PI * Math.round(radians / (2 * Math.PI));
}

/** Walk every coefficient the band layout actually stores. */
function forEachCoefficient(meta: BandLayout, visit: (magIndex: number) => void): void {
  for (let b = 0; b < meta.numBands; b++) {
    const length = meta.bandLengths[b];
    for (let t = 0; t < length; t++) {
      for (let ch = 0; ch < meta.numChannels; ch++) {
        visit((meta.bandOffsets[b] + t) * FLOATS_PER_PIXEL + ch * 2);
      }
    }
  }
}

/** Total magnitude a spectrogram holds, per band — used to see where a part's energy sits. */
function bandEnergies(packed: Float32Array, meta: BandLayout): number[] {
  const energies = new Array<number>(meta.numBands).fill(0);
  for (let b = 0; b < meta.numBands; b++) {
    const length = meta.bandLengths[b];
    for (let t = 0; t < length; t++) {
      for (let ch = 0; ch < meta.numChannels; ch++) {
        energies[b] += packed[(meta.bandOffsets[b] + t) * FLOATS_PER_PIXEL + ch * 2];
      }
    }
  }
  return energies;
}

/** Magnitude-weighted mean band index: where a part sits in the spectrum. */
function spectralCentroid(packed: Float32Array, meta: BandLayout): number {
  const energies = bandEnergies(packed, meta);
  let num = 0;
  let den = 0;
  for (let b = 0; b < meta.numBands; b++) {
    num += b * energies[b];
    den += energies[b];
  }
  return den > 0 ? num / den : 0;
}

describe("coefficient-domain separation", () => {
  let analysis: GaboratorAnalysisResult;
  let meta: BandLayout;

  beforeAll(async () => {
    analysis = await addon.analyze(makeTwoSourceSignal(), 2, SR, { bandsPerOctave: 24, minFreq: 30 });
    meta = {
      numBands: analysis.numBands,
      numChannels: analysis.numChannels,
      bandOffsets: analysis.bandOffsets,
      bandLengths: analysis.bandLengths,
    };
  }, 60_000);

  describe("nmf", () => {
    it(
      "returns the requested number of parts",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 3, 40, 1);
        expect(parts).toHaveLength(3);
        for (const part of parts) expect(part.length).toBe(analysis.data.length);
      },
      TIMEOUT,
    );

    it(
      "splits magnitude without creating or destroying any",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 4, 60, 1);
        let worst = 0;
        forEachCoefficient(meta, (i) => {
          let summed = 0;
          for (const part of parts) summed += part[i];
          worst = Math.max(worst, Math.abs(summed - analysis.data[i]));
        });
        // The masks sum to total/(total+eps), so the shortfall is the epsilon.
        expect(worst).toBeLessThan(1e-5);
      },
      TIMEOUT,
    );

    it(
      "leaves the phase channels untouched",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 3, 40, 1);
        let changed = 0;
        for (const part of parts) {
          forEachCoefficient(meta, (i) => {
            if (part[i + 1] !== analysis.data[i + 1]) changed++;
          });
        }
        expect(changed).toBe(0);
      },
      TIMEOUT,
    );

    it(
      "never hands a part more than the input held",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 3, 40, 1);
        let minMagnitude = Infinity;
        let worstExcess = 0;
        for (const part of parts) {
          forEachCoefficient(meta, (i) => {
            minMagnitude = Math.min(minMagnitude, part[i]);
            worstExcess = Math.max(worstExcess, part[i] - analysis.data[i]);
          });
        }
        expect(minMagnitude).toBeGreaterThanOrEqual(0);
        expect(worstExcess).toBeLessThan(1e-6);
      },
      TIMEOUT,
    );

    it(
      "orders parts from lowest to highest spectral centroid",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 4, 80, 1);
        const centroids = parts.map((part) => spectralCentroid(part, meta));
        expect(centroids).toEqual([...centroids].sort((a, b) => a - b));
      },
      TIMEOUT,
    );

    it(
      "puts two well-separated sources in different parts",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 2, 150, 1);
        const [low, high] = parts.map((part) => spectralCentroid(part, meta));
        // 220 Hz and 3520 Hz are four octaves apart; at 24 bands per octave
        // that is ~96 bands, so centroids close together mean the
        // factorisation did not actually pull the two sources apart.
        expect(high - low).toBeGreaterThan(24);
      },
      TIMEOUT,
    );

    it(
      "is reproducible for a given seed and varies with it",
      async () => {
        const a = await addon.nmf(analysis.data, meta, 3, 40, 7);
        const b = await addon.nmf(analysis.data, meta, 3, 40, 7);
        const c = await addon.nmf(analysis.data, meta, 3, 40, 8);
        expect(Array.from(a.parts[0])).toEqual(Array.from(b.parts[0]));
        expect(Array.from(a.parts[0])).not.toEqual(Array.from(c.parts[0]));
      },
      TIMEOUT,
    );
  });

  describe("mergeSpectrograms", () => {
    it(
      "reconstructs the input from its nmf parts",
      async () => {
        const { parts } = await addon.nmf(analysis.data, meta, 5, 60, 1);
        const { merged } = await addon.mergeSpectrograms(parts, meta);

        let worstMag = 0;
        let worstPhase = 0;
        forEachCoefficient(meta, (i) => {
          worstMag = Math.max(worstMag, Math.abs(merged[i] - analysis.data[i]));
          if (analysis.data[i] > 1e-4) {
            worstPhase = Math.max(worstPhase, Math.abs(wrapToPi(merged[i + 1] - analysis.data[i + 1])));
          }
        });
        expect(worstMag).toBeLessThan(1e-4);
        expect(worstPhase).toBeLessThan(1e-3);
      },
      TIMEOUT,
    );

    it(
      "keeps phase on the unwrapped branch analyze produced",
      async () => {
        // analyze() accumulates phase across time rather than wrapping it, and
        // the transform effect scales that value directly. A merge that handed
        // back atan2's [-π, π] would quietly change what a later stretch does.
        const { parts } = await addon.nmf(analysis.data, meta, 3, 40, 1);
        const { merged } = await addon.mergeSpectrograms(parts, meta);

        let originalRange = 0;
        let worstDrift = 0;
        forEachCoefficient(meta, (i) => {
          originalRange = Math.max(originalRange, Math.abs(analysis.data[i + 1]));
          if (analysis.data[i] > 1e-4) {
            worstDrift = Math.max(worstDrift, Math.abs(merged[i + 1] - analysis.data[i + 1]));
          }
        });
        // Guards the premise: if analysis ever started wrapping, this test
        // would pass for the wrong reason.
        expect(originalRange).toBeGreaterThan(Math.PI);
        expect(worstDrift).toBeLessThan(1e-3);
      },
      TIMEOUT,
    );

    it(
      "reconstructs the input from its hpss parts",
      async () => {
        const { harmonic, percussive } = await addon.hpss(analysis.data, meta);
        const { merged } = await addon.mergeSpectrograms([harmonic, percussive], meta);

        let worstMag = 0;
        forEachCoefficient(meta, (i) => {
          worstMag = Math.max(worstMag, Math.abs(merged[i] - analysis.data[i]));
        });
        expect(worstMag).toBeLessThan(1e-4);
      },
      TIMEOUT,
    );

    it(
      "adds coefficients as complex numbers, not as magnitudes",
      async () => {
        // Two parts holding the same magnitude in antiphase. A magnitude sum
        // would double them; a complex sum cancels them.
        const a = analysis.data.slice();
        const b = analysis.data.slice();
        forEachCoefficient(meta, (i) => {
          a[i] *= 0.5;
          b[i] *= 0.5;
          b[i + 1] = a[i + 1] + Math.PI;
        });

        const { merged } = await addon.mergeSpectrograms([a, b], meta);
        let worst = 0;
        forEachCoefficient(meta, (i) => {
          worst = Math.max(worst, merged[i]);
        });
        expect(worst).toBeLessThan(1e-5);
      },
      TIMEOUT,
    );

    it(
      "is a no-op on a single input",
      async () => {
        const { merged } = await addon.mergeSpectrograms([analysis.data], meta);
        let worstMag = 0;
        let worstPhase = 0;
        forEachCoefficient(meta, (i) => {
          worstMag = Math.max(worstMag, Math.abs(merged[i] - analysis.data[i]));
          worstPhase = Math.max(worstPhase, Math.abs(merged[i + 1] - analysis.data[i + 1]));
        });
        expect(worstMag).toBeLessThan(1e-6);
        expect(worstPhase).toBeLessThan(1e-3);
      },
      TIMEOUT,
    );

    it(
      "rejects inputs whose lengths disagree",
      async () => {
        await expect(
          addon.mergeSpectrograms([analysis.data, analysis.data.slice(0, analysis.data.length - 4)], meta),
        ).rejects.toThrow(/same length/);
      },
      TIMEOUT,
    );
  });
});
