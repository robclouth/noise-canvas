import { pitchUvToBandIndex } from "./utils";

/**
 * An arbitrary-shape membership grid over a selection's bounding rectangle.
 * Row-major `rows × cols`, row 0 at the highest-pitch band, column 0 at the
 * time start; a cell holds 255 inside the shape and 0 outside. Cells are
 * looked up proportionally within the bounding rectangle, so a mask keeps its
 * shape through a translation or a drop into another file's layout.
 */
export type SelectionMask = {
  cols: number;
  rows: number;
  cells: Uint8Array;
};

/**
 * A region over one file: a time range in seconds, and a pitch range in pitch
 * UV, which is 0 at the file's lowest band and 1 above its highest. With a
 * mask the rectangle is the shape's bounding box; without one it is the shape.
 */
export type Selection = {
  start: number;
  end: number;
  pitchLo: number;
  pitchHi: number;
  mask?: SelectionMask;
};

/** A corner of a selection drag, in the space `resolveSelectionUv` returns. */
export type SelectionCorner = { timeUv: number; pitchUv: number };

/**
 * True when the selection spans every band. Only a full-height selection can
 * ripple, because closing a gap in one band alone would leave the rest of the
 * file behind.
 */
export function isFullHeight(selection: Selection): boolean {
  return !selection.mask && selection.pitchLo <= 0 && selection.pitchHi >= 1;
}

/**
 * The mask cell a band and time fall in, by the same proportional lookup the
 * shader uses: the row from the band's position in the inclusive band pair,
 * the column from the frame's position in the frame range.
 */
export function maskCell(
  mask: SelectionMask,
  band: number,
  lowBand: number,
  highBand: number,
  frame: number,
  startFrame: number,
  endFrame: number,
): boolean {
  const rowFrac = (band - lowBand + 0.5) / (highBand - lowBand + 1);
  const colFrac = (frame - startFrame) / Math.max(1, endFrame - startFrame);
  const row = Math.min(mask.rows - 1, Math.max(0, Math.floor(rowFrac * mask.rows)));
  const col = Math.min(mask.cols - 1, Math.max(0, Math.floor(colFrac * mask.cols)));
  return mask.cells[row * mask.cols + col] > 0;
}

/**
 * A per-bin membership test for the selection's shape, or null when the
 * selection is a plain rectangle and the caller's own range checks already
 * decide membership. The test takes a band index and a bin's left-edge frame.
 */
export function selectionMaskTest(
  selection: Selection,
  sampleRate: number,
  numBands: number,
): ((band: number, edgeFrame: number) => boolean) | null {
  const mask = selection.mask;
  if (!mask) return null;
  const { startFrame, endFrame } = selectionFrameRange(selection, sampleRate);
  const { lowBand, highBand } = selectionBandRange(selection, numBands);
  return (band, edgeFrame) => maskCell(mask, band, lowBand, highBand, edgeFrame, startFrame, endFrame);
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
