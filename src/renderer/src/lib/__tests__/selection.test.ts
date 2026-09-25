import { resolveAimUv, resolveSelectionUv, type AimSnapping, type AimSpectrogram } from "@renderer/lib/aim";
import { BRUSH_ANCHOR_MODE_CENTER, BRUSH_ANCHOR_MODE_CORNER } from "@renderer/lib/constants";
import {
  fullHeightSelection,
  isFullHeight,
  normaliseSelection,
  selectionBandRange,
  selectionFrameRange,
  type SelectionCorner,
} from "@renderer/lib/selection";
import { Vector2 } from "three";
import { describe, expect, it } from "vitest";

const BANDS_PER_OCTAVE = 24;
const NUM_BANDS = 240;
const BPM = 120;
const DURATION = 10;

const SPECTROGRAM: AimSpectrogram = {
  numBands: NUM_BANDS,
  bandsPerOctave: BANDS_PER_OCTAVE,
  minFreq: 16.35,
  totalDuration: DURATION,
};

// One beat is half a second at 120 BPM, so the time grid falls every 0.05 of
// the 10-second file. 12 semitones over 120 semitones of range puts the pitch
// grid every 0.1 of the height.
const SNAP: AimSnapping = {
  snapTime: true,
  snapPitch: true,
  gridSizeBeats: 1,
  gridSizeSemis: 12,
  gridSwing: 0,
  scaleTonic: "C",
  scaleType: "major",
  anchorMode: BRUSH_ANCHOR_MODE_CORNER,
};

const corner = (timeUv: number, pitchUv: number): SelectionCorner => ({ timeUv, pitchUv });

function resolveAt(viewUv: Vector2, snapping: AimSnapping = SNAP) {
  return {
    viewUv,
    zoom: new Vector2(0, 0),
    offset: new Vector2(0, 0),
    bpm: BPM,
    spectrogram: SPECTROGRAM,
    snapping,
    onsets: [],
  };
}

describe("normaliseSelection", () => {
  it("orders the corners of a drag made in any direction", () => {
    const downRight = normaliseSelection(corner(0.2, 0.3), corner(0.6, 0.8), DURATION);
    const upLeft = normaliseSelection(corner(0.6, 0.8), corner(0.2, 0.3), DURATION);
    expect(downRight).toEqual({ start: 2, end: 6, pitchLo: 0.3, pitchHi: 0.8 });
    expect(upLeft).toEqual(downRight);
  });

  it("clamps a drag that runs off the file", () => {
    const selection = normaliseSelection(corner(-0.5, -0.2), corner(1.5, 1.4), DURATION);
    expect(selection).toEqual({ start: 0, end: DURATION, pitchLo: 0, pitchHi: 1 });
  });

  it("returns null when either axis collapses", () => {
    expect(normaliseSelection(corner(0.4, 0.2), corner(0.4, 0.8), DURATION)).toBeNull();
    expect(normaliseSelection(corner(0.2, 0.5), corner(0.8, 0.5), DURATION)).toBeNull();
  });
});

describe("isFullHeight", () => {
  it("is true only for a selection that spans every band", () => {
    expect(isFullHeight({ start: 0, end: 1, pitchLo: 0, pitchHi: 1 })).toBe(true);
    expect(isFullHeight({ start: 0, end: 1, pitchLo: 0, pitchHi: 0.99 })).toBe(false);
    expect(isFullHeight({ start: 0, end: 1, pitchLo: 0.01, pitchHi: 1 })).toBe(false);
  });

  it("is true for the rectangle a time-legend drag makes", () => {
    const selection = fullHeightSelection(1, 3);
    expect(selection).not.toBeNull();
    expect(isFullHeight(selection!)).toBe(true);
  });

  it("makes no rectangle from a legend click", () => {
    expect(fullHeightSelection(2, 2)).toBeNull();
  });
});

describe("selectionBandRange", () => {
  it("rounds outwards, so a partly covered band stays inside the range", () => {
    // Band indices count down in frequency: pitch 0.399 is the low index.
    const range = selectionBandRange({ start: 0, end: 1, pitchLo: 0.101, pitchHi: 0.399 }, NUM_BANDS);
    expect(range).toEqual({ lowBand: 144, highBand: 215 });
  });

  it("covers every band at full height", () => {
    expect(selectionBandRange({ start: 0, end: 1, pitchLo: 0, pitchHi: 1 }, NUM_BANDS)).toEqual({
      lowBand: 0,
      highBand: NUM_BANDS - 1,
    });
  });

  it("agrees with the band index the shader derives from the same pitch UV", () => {
    const selection = { start: 0, end: 1, pitchLo: 0.101, pitchHi: 0.399 };
    const { lowBand, highBand } = selectionBandRange(selection, NUM_BANDS);
    const shaderBand = (pitchUv: number) => Math.floor((1 - pitchUv) * NUM_BANDS);
    expect(shaderBand(selection.pitchHi)).toBe(lowBand);
    expect(shaderBand(selection.pitchLo)).toBeLessThanOrEqual(highBand);
    expect(shaderBand(selection.pitchLo + 1e-9)).toBeLessThanOrEqual(highBand);
    // The band just below the selection's low edge is outside it.
    expect(shaderBand(selection.pitchLo - 2 / NUM_BANDS)).toBeGreaterThan(highBand);
  });

  it("keeps one band for a rectangle thinner than one", () => {
    const range = selectionBandRange({ start: 0, end: 1, pitchLo: 0.5, pitchHi: 0.5 }, NUM_BANDS);
    expect(range).toEqual({ lowBand: 120, highBand: 120 });
  });
});

describe("selectionFrameRange", () => {
  it("rounds the edges to frames the way the brush rounds its own", () => {
    const sampleRate = 48000;
    const selection = { start: 0.5, end: 1.25, pitchLo: 0, pitchHi: 1 };
    expect(selectionFrameRange(selection, sampleRate)).toEqual({ startFrame: 24000, endFrame: 60000 });
  });
});

describe("resolveSelectionUv", () => {
  it("snaps an edge to the nearest grid line, where the brush would snap into the cell", () => {
    // 0.08 along the file is 0.8 s, past the midpoint of its half-second cell.
    const params = resolveAt(new Vector2(0.08, 0.5));
    expect(resolveSelectionUv(params).x).toBeCloseTo(0.1, 6);
    expect(resolveAimUv(params).x).toBeCloseTo(0.05, 6);
  });

  it("snaps the pitch edge to the nearest grid line", () => {
    // Pitch UV is y-up, so 0.44 down the lane is 0.56 up it, nearest 0.6.
    expect(resolveSelectionUv(resolveAt(new Vector2(0.5, 0.44))).y).toBeCloseTo(0.6, 6);
  });

  it("leaves the brush's centre and corner snapping alone", () => {
    const params = resolveAt(new Vector2(0.08, 0.5));
    const centre = resolveAt(new Vector2(0.08, 0.5), { ...SNAP, anchorMode: BRUSH_ANCHOR_MODE_CENTER });
    expect(resolveAimUv(params).x).toBeCloseTo(0.05, 6);
    expect(resolveAimUv(centre).x).toBeCloseTo(0.075, 6);
  });
});
