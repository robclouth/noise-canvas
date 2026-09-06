import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandLayoutOf } from "../../../renderer/src/lib/band-layout";
import { blockBandLayout, blockGrid, blockPixelRanges } from "../../../renderer/src/lib/block-grid";
import { gatherPixelRanges, scatterCompactPixelRanges } from "../../../renderer/src/lib/pixel-ranges";
import type { GaboratorAnalysisResult } from "../types";

// Merging files sums their coefficients texel by texel, so a block of the sum
// is the sum of that block. Summing block by block lets a merge run without
// holding any file's coefficients in one run — but only if a block's own packed
// layout is exactly what the merge reads, which is what this pins.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
  mergeSpectrograms: (
    parts: Float32Array[],
    meta: { numBands: number; numChannels: number; bandOffsets: Uint32Array; bandLengths: Uint32Array },
  ) => Promise<{ merged: Float32Array }>;
};

const SAMPLE_RATE = 44100;
const PARAMS = { bandsPerOctave: 24, minFreq: 40 };
const SECONDS = 9;

/** A tone with hits over it, so the parts differ from each other band by band. */
function part(freq: number, hits: number[]): Float32Array {
  const data = new Float32Array(Math.round(SECONDS * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    data[i] = 0.2 * Math.sin(2 * Math.PI * freq * t) * Math.exp(-0.1 * t);
  }
  for (const at of hits) {
    const start = Math.round(at * SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE * 0.15 && start + i < data.length; i++) {
      const t = i / SAMPLE_RATE;
      data[start + i] += 0.6 * Math.exp(-20 * t) * Math.sin(2 * Math.PI * freq * 4 * t);
    }
  }
  return data;
}

function layoutOf(result: GaboratorAnalysisResult) {
  const freqs = new Float64Array(result.numBands);
  for (let band = 0; band < result.numBands; band++) freqs[band] = result.metadata[band * 4 + 3];
  return bandLayoutOf(result.numBands, result.bandOffsets, result.bandLengths, result.bandStepLog2s, freqs);
}

describe("a merge run block by block", () => {
  it("gives what a merge of the whole run gives, texel for texel", async () => {
    const results = await Promise.all([
      addon.analyze([part(220, [0.5, 3.2, 6.1])], 1, SAMPLE_RATE, PARAMS),
      addon.analyze([part(330, [1.4, 4.8])], 1, SAMPLE_RATE, PARAMS),
      addon.analyze([part(495, [2.6, 7.3])], 1, SAMPLE_RATE, PARAMS),
    ]);
    const base = results[0];
    const layout = layoutOf(base);
    const grid = blockGrid(layout, base.numFrames, SAMPLE_RATE);
    expect(grid.blockCount).toBeGreaterThan(3);

    const meta = {
      numBands: base.numBands,
      numChannels: base.numChannels,
      bandOffsets: base.bandOffsets,
      bandLengths: base.bandLengths,
    };
    const { merged: whole } = await addon.mergeSpectrograms(
      results.map((r) => r.data),
      meta,
    );

    const assembled = new Float32Array(whole.length);
    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      const ranges = list.ranges.slice(0, list.count * 2);
      const parts = results.map((r) => gatherPixelRanges(r.data, ranges));
      const { merged } = await addon.mergeSpectrograms(parts, {
        ...blockBandLayout(grid, index),
        numChannels: base.numChannels,
      });
      scatterCompactPixelRanges(assembled, merged, ranges);
    }

    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < whole.length; i++) {
      const diff = Math.abs(assembled[i] - whole[i]);
      if (diff > worst) {
        worst = diff;
        worstAt = i;
      }
    }
    expect(worst, `texel ${worstAt >> 2}`).toBe(0);
  });

  it("lays a block out as the pixels the block holds", async () => {
    const result = await addon.analyze([part(220, [0.5])], 1, SAMPLE_RATE, PARAMS);
    const grid = blockGrid(layoutOf(result), result.numFrames, SAMPLE_RATE);

    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      const ranges = list.ranges.slice(0, list.count * 2);
      const { bandOffsets, bandLengths } = blockBandLayout(grid, index);

      // The block's own runs, band by band, are the ranges it gathers — same
      // lengths, laid back to back with no gap.
      let at = 0;
      let range = 0;
      for (let band = 0; band < result.numBands; band++) {
        expect(bandOffsets[band], `block ${index} band ${band} offset`).toBe(at);
        if (bandLengths[band] > 0) {
          expect(bandLengths[band], `block ${index} band ${band} length`).toBe(ranges[range * 2 + 1]);
          range++;
        }
        at += bandLengths[band];
      }
      expect(range).toBe(list.count);
      expect(at * 4).toBe(gatherPixelRanges(result.data, ranges).length);
    }
  });
});
