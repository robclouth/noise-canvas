import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

// The stored phase runs unwrapped: each bin sits on the branch nearest the bin
// before it in the same band, so the value accumulates over the file instead of
// folding back into (-pi, pi]. Everything downstream — the transform's pitch
// scaling, the phase-turn deltas, the synthesis — reads it that way.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
};

const SAMPLE_RATE = 44100;

function sine(seconds: number, hz: number): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.5;
  return data;
}

/** The largest jump between neighbouring bins of one band, and the largest phase reached. */
function phaseWalk(result: GaboratorAnalysisResult): { jump: number; reach: number } {
  let jump = 0;
  let reach = 0;
  for (let band = 0; band < result.numBands; band++) {
    const offset = result.bandOffsets[band];
    const length = result.bandLengths[band];
    for (let k = 1; k < length; k++) {
      const previous = result.data[(offset + k - 1) * 4 + 1];
      const phase = result.data[(offset + k) * 4 + 1];
      jump = Math.max(jump, Math.abs(phase - previous));
      reach = Math.max(reach, Math.abs(phase));
    }
  }
  return { jump, reach };
}

describe("analysis phase", () => {
  it("keeps every band on the branch nearest its own previous bin", async () => {
    const result = await addon.analyze([sine(1, 440)], 1, SAMPLE_RATE, { bandsPerOctave: 24, minFreq: 40 });
    const { jump, reach } = phaseWalk(result);
    // A bin that lost its predecessor would land on the principal branch and
    // jump by the whole accumulated value.
    expect(jump).toBeLessThanOrEqual(Math.PI + 1e-4);
    // And the values really do accumulate, so the check above is not vacuous.
    expect(reach).toBeGreaterThan(100);
  });

  it("walks each channel's phase on its own", async () => {
    const left = sine(0.5, 440);
    const right = sine(0.5, 1320);
    const result = await addon.analyze([left, right], 2, SAMPLE_RATE, { bandsPerOctave: 24, minFreq: 40 });
    for (let band = 0; band < result.numBands; band++) {
      const offset = result.bandOffsets[band];
      const length = result.bandLengths[band];
      for (let k = 1; k < length; k++) {
        for (const channel of [0, 1]) {
          const previous = result.data[(offset + k - 1) * 4 + channel * 2 + 1];
          const phase = result.data[(offset + k) * 4 + channel * 2 + 1];
          expect(Math.abs(phase - previous)).toBeLessThanOrEqual(Math.PI + 1e-4);
        }
      }
    }
  });
});
