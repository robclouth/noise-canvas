import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { growWandSelection } from "../magic-wand";
import { selectionBandRange, selectionFrameRange, selectionMaskTest } from "../selection";
import { bandIndexToPitchUv } from "../utils";

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

const LOUD = 0.4;
const LOUD_BANDS = { low: 2, high: 6 };
const LOUD_FRAMES = { from: 100, to: 300 };

// Raises every bin whose left edge falls in the loud window, on the loud bands.
function paintLoudRegion(spec: ReturnType<typeof makeSpec>): void {
  const { bandOffsets, bandStepLog2s, bandLengths } = spec.synthesisMetadata;
  for (let band = LOUD_BANDS.low; band <= LOUD_BANDS.high; band++) {
    const step = 1 << bandStepLog2s[band];
    for (let k = Math.ceil(LOUD_FRAMES.from / step); k * step < LOUD_FRAMES.to && k < bandLengths[band]; k++) {
      const base = (bandOffsets[band] + k) * 4;
      spec.packedData[base] = LOUD;
      spec.packedData[base + 2] = LOUD;
    }
  }
}

describe("growWandSelection", () => {
  it("selects the connected loud region and nothing beyond it", () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const selection = growWandSelection(spec.packedData, spec, 0.2, seedPitch, 20);
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

  it("floods the whole file when the tolerance reaches the floor", () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    const seedPitch = bandIndexToPitchUv(4.5, spec.numBands);
    const selection = growWandSelection(spec.packedData, spec, 0.2, seedPitch, 60);
    expect(selection).not.toBeNull();
    if (!selection) return;
    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(0);
    expect(endFrame).toBe(spec.numFrames);
    const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
    expect(lowBand).toBe(0);
    expect(highBand).toBe(spec.numBands - 1);
  });

  it("grows from a quiet seed through the quiet floor only", () => {
    const spec = makeSpec();
    paintLoudRegion(spec);
    // A quiet seed far from the loud region: the loud bins are louder than the
    // seed, so they join; the wand selects everything connected at or above
    // seed level minus the tolerance — which here is the whole file.
    const seedPitch = bandIndexToPitchUv(10.5, spec.numBands);
    const selection = growWandSelection(spec.packedData, spec, 0.9, seedPitch, 6);
    expect(selection).not.toBeNull();
    if (!selection) return;
    const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
    expect(startFrame).toBe(0);
    expect(endFrame).toBe(spec.numFrames);
  });
});
