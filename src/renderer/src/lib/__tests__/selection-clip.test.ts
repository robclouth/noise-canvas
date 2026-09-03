import { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import type { SpectrogramData } from "../../store/types";
import type { Selection } from "../selection";
import { buildClipboardRegion, clipboardSourceOffset, dropRect } from "../selection-clip";

/**
 * A 4-band spec with dyadic time steps (band 0 is the highest frequency, as
 * gaborator lays it out) and a packed readback where every stored coefficient
 * is identifiable as band * 100 + bin.
 */
function makeSpec(): { spec: SpectrogramData; data: Float32Array } {
  const numFrames = 32;
  const stepLog2s = [0, 1, 2, 2];
  const numBands = stepLog2s.length;

  const bandOffsets = new Uint32Array(numBands);
  const bandStepLog2s = new Int32Array(numBands);
  const bandLengths = new Uint32Array(numBands);
  let total = 0;
  for (let band = 0; band < numBands; band++) {
    bandStepLog2s[band] = stepLog2s[band];
    bandLengths[band] = ((numFrames - 1) >> stepLog2s[band]) + 1;
    bandOffsets[band] = total;
    total += bandLengths[band];
  }

  const metadata = new Float64Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    metadata[band * 4] = bandOffsets[band];
    metadata[band * 4 + 1] = bandLengths[band];
    metadata[band * 4 + 2] = stepLog2s[band];
    metadata[band * 4 + 3] = 440 * 2 ** (numBands - 1 - band);
  }

  const data = new Float32Array(total * 4);
  for (let band = 0; band < numBands; band++) {
    for (let bin = 0; bin < bandLengths[band]; bin++) {
      const at = (bandOffsets[band] + bin) * 4;
      data[at] = band * 100 + bin;
      data[at + 1] = 0.5;
      data[at + 2] = band * 100 + bin + 0.25;
      data[at + 3] = -0.5;
    }
  }

  const spec: SpectrogramData = {
    packedData: new Float32Array(total * 4),
    inverseMap: new Float32Array(total * 2),
    metadata,
    texels: total,
    numFrames,
    numBands,
    numChannels: 2,
    sampleRate: 1,
    packedTextureSize: new Vector2(64, 1),
    minFreq: 440,
    bandsPerOctave: 12,
    synthesisMetadata: { bandOffsets, bandStepLog2s, bandLengths },
  };
  return { spec, data };
}

// Bands 1..2 inclusive: pitch UV is y-up and band indices count down, so the
// top edge 1 - 1/4 maps to band 1 and the bottom edge 1 - 3/4 to band 2.
const midBands: Selection = { start: 5, end: 13, pitchLo: 0.25, pitchHi: 0.75 };

describe("buildClipboardRegion", () => {
  it("aligns the crop origin to the coarsest copied band's bin step", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    // Coarsest copied band is band 2 with 4-frame bins: 5 rounds down to 4,
    // and 13 - 4 = 9 frames round up to 12.
    expect(clip?.originFrame).toBe(4);
    expect(clip?.spec.numFrames).toBe(12);
    expect(Array.from(clip?.spec.synthesisMetadata.bandLengths ?? [])).toEqual([12, 6, 3, 3]);
  });

  it("copies exactly the bins whose left edge falls inside the selection", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    if (!clip) return;

    const { bandOffsets } = clip.spec.synthesisMetadata;
    const magAt = (band: number, bin: number) => clip.spec.packedData![(bandOffsets[band] + bin) * 4];

    // Band 1 has 2-frame bins; left edges in [5, 13) are bins 3..6 of the
    // source, which land at clip bins 1..4 with the origin at frame 4.
    expect([0, 1, 2, 3, 4, 5].map((bin) => magAt(1, bin))).toEqual([0, 103, 104, 105, 106, 0]);
    // Band 2 has 4-frame bins; left edges in [5, 13) are source bins 2..3.
    expect([0, 1, 2].map((bin) => magAt(2, bin))).toEqual([0, 202, 203]);
    // All four channels of a copied pixel come across.
    const at = (bandOffsets[1] + 1) * 4;
    expect(Array.from(clip.spec.packedData!.slice(at, at + 4))).toEqual([103, 0.5, 103.25, -0.5]);
  });

  it("keeps unselected bands silent but in place, with their frequencies unchanged", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    if (!clip) return;

    const { bandOffsets, bandLengths } = clip.spec.synthesisMetadata;
    for (const band of [0, 3]) {
      for (let bin = 0; bin < bandLengths[band]; bin++) {
        expect(clip.spec.packedData![(bandOffsets[band] + bin) * 4]).toBe(0);
      }
    }
    for (let band = 0; band < spec.numBands; band++) {
      expect(clip.spec.metadata[band * 4 + 3]).toBe(spec.metadata[band * 4 + 3]);
    }
  });

  it("returns null for an empty selection", () => {
    const { spec, data } = makeSpec();
    expect(buildClipboardRegion(data, { ...midBands, end: midBands.start }, spec, "src")).toBeNull();
  });
});

describe("buildClipboardRegion onsets", () => {
  it("keeps only the onsets inside the selection, in the clipboard's own time", () => {
    const { spec, data } = makeSpec();
    // Pairs of [timeSec, salience]; the crop origin is frame 4 at 1 Hz.
    const sourceOnsets = new Float32Array([2, 0.9, 5, 0.8, 12, 0.7, 13, 0.6]);
    const clip = buildClipboardRegion(data, midBands, spec, "src", sourceOnsets, 65);
    expect(clip).not.toBeNull();
    if (!clip) return;
    // 2 sits before the selection and 13 at its exclusive end; 5 and 12 stay,
    // shifted by the 4-frame crop origin.
    const rounded = Array.from(clip.onsets).map((v, i) => (i % 2 === 0 ? v : Math.round(v * 100) / 100));
    expect(rounded).toEqual([1, 0.8, 8, 0.7]);
    expect(clip.onsetSensitivity).toBe(65);
  });
});

describe("dropRect", () => {
  it("keeps the clipboard's size and moves only the corner in its own layout", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    if (!clip) return;

    const rect = dropRect(clip, 20, 0.5, spec);
    expect(rect.start).toBe(20);
    expect(rect.end - rect.start).toBeCloseTo(midBands.end - midBands.start);
    expect(rect.pitchLo).toBe(0.5);
    expect(rect.pitchHi - rect.pitchLo).toBeCloseTo(midBands.pitchHi - midBands.pitchLo);
  });

  it("converts the height so another layout gets the same octaves", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    if (!clip) return;

    // Half the bands at the same bands-per-octave: each octave spans twice the
    // UV, so the rectangle doubles in height.
    const dest = { numBands: spec.numBands / 2, bandsPerOctave: spec.bandsPerOctave };
    const rect = dropRect(clip, 20, 0.5, dest);
    expect(rect.pitchHi - rect.pitchLo).toBeCloseTo((midBands.pitchHi - midBands.pitchLo) * 2);
    expect(rect.end - rect.start).toBeCloseTo(midBands.end - midBands.start);
  });
});

describe("clipboardSourceOffset", () => {
  it("points at the copied corner inside the clipboard's own file", () => {
    const { spec, data } = makeSpec();
    const clip = buildClipboardRegion(data, midBands, spec, "src");
    expect(clip).not.toBeNull();
    if (!clip) return;

    const offset = clipboardSourceOffset(clip);
    // The selection starts at frame 5 and the crop at frame 4, so the corner
    // sits one frame into the 12-frame clip.
    expect(offset.timeFraction).toBeCloseTo(1 / 12);
    expect(offset.pitchFraction).toBe(midBands.pitchLo);
  });
});
