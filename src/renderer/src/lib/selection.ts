import { Vector2 } from "three";
import { pitchUvToBandIndex } from "./utils";

/**
 * A rectangle over one file: a time range in seconds, and a pitch range in
 * pitch UV, which is 0 at the file's lowest band and 1 above its highest.
 */
export type Selection = {
  start: number;
  end: number;
  pitchLo: number;
  pitchHi: number;
};

/** A corner of a selection drag, in the space `resolveSelectionUv` returns. */
export type SelectionCorner = { timeUv: number; pitchUv: number };

/**
 * True when the selection spans every band. Only a full-height selection can
 * ripple, because closing a gap in one band alone would leave the rest of the
 * file behind.
 */
export function isFullHeight(selection: Selection): boolean {
  return selection.pitchLo <= 0 && selection.pitchHi >= 1;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * The rectangle two drag corners describe, ordered and clamped to the file.
 * Returns null when either axis collapses, so a click never leaves a selection
 * of no width behind.
 */
export function normaliseSelection(
  from: SelectionCorner,
  to: SelectionCorner,
  totalDuration: number,
): Selection | null {
  const start = clamp01(Math.min(from.timeUv, to.timeUv)) * totalDuration;
  const end = clamp01(Math.max(from.timeUv, to.timeUv)) * totalDuration;
  const pitchLo = clamp01(Math.min(from.pitchUv, to.pitchUv));
  const pitchHi = clamp01(Math.max(from.pitchUv, to.pitchUv));
  if (end <= start || pitchHi <= pitchLo) return null;
  return { start, end, pitchLo, pitchHi };
}

/** The rectangle a full-height drag over `start`–`end` seconds describes. */
export function fullHeightSelection(start: number, end: number): Selection | null {
  if (end <= start) return null;
  return { start, end, pitchLo: 0, pitchHi: 1 };
}

/**
 * The bands a selection covers, as an inclusive `[lowBand, highBand]` pair.
 * Band indices count down in frequency, so the selection's low pitch edge is
 * the highest index. A band whose span overlaps the selection at all is inside
 * it: a band is the smallest thing that can be painted, so the rounding goes
 * outwards.
 */
export function selectionBandRange(selection: Selection, numBands: number): { lowBand: number; highBand: number } {
  const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(selection.pitchHi, numBands)));
  const highBand = Math.min(numBands - 1, Math.ceil(pitchUvToBandIndex(selection.pitchLo, numBands)) - 1);
  return { lowBand, highBand: Math.max(lowBand, highBand) };
}

/**
 * The frames a selection spans, rounded the way the brush rounds its own time
 * edges, so a selection edge and a brush edge landing on the same frame claim
 * the same bins.
 */
export function selectionFrameRange(
  selection: Selection,
  sampleRate: number,
): { startFrame: number; endFrame: number } {
  return {
    startFrame: Math.floor(selection.start * sampleRate + 0.5),
    endFrame: Math.floor(selection.end * sampleRate + 0.5),
  };
}

/** The selection as a bottom-left origin and size in UV, for clipping the brush's extent. */
export function selectionUvRect(selection: Selection, totalDuration: number): { anchor: Vector2; size: Vector2 } {
  const start = selection.start / totalDuration;
  const end = selection.end / totalDuration;
  return {
    anchor: new Vector2(start, selection.pitchLo),
    size: new Vector2(end - start, selection.pitchHi - selection.pitchLo),
  };
}
