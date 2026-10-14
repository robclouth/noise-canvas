import { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import type { SpectrogramData } from "../../store/types";
import { PackedSpan } from "../packed-span";
import { maskFromRows, type Selection } from "../selection";
import { placeAudioSpan, selectionSpan, spanBandTables, spliceSelectionParts } from "../split-selection";

/** A 4-band file on a dyadic grid whose every magnitude is band * 1000 + bin + 1. */
function makeFile(numFrames = 128): { spec: SpectrogramData; whole: Float32Array } {
  const stepLog2s = [0, 1, 2, 2];
  const numBands = stepLog2s.length;
  const bandOffsets = new Uint32Array(numBands);
  const bandStepLog2s = Int32Array.from(stepLog2s);
  const bandLengths = new Uint32Array(numBands);
  const metadata = new Float64Array(numBands * 4);
  let total = 0;
  for (let band = 0; band < numBands; band++) {
    bandLengths[band] = ((numFrames - 1) >> stepLog2s[band]) + 1;
    bandOffsets[band] = total;
    metadata.set([total, bandLengths[band], stepLog2s[band], 440 * 2 ** (numBands - 1 - band)], band * 4);
    total += bandLengths[band];
  }
  const whole = new Float32Array(total * 4);
  for (let band = 0; band < numBands; band++) {
    for (let bin = 0; bin < bandLengths[band]; bin++) {
      const at = (bandOffsets[band] + bin) * 4;
      whole.set([band * 1000 + bin + 1, 0.5, band * 1000 + bin + 1.25, -0.5], at);
    }
  }
  const spec: SpectrogramData = {
    packedData: whole,
    inverseMap: new Float32Array(total * 2),
    metadata,
    texels: total,
    numFrames,
    numBands,
    numChannels: 2,
    sampleRate: 1,
    packedTextureSize: new Vector2(total, 1),
    minFreq: 440,
    bandsPerOctave: 12,
    synthesisMetadata: { bandOffsets, bandStepLog2s, bandLengths },
  };
  return { spec, whole };
}

/** `span` with every magnitude scaled by `gain` and the phases kept, as a mask separator returns it. */
function scaled(span: PackedSpan, gain: number): PackedSpan {
  const values = span.values.slice();
  for (let i = 0; i < values.length; i += 2) values[i] *= gain;
  return new PackedSpan(span.view, values);
}

/** True when `bin` of `band` is at a pixel inside [startFrame, endFrame) by its left edge. */
function insideFrames(spec: SpectrogramData, band: number, bin: number, startFrame: number, endFrame: number): boolean {
  const edge = bin * 2 ** spec.synthesisMetadata.bandStepLog2s[band];
  return edge >= startFrame && edge < endFrame;
}

const fullHeight: Selection = { start: 40, end: 72, pitchLo: 0, pitchHi: 1 };

describe("spliceSelectionParts", () => {
  it("leaves the file as it was outside the selection and adds back up to it inside", async () => {
    const { spec, whole } = makeFile();
    const span = await selectionSpan(spec, whole, fullHeight);
    expect(span.view.texels).toBeLessThan(spec.texels);
    const [first, second] = spliceSelectionParts(spec, whole, [scaled(span, 0.25), scaled(span, 0.75)], fullHeight);
    const { bandOffsets, bandLengths } = spec.synthesisMetadata;
    for (let band = 0; band < spec.numBands; band++) {
      for (let bin = 0; bin < bandLengths[band]; bin++) {
        const at = (bandOffsets[band] + bin) * 4;
        const inside = insideFrames(spec, band, bin, 40, 72);
        for (const ch of [0, 2]) {
          expect(first[at + ch] + second[at + ch]).toBeCloseTo(whole[at + ch], 4);
          expect(first[at + ch]).toBeCloseTo(inside ? whole[at + ch] * 0.25 : whole[at + ch], 4);
          expect(second[at + ch]).toBe(inside ? Math.fround(whole[at + ch] * 0.75) : 0);
        }
        if (inside) expect(second[at + 1]).toBe(whole[at + 1]);
      }
    }
  });

  it("splits only the selected bands of a band-limited selection", async () => {
    const { spec, whole } = makeFile();
    // Bands 1..2: pitch UV counts up from the lowest band.
    const selection: Selection = { start: 40, end: 72, pitchLo: 0.25, pitchHi: 0.75 };
    const span = await selectionSpan(spec, whole, selection);
    const [, second] = spliceSelectionParts(spec, whole, [scaled(span, 0), scaled(span, 1)], selection);
    const { bandOffsets, bandLengths } = spec.synthesisMetadata;
    for (const band of [0, 3]) {
      for (let bin = 0; bin < bandLengths[band]; bin++) expect(second[(bandOffsets[band] + bin) * 4]).toBe(0);
    }
    const bin = 50 >> spec.synthesisMetadata.bandStepLog2s[1];
    expect(second[(bandOffsets[1] + bin) * 4]).toBe(whole[(bandOffsets[1] + bin) * 4]);
  });

  it("follows the selection's shape", async () => {
    const { spec, whole } = makeFile();
    // One row over all four bands, inside for the first half of the span only.
    const selection: Selection = { start: 40, end: 72, pitchLo: 0, pitchHi: 1, mask: maskFromRows([[0, 0.5]]) };
    const span = await selectionSpan(spec, whole, selection);
    const [, second] = spliceSelectionParts(spec, whole, [scaled(span, 0), scaled(span, 1)], selection);
    const { bandOffsets } = spec.synthesisMetadata;
    expect(second[(bandOffsets[0] + 45) * 4]).toBe(whole[(bandOffsets[0] + 45) * 4]);
    expect(second[(bandOffsets[0] + 60) * 4]).toBe(0);
  });

  it("does not change the file's own run", async () => {
    const { spec, whole } = makeFile();
    const before = whole.slice();
    const span = await selectionSpan(spec, whole, fullHeight);
    spliceSelectionParts(spec, whole, [scaled(span, 0.5), scaled(span, 0.5)], fullHeight);
    expect(whole).toEqual(before);
  });

  it("takes whole-file parts as well as spans", () => {
    const { spec, whole } = makeFile();
    const stem = new Float32Array(whole.length).fill(7);
    const [, second] = spliceSelectionParts(
      spec,
      whole,
      [PackedSpan.whole(spec, whole), PackedSpan.whole(spec, stem)],
      fullHeight,
    );
    expect(second[(spec.synthesisMetadata.bandOffsets[0] + 50) * 4]).toBe(7);
    expect(second[(spec.synthesisMetadata.bandOffsets[0] + 10) * 4]).toBe(0);
  });
});

describe("spanBandTables", () => {
  it("gives the span's own band tables, which cover its values", async () => {
    const { spec, whole } = makeFile();
    const span = await selectionSpan(spec, whole, fullHeight);
    const tables = spanBandTables(span, 2);
    const last = tables.numBands - 1;
    expect(tables.bandOffsets[0]).toBe(0);
    expect((tables.bandOffsets[last] + tables.bandLengths[last]) * 4).toBe(span.values.length);
  });
});

describe("placeAudioSpan", () => {
  it("puts the span at its frame and silence around it", () => {
    const [channel] = placeAudioSpan([Float32Array.of(1, 2, 3)], 2, 6);
    expect(Array.from(channel)).toEqual([0, 0, 1, 2, 3, 0]);
  });
});
