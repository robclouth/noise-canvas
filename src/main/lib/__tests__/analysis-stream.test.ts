import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandLayoutOf } from "../../../renderer/src/lib/band-layout";
import { blockGrid, blockPixelRanges, frameRangeOfBlock } from "../../../renderer/src/lib/block-grid";
import { scatterCompactPixelRanges } from "../../../renderer/src/lib/pixel-ranges";
import type { GaboratorAnalysisResult } from "../types";
import { SAMPLE_RATE, signal, worstDifference } from "./analysis-fixtures";

// The analysis can be driven a span of frames at a time, so the coefficients of
// the whole file are never held. A span holds exactly the block of the packed
// state that covers the same frames, and the spans together have to give what
// one pass over the whole file gives.

const require = createRequire(import.meta.url);

type AnalysisParams = { bandsPerOctave: number; minFreq: number; maxCoefficients?: number };

type StreamLayout = {
  texels: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  metadata: Float32Array;
  bandOffsets: Uint32Array;
  bandLengths: Uint32Array;
  bandStepLog2s: Int32Array;
  bandFreqsHz: Float32Array;
};

type AnalysisStream = {
  layout(): StreamLayout;
  span(startFrame: number, endFrame: number): Promise<Float32Array>;
  summary(): { magnitudeEnergy: number; onsetBandMax: Float32Array };
};

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: AnalysisParams & { spanSeconds?: number },
  ) => Promise<GaboratorAnalysisResult>;
  AnalysisStream: new (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: AnalysisParams,
  ) => AnalysisStream;
};

const BLOCK_SECONDS = 0.25;

function gridOf(layout: StreamLayout) {
  const bands = bandLayoutOf(
    layout.numBands,
    layout.bandOffsets,
    layout.bandLengths,
    layout.bandStepLog2s,
    layout.bandFreqsHz,
  );
  return blockGrid(bands, layout.numFrames, layout.sampleRate, BLOCK_SECONDS);
}

/**
 * Drives the stream block by block and puts each span back where the block grid
 * says it belongs, so the run it builds is only right if every span holds
 * exactly its own block.
 */
async function streamWholeFile(channels: Float32Array[], params: AnalysisParams) {
  const stream = new addon.AnalysisStream(channels, channels.length, SAMPLE_RATE, params);
  const layout = stream.layout();
  const grid = gridOf(layout);
  const data = new Float32Array(layout.texels * 4);
  const spanTexels: number[] = [];
  for (let index = 0; index < grid.blockCount; index++) {
    const { start, end } = frameRangeOfBlock(grid, index);
    const list = blockPixelRanges(grid, index);
    const span = await stream.span(start, end);
    spanTexels.push(span.length / 4);
    scatterCompactPixelRanges(data, span, list.ranges.slice(0, list.count * 2));
  }
  return { stream, layout, grid, data, spanTexels };
}

describe("analysis driven a span at a time", () => {
  it("lays the bands out exactly as a whole-file pass does", async () => {
    const channel = signal(2);
    const params = { bandsPerOctave: 24, minFreq: 40 };
    const whole = await addon.analyze([channel], 1, SAMPLE_RATE, params);
    const layout = new addon.AnalysisStream([channel], 1, SAMPLE_RATE, params).layout();

    expect(layout.texels).toBe(whole.texels);
    expect(layout.numBands).toBe(whole.numBands);
    expect([...layout.bandOffsets]).toEqual([...whole.bandOffsets]);
    expect([...layout.bandLengths]).toEqual([...whole.bandLengths]);
    expect([...layout.bandStepLog2s]).toEqual([...whole.bandStepLog2s]);
  });

  it("gives each span the texels its own block holds", async () => {
    const channel = signal(2);
    const { grid, spanTexels, layout } = await streamWholeFile([channel], { bandsPerOctave: 24, minFreq: 40 });

    expect(grid.blockCount).toBeGreaterThan(4);
    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      let texels = 0;
      for (let i = 0; i < list.count; i++) texels += list.ranges[i * 2 + 1];
      expect(spanTexels[index], `block ${index}`).toBe(texels);
    }
    expect(spanTexels.reduce((a, b) => a + b, 0)).toBe(layout.texels);
  });

  it("builds the coefficients a whole-file pass builds", async () => {
    const channel = signal(3);
    const params = { bandsPerOctave: 24, minFreq: 40 };
    const whole = await addon.analyze([channel], 1, SAMPLE_RATE, params);
    const { data, layout } = await streamWholeFile([channel], params);

    const { mag, step } = worstDifference(layout, whole.data, data);
    expect(mag, `largest magnitude difference ${mag}`).toBeLessThan(1e-5);
    expect(step, `largest phase-step difference ${step}`).toBeLessThan(1e-3);
  });

  it("carries the phase unwrap across the seams", async () => {
    const channel = signal(3);
    const { data, layout } = await streamWholeFile([channel], { bandsPerOctave: 24, minFreq: 40 });

    // An unwrapped run stays within pi of its previous bin wherever there is
    // signal to follow; a run that restarted at a seam jumps by whole turns.
    let worst = 0;
    for (let band = 0; band < layout.numBands; band++) {
      const offset = layout.bandOffsets[band];
      for (let k = 1; k < layout.bandLengths[band]; k++) {
        const i = (offset + k) * 4;
        if (data[i] <= 1e-3 || data[i - 4] <= 1e-3) continue;
        worst = Math.max(worst, Math.abs(data[i + 1] - data[i - 3]));
      }
    }
    expect(worst).toBeLessThanOrEqual(Math.PI + 1e-4);
  });

  it("keeps both channels apart", async () => {
    const left = signal(2);
    const right = signal(2).map((v, i) => (i % 2 ? -v : v * 0.25));
    const params = { bandsPerOctave: 12, minFreq: 60 };
    const whole = await addon.analyze([left, right], 2, SAMPLE_RATE, params);
    const { data, layout } = await streamWholeFile([left, right], params);

    let mag = 0;
    for (let texel = 0; texel < layout.texels; texel++) {
      mag = Math.max(mag, Math.abs(whole.data[texel * 4 + 2] - data[texel * 4 + 2]));
    }
    expect(mag).toBeLessThan(1e-5);
  });

  it("totals the same energy, and each band's loudest moment", async () => {
    const channel = signal(2);
    const params = { bandsPerOctave: 12, minFreq: 60 };
    const whole = await addon.analyze([channel], 1, SAMPLE_RATE, params);
    const { stream, data, layout } = await streamWholeFile([channel], params);
    const summary = stream.summary();

    expect(summary.magnitudeEnergy).toBeCloseTo(whole.magnitudeEnergy, 3);
    for (let band = 0; band < layout.numBands; band++) {
      let loudest = 0;
      for (let k = 0; k < layout.bandLengths[band]; k++) {
        loudest = Math.max(loudest, data[(layout.bandOffsets[band] + k) * 4]);
      }
      expect(summary.onsetBandMax[band], `band ${band}`).toBeCloseTo(Math.log1p(20 * loudest), 5);
    }
  });

  it("refuses a span that does not join the one before it", async () => {
    const channel = signal(1);
    const stream = new addon.AnalysisStream([channel], 1, SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 60 });
    await stream.span(0, 4096);
    await expect(stream.span(8192, 12288)).rejects.toThrow(/in order/);
  });

  it("refuses a file past the coefficient budget", () => {
    const channel = signal(1);
    expect(
      () =>
        new addon.AnalysisStream([channel], 1, SAMPLE_RATE, { bandsPerOctave: 12, minFreq: 60, maxCoefficients: 1000 }),
    ).toThrow(/maximum audio duration/);
  });
});
