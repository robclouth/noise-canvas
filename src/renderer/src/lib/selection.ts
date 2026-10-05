import { pitchUvToBandIndex } from "./utils";

/**
 * An arbitrary shape over a selection's bounding rectangle: for each of `rows`
 * bands, row 0 at the highest-pitch band, the runs of time inside the shape as
 * fractions [from, to) of the rectangle's span, in order and apart. Row r's
 * runs are pairs rowStarts[r] to rowStarts[r + 1] of `runs`. Rows spread
 * proportionally over the rectangle's bands and runs over its time, so a mask
 * keeps its shape through a translation or a drop into another file's layout,
 * and resolves to a frame however long the rectangle.
 */
export type SelectionMask = {
  rows: number;
  rowStarts: Uint32Array;
  runs: Float64Array;
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

/** A mask from each row's runs, [from, to) fraction pairs, merged where they overlap or touch. */
export function maskFromRows(rows: readonly (readonly number[])[]): SelectionMask {
  const rowStarts = new Uint32Array(rows.length + 1);
  const runs: number[] = [];
  rows.forEach((row, r) => {
    rowStarts[r] = runs.length / 2;
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < row.length; i += 2) if (row[i + 1] > row[i]) pairs.push([row[i], row[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [from, to] of pairs) {
      const last = runs.length - 2;
      if (last >= rowStarts[r] * 2 && from <= runs[last + 1]) runs[last + 1] = Math.max(runs[last + 1], to);
      else runs.push(from, to);
    }
  });
  rowStarts[rows.length] = runs.length / 2;
  return { rows: rows.length, rowStarts, runs: Float64Array.from(runs) };
}

/** A mask from a row-major grid of `rows × cols` cells, nonzero inside. */
export function maskFromCells(cols: number, rows: number, cells: ArrayLike<number>): SelectionMask {
  const out: number[][] = [];
  for (let row = 0; row < rows; row++) {
    const runs: number[] = [];
    for (let col = 0; col < cols; col++) if (cells[row * cols + col] > 0) runs.push(col / cols, (col + 1) / cols);
    out.push(runs);
  }
  return maskFromRows(out);
}

/** Row `row`'s runs, as fraction pairs in order. */
export function maskRowRuns(mask: SelectionMask, row: number): Float64Array {
  return mask.runs.subarray(mask.rowStarts[row] * 2, mask.rowStarts[row + 1] * 2);
}

/** The mask row a band falls in: rows spread over the inclusive band pair by the band's centre. */
export function maskRow(mask: SelectionMask, band: number, lowBand: number, highBand: number): number {
  const rowFrac = (band - lowBand + 0.5) / (highBand - lowBand + 1);
  return Math.min(mask.rows - 1, Math.max(0, Math.floor(rowFrac * mask.rows)));
}

/**
 * Every run as whole frames from the rectangle's start, over a span of
 * `spanFrames`: the shader's copy and the CPU's test round them alike.
 */
export function maskFrameRuns(mask: SelectionMask, spanFrames: number): Uint32Array {
  const frames = new Uint32Array(mask.runs.length);
  for (let i = 0; i < mask.runs.length; i++) frames[i] = Math.floor(mask.runs[i] * spanFrames + 0.5);
  return frames;
}

/**
 * A per-bin membership test for the selection's shape, or null when the
 * selection is a plain rectangle and the caller's own range checks already
 * decide membership. The test takes a band index and a bin's left-edge frame,
 * which is inside when it falls in one of its row's runs.
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
  const frames = maskFrameRuns(mask, Math.max(1, endFrame - startFrame));
  return (band, edgeFrame) => {
    const row = maskRow(mask, band, lowBand, highBand);
    const at = edgeFrame - startFrame;
    let lo = mask.rowStarts[row];
    let hi = mask.rowStarts[row + 1];
    if (hi <= lo || at < 0) return false;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid * 2] <= at) lo = mid;
      else hi = mid;
    }
    return at >= frames[lo * 2] && at < frames[lo * 2 + 1];
  };
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
