import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { growWandSelection } from "../magic-wand";
import { selectionBandRange, selectionFrameRange, selectionMaskTest } from "../selection";
import { bandIndexToPitchUv } from "../utils";
import { blockGrid } from "../block-grid";
import { readPackedSpan } from "../packed-span";
import { gatherPixelRanges } from "../pixel-ranges";

type MockSpec = ReturnType<typeof createConstantQMockSpectrogramData>;

// 16 bands over 4 octaves at 1024 Hz: bands 0-3 step 1 frame, 4-7 step 2,
// 8-11 step 4, 12-15 step 8 — the wand has to walk the dyadic grid.
function makeSpec() {
  return createConstantQMockSpectrogramData({
    durationSeconds: 1,
    sampleRate: 1024,
    bandsPerOctave: 4,
    minFreq: 32,
    constantMagnitude: 0.001,
  });
}

/** Reads `spec`'s packed state through the store's span reader, counting the reads. */
function readerOf(spec: MockSpec, reads: { start: number; end: number }[] = []) {
  return (start: number, end: number) => {
    reads.push({ start, end });
    return readPackedSpan(spec, start, end, async (ranges) => gatherPixelRanges(spec.packedData, ranges));
  };
}

const LOUD = 0.4;
const LOUD_BANDS = { low: 2, high: 6 };
const LOUD_FRAMES = { from: 100, to: 300 };

// Raises every bin whose left edge falls in the loud window, on the loud bands.
function paintLoudRegion(spec: MockSpec, frames = LOUD_FRAMES): void {
  const { bandOffsets, bandStepLog2s, bandLengths } = spec.synthesisMetadata;
  for (let band = LOUD_BANDS.low; band <= LOUD_BANDS.high; band++) {
    const step = 1 << bandStepLog2s[band];
    for (let k = Math.ceil(frames.from / step); k * step < frames.to && k < bandLengths[band]; k++) {
      const base = (bandOffsets[band] + k) * 4;
      spec.packedData[base] = LOUD;
      spec.packedData[base + 2] = LOUD;
    }
  }
}

describe("growWandSelection", () => {
  it("selects the connected loud region and nothing beyond it", async () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const selection = await growWandSelection(readerOf(spec), spec, 0.2, seedPitch, 20);
    expect(selection).not.toBeNull();
    if (!selection) return;

    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(LOUD_FRAMES.from);
    expect(endFrame).toBe(LOUD_FRAMES.to);
    const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
    expect(lowBand).toBe(LOUD_BANDS.low);
    expect(highBand).toBe(LOUD_BANDS.high);

    const test = selectionMaskTest(selection, spec.sampleRate, spec.numBands);
    expect(test).not.toBeNull();
    if (!test) return;
    expect(test(4, 200)).toBe(true);
    expect(test(2, 150)).toBe(true);
  });

  it("floods the whole file when the tolerance reaches the floor", async () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const selection = await growWandSelection(readerOf(spec), spec, 0.2, seedPitch, 60);
    expect(selection).not.toBeNull();
    if (!selection) return;
    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(0);
    expect(endFrame).toBe(spec.numFrames);
    const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
    expect(lowBand).toBe(0);
    expect(highBand).toBe(spec.numBands - 1);
  });

  it("grows from a quiet seed through the quiet floor only", async () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    // A quiet seed far from the loud region: the loud bins are louder than the
    // seed, so they join; the wand selects everything connected at or above
    // seed level minus the tolerance — which here is the whole file.
    const seedPitch = bandIndexToPitchUv(10.5, spec.numBands);
    const selection = await growWandSelection(readerOf(spec), spec, 0.9, seedPitch, 6);
    expect(selection).not.toBeNull();
    if (!selection) return;
    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(0);
    expect(endFrame).toBe(spec.numFrames);
  });

  // A file of several blocks, read a block at a time.
  function longSpec() {
    const spec = createConstantQMockSpectrogramData({
      durationSeconds: 16,
      sampleRate: 8000,
      bandsPerOctave: 4,
      minFreq: 64,
      constantMagnitude: 0.001,
    });
    const grid = blockGrid({ numBands: spec.numBands, metadata: spec.metadata }, spec.numFrames, spec.sampleRate);
    return { spec, chunk: grid.blockFrames, blocks: grid.blockCount };
  }

  it("reads only the chunks the region reaches, however far it runs", async () => {
    const { spec, chunk, blocks } = longSpec();
    expect(blocks).toBeGreaterThanOrEqual(6);
    const loud = { from: Math.round(1.5 * chunk), to: Math.round(3.5 * chunk) };
    paintLoudRegion(spec, loud);
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const reads: { start: number; end: number }[] = [];
    const selection = await growWandSelection(
      readerOf(spec, reads),
      spec,
      (2.5 * chunk) / spec.sampleRate,
      seedPitch,
      20,
      chunk,
    );
    expect(selection).not.toBeNull();
    if (!selection) return;
    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(loud.from);
    expect(endFrame).toBe(loud.to);
    const chunks = reads.map((r) => r.start / chunk).sort((a, b) => a - b);
    expect(chunks).toEqual([1, 2, 3]);
  });

  it("gives nothing when a read fails", async () => {
    const { spec, chunk } = longSpec();
    paintLoudRegion(spec, { from: Math.round(1.5 * chunk), to: Math.round(3.5 * chunk) });
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const read = readerOf(spec);
    const seedChunk = 2;
    const failsElsewhere = (start: number, end: number) =>
      start === seedChunk * chunk ? read(start, end) : Promise.resolve(null);
    const seedSec = (2.5 * chunk) / spec.sampleRate;
    expect(await growWandSelection(failsElsewhere, spec, seedSec, seedPitch, 20, chunk)).toBeNull();
  });
});
