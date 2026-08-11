import { resolveAimUv, type AimSnapping, type AimSpectrogram } from "@renderer/lib/aim";
import { BRUSH_ANCHOR_MODE_CORNER } from "@renderer/lib/constants";
import { bandIndexToPitchUv, pitchUvToBandIndex, unitsToUv, uvToUnits } from "@renderer/lib/utils";
import { Vector2 } from "three";
import { describe, expect, it } from "vitest";

// 24 bands per octave over 240 bands is 120 semitones of range.
const BANDS_PER_OCTAVE = 24;
const NUM_BANDS = 240;
const SPECTRUM_SEMIS = (NUM_BANDS / BANDS_PER_OCTAVE) * 12;
const BPM = 120;
const DURATION = 10;

const SPECTROGRAM: AimSpectrogram = {
  numBands: NUM_BANDS,
  bandsPerOctave: BANDS_PER_OCTAVE,
  minFreq: 16.35,
  totalDuration: DURATION,
};

const NO_SNAP: AimSnapping = {
  snapTime: false,
  snapPitch: false,
  gridSizeBeats: 1,
  gridSizeSemis: 12,
  gridSwing: 0,
  scaleTonic: "C",
  scaleType: "major",
  anchorMode: BRUSH_ANCHOR_MODE_CORNER,
};

/** A pointer at the given fraction down the lane, with no pan or zoom. */
function aimFromLaneFraction(fractionFromTop: number, snapping: AimSnapping = NO_SNAP) {
  return resolveAimUv({
    viewUv: new Vector2(0.5, fractionFromTop),
    zoom: new Vector2(0, 0),
    offset: new Vector2(0, 0),
    bpm: BPM,
    spectrogram: SPECTROGRAM,
    snapping,
    onsets: [],
  });
}

describe("vertical coordinate spaces", () => {
  it("reads the top of the lane as the highest pitch", () => {
    expect(aimFromLaneFraction(0).y).toBeCloseTo(1, 10);
    expect(aimFromLaneFraction(1).y).toBeCloseTo(0, 10);
    expect(aimFromLaneFraction(0.25).y).toBeCloseTo(0.75, 10);
  });

  it("keeps the flip out of pitch snapping", () => {
    // A quarter of the way down is 90 semitones up; the 12-semitone grid floors
    // it to 84, which is where the brush's bottom edge belongs.
    const snapped = aimFromLaneFraction(0.25, { ...NO_SNAP, snapPitch: true });
    const [, semis] = uvToUnits(0, snapped.y, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS);
    expect(semis).toBeCloseTo(84, 10);
    expect(semis).toBeLessThan(SPECTRUM_SEMIS * 0.75);
  });

  it("round-trips units through pitch UV", () => {
    const uv = unitsToUv(3, 42, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS);
    const [beats, semis] = uvToUnits(uv.x, uv.y, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS);
    expect(beats).toBeCloseTo(3, 10);
    expect(semis).toBeCloseTo(42, 10);
  });

  it("turns a pointer position into the pitch the cursor reports", () => {
    const aim = aimFromLaneFraction(0.25);
    const [, semis] = uvToUnits(aim.x, aim.y, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS);
    expect(semis).toBeCloseTo(SPECTRUM_SEMIS * 0.75, 10);
  });

  it("counts band indices downward in pitch", () => {
    expect(bandIndexToPitchUv(0, NUM_BANDS)).toBeCloseTo(1, 10);
    expect(bandIndexToPitchUv(NUM_BANDS, NUM_BANDS)).toBeCloseTo(0, 10);
    expect(pitchUvToBandIndex(unitsToUv(0, 0, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS).y, NUM_BANDS)).toBeCloseTo(
      NUM_BANDS,
      10,
    );
    expect(
      pitchUvToBandIndex(unitsToUv(0, SPECTRUM_SEMIS, BPM, DURATION, BANDS_PER_OCTAVE, NUM_BANDS).y, NUM_BANDS),
    ).toBeCloseTo(0, 10);
  });
});
