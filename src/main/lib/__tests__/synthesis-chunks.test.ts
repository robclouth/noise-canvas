import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatherPixelRanges } from "../../../renderer/src/lib/pixel-ranges";
import { alignToBandGrid, packedViewOf } from "../packed-view";
import { synthesiseInChunks, synthesisViewOf, type SynthesiseView, type SynthesisPass } from "../synthesis-chunks";
import type { GaboratorAnalysisResult, PackedLayout } from "../types";
import { SAMPLE_RATE, signal } from "./analysis-fixtures";

// The audio can be rebuilt a chunk of the file at a time, each pass reading
// only its own span of coefficients through a view and splicing its chunk into
// the audio the pass before it left. What comes out has to be what one pass
// over the whole file gives.

const require = createRequire(import.meta.url);

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  synthesisReadReach: (rate: number, params: { bandsPerOctave: number; minFreq: number }) => number;
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number; fullSynthesisSupport?: boolean },
  ) => Promise<GaboratorAnalysisResult>;
  synthesize: (
    packed: Float32Array,
    meta: PackedLayout,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number; fullSynthesisSupport?: boolean },
    applyLimiter: boolean,
    existingAudio: Float32Array[],
    startFrame?: number,
    endFrame?: number,
    startBand?: number,
    endBand?: number,
  ) => Promise<SynthesisPass>;
};

const PARAMS = { bandsPerOctave: 24, minFreq: 40 };

function layoutOf(result: GaboratorAnalysisResult): PackedLayout {
  return {
    numFrames: result.numFrames,
    numChannels: result.numChannels,
    numBands: result.numBands,
    bandOffsets: result.bandOffsets,
    bandStepLog2s: result.bandStepLog2s,
    bandLengths: result.bandLengths,
  };
}

async function analysed(seconds: number, channels = 1) {
  const audio = [signal(seconds)];
  if (channels === 2) audio.push(signal(seconds).map((v, i) => (i % 3 ? -0.7 * v : v)));
  const result = await addon.analyze(audio, channels, SAMPLE_RATE, PARAMS);
  const layout = layoutOf(result);
  const whole = await addon.synthesize(result.data, layout, SAMPLE_RATE, PARAMS, false, []);
  const read = async (ranges: Uint32Array) => gatherPixelRanges(result.data, ranges);
  const synthesise: SynthesiseView = (packed, meta, existingAudio, startFrame, endFrame) =>
    addon.synthesize(
      packed,
      meta,
      SAMPLE_RATE,
      { ...PARAMS, fullSynthesisSupport: true },
      false,
      existingAudio,
      startFrame,
      endFrame,
    );
  return { result, layout, whole, read, synthesise, reach: addon.synthesisReadReach(SAMPLE_RATE, PARAMS) };
}

/** The largest sample difference between two renderings, and the loudest either reached. */
function worstSample(a: Float32Array[], b: Float32Array[]): { worst: number; loudest: number } {
  let worst = 0;
  let loudest = 0;
  for (let ch = 0; ch < a.length; ch++) {
    for (let i = 0; i < a[ch].length; i++) {
      worst = Math.max(worst, Math.abs(a[ch][i] - b[ch][i]));
      loudest = Math.max(loudest, Math.abs(a[ch][i]));
    }
  }
  return { worst, loudest };
}

describe("a region rebuilt from a view", () => {
  it("gives the samples a partial pass over the whole run gives", async () => {
    const { result, layout, read, reach } = await analysed(30, 2);
    // Audio the region is spliced into: the file's own, with its channels
    // swapped so the splice shows wherever it lands.
    const base = await addon.synthesize(result.data, layout, SAMPLE_RATE, PARAMS, false, []);
    const existing = () => [base.channels[1].slice(), base.channels[0].slice()];
    const startFrame = Math.round(14.1 * SAMPLE_RATE);
    const endFrame = Math.round(15.7 * SAMPLE_RATE);
    const startBand = 10;
    const endBand = 60;

    const fromRun = await addon.synthesize(
      result.data,
      layout,
      SAMPLE_RATE,
      PARAMS,
      false,
      existing(),
      startFrame,
      endFrame,
      startBand,
      endBand,
    );
    const view = synthesisViewOf(layout, SAMPLE_RATE, reach, startFrame, endFrame);
    expect(view.meta.viewStartFrame).toBeGreaterThan(0);
    expect(view.meta.viewEndFrame).toBeLessThan(layout.numFrames);
    const fromView = await addon.synthesize(
      await read(view.ranges),
      view.meta,
      SAMPLE_RATE,
      PARAMS,
      false,
      existing(),
      startFrame,
      endFrame,
      startBand,
      endBand,
    );

    const { worst, loudest } = worstSample(fromRun.channels, fromView.channels);
    expect(loudest).toBeGreaterThan(0.2);
    expect(worst, `largest sample difference ${worst}`).toBeLessThan(2e-6);
  });
});

describe("audio rebuilt a chunk at a time", () => {
  it("preserves low-frequency audio across the production 30-second boundary", async () => {
    const rate = 8000;
    const params = { bandsPerOctave: 48, minFreq: 20 };
    const audio = Float32Array.from({ length: 96 * rate }, (_, i) => {
      const t = i / rate;
      return (
        0.3 * Math.sin(2 * Math.PI * 40 * t) + 0.1 * Math.exp(-Math.abs(t - 30) * 2) * Math.sin(2 * Math.PI * 75 * t)
      );
    });
    const analysis = await addon.analyze([audio], 1, rate, params);
    const layout = layoutOf(analysis);
    const whole = await addon.synthesize(analysis.data, layout, rate, params, false, []);
    const pass: SynthesiseView = (packed, meta, existing, start, end) =>
      addon.synthesize(packed, meta, rate, { ...params, fullSynthesisSupport: true }, false, existing, start, end);
    const chunked = await synthesiseInChunks(
      pass,
      async (ranges) => gatherPixelRanges(analysis.data, ranges),
      layout,
      rate,
      addon.synthesisReadReach(rate, params),
    );
    const { worst } = worstSample(whole.channels, chunked.channels);
    console.log("Chunk boundary maximum sample error", worst);
    expect(worst, `largest low-frequency sample difference ${worst}`).toBeLessThan(2e-6);
  }, 120000);

  it("gives the samples a whole-file pass gives", async () => {
    const { layout, whole, read, synthesise, reach } = await analysed(6);
    const chunked = await synthesiseInChunks(synthesise, read, layout, SAMPLE_RATE, reach, 1.5);

    expect(chunked.channels[0].length).toBe(whole.channels[0].length);
    const { worst, loudest } = worstSample(whole.channels, chunked.channels);
    expect(loudest).toBeGreaterThan(0.2);
    expect(worst, `largest sample difference ${worst}`).toBeLessThan(2e-6);
  });

  it("keeps both channels apart", async () => {
    const { layout, whole, read, synthesise, reach } = await analysed(4, 2);
    const chunked = await synthesiseInChunks(synthesise, read, layout, SAMPLE_RATE, reach, 1.5);

    expect(chunked.channels.length).toBe(2);
    const { worst } = worstSample(whole.channels, chunked.channels);
    expect(worst).toBeLessThan(2e-6);
  });

  it("gives the same audio however the file is cut", async () => {
    const { layout, read, synthesise, reach } = await analysed(6);
    const coarse = await synthesiseInChunks(synthesise, read, layout, SAMPLE_RATE, reach, 3);
    const fine = await synthesiseInChunks(synthesise, read, layout, SAMPLE_RATE, reach, 1);
    const { worst } = worstSample(coarse.channels, fine.channels);
    expect(worst).toBeLessThan(2e-6);
  });

  it("never reads the whole run at once", async () => {
    const { layout, read, synthesise, reach } = await analysed(36);
    let widest = 0;
    const watched = async (ranges: Uint32Array) => {
      let texels = 0;
      for (let i = 1; i < ranges.length; i += 2) texels += ranges[i];
      widest = Math.max(widest, texels);
      return await read(ranges);
    };
    await synthesiseInChunks(synthesise, watched, layout, SAMPLE_RATE, reach, 1.5);
    let texels = 0;
    for (let b = 0; b < layout.numBands; b++) texels += layout.bandLengths[b];
    expect(widest).toBeLessThan(0.6 * texels);
  });

  it("refuses a view that falls short of the pass's reach", async () => {
    const { result, layout, read } = await analysed(4);
    // A view of the file's first half, asked to rebuild the frames at its own
    // edge: the fill that feeds the synthesis reads past it.
    const span = alignToBandGrid(layout, 0, 2 * SAMPLE_RATE);
    const view = packedViewOf(layout, span.startFrame, span.endFrame);
    const packed = await read(view.ranges);
    const meta: PackedLayout = { ...layout, viewStartFrame: span.startFrame, viewEndFrame: span.endFrame };
    const audio = [new Float32Array(layout.numFrames)];

    expect(packed.length).toBe(view.texels * 4);
    expect(result.numFrames).toBe(layout.numFrames);
    await expect(
      addon.synthesize(packed, meta, SAMPLE_RATE, PARAMS, false, audio, span.endFrame - 4410, span.endFrame),
    ).rejects.toThrow(/reach/);
  });
});
