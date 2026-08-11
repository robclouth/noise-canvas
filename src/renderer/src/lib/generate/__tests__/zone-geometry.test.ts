import { zoneSlice } from "@renderer/lib/generate/zones";
import { unitsToUv } from "@renderer/lib/utils";
import { describe, expect, it } from "vitest";

// A spectrogram whose numbers make the arithmetic easy to read: 24 bands per
// octave over 240 bands is 120 semitones of range.
const BANDS_PER_OCTAVE = 24;
const NUM_BANDS = 240;
const SPECTRUM_SEMIS = (NUM_BANDS / BANDS_PER_OCTAVE) * 12;
const BPM = 120;
const DURATION = 10;

/**
 * The UV span a corner-anchored stamp covers, through the conversion the
 * renderer places brushes with. A brush reaches up in pitch from its anchor.
 */
function coveredUv(anchorPitch: number, sizeSemis: number): { from: number; to: number } {
  const from = unitsToUv(0, anchorPitch, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS).y;
  const size = unitsToUv(0, sizeSemis, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS).y;
  return { from, to: from + size };
}

describe("zone geometry", () => {
  it("covers 120 semitones for this spectrogram", () => {
    expect(SPECTRUM_SEMIS).toBe(120);
  });

  it("maps the whole range onto the whole texture", () => {
    const whole = coveredUv(0, SPECTRUM_SEMIS);
    expect(whole.from).toBeCloseTo(0, 10);
    expect(whole.to).toBeCloseTo(1, 10);
  });

  it("tiles the texture without gaps, overlap, or overhang", () => {
    const count = 4;
    const spans = Array.from({ length: count }, (_, index) => {
      const slice = zoneSlice(index, count, SPECTRUM_SEMIS);
      return coveredUv(slice.anchorSemis, slice.heightSemis);
    });

    expect(spans[0].from).toBeCloseTo(0, 10);
    expect(spans[count - 1].to).toBeCloseTo(1, 10);
    for (let i = 1; i < count; i++) {
      expect(spans[i].from).toBeCloseTo(spans[i - 1].to, 10);
    }
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(-1e-9);
      expect(span.to).toBeLessThanOrEqual(1 + 1e-9);
      expect(span.to - span.from).toBeCloseTo(1 / count, 10);
    }
  });

  it("puts slice 0 at the bottom of the range and the last at the top", () => {
    const count = 3;
    const first = zoneSlice(0, count, SPECTRUM_SEMIS);
    const last = zoneSlice(count - 1, count, SPECTRUM_SEMIS);
    expect(coveredUv(first.anchorSemis, first.heightSemis).from).toBeCloseTo(0, 10);
    expect(coveredUv(last.anchorSemis, last.heightSemis).to).toBeCloseTo(1, 10);
  });
});
