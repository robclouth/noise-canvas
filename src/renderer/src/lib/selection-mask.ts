import type { SpectrogramData } from "../store/types";
import {
  maskFromRows,
  maskRow,
  maskRowRuns,
  selectionBandRange,
  selectionFrameRange,
  type Selection,
  type SelectionMask,
} from "./selection";
import { bandIndexToPitchUv } from "./utils";

/** One vertex of a freehand path, in the file's seconds and pitch UV. */
export type LassoPoint = { time: number; pitchUv: number };

/**
 * The selection a closed freehand path describes: its bounding rectangle, and
 * a mask holding the path's interior by the even-odd rule. Each mask row is
 * filled on the scanline through its band's pitch centre. Null when the path
 * encloses nothing.
 */
export function lassoSelection(points: LassoPoint[], spec: SpectrogramData): Selection | null {
  if (points.length < 3) return null;
  const totalDuration = spec.numFrames / spec.sampleRate;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let pitchLo = Number.POSITIVE_INFINITY;
  let pitchHi = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    start = Math.min(start, p.time);
    end = Math.max(end, p.time);
    pitchLo = Math.min(pitchLo, p.pitchUv);
    pitchHi = Math.max(pitchHi, p.pitchUv);
  }
  start = Math.max(0, start);
  end = Math.min(totalDuration, end);
  pitchLo = Math.max(0, pitchLo);
  pitchHi = Math.min(1, pitchHi);
  if (end <= start || pitchHi <= pitchLo) return null;

  const box: Selection = { start, end, pitchLo, pitchHi };
  const { startFrame, endFrame } = selectionFrameRange(box, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(box, spec.numBands);
  if (endFrame <= startFrame || highBand < lowBand) return null;

  const rows = highBand - lowBand + 1;
  const span = end - start;
  const rowRuns: number[][] = [];
  for (let row = 0; row < rows; row++) {
    // The scanline runs through the band's pitch centre.
    const y = bandIndexToPitchUv(lowBand + row + 0.5, spec.numBands);
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.pitchUv === b.pitchUv) continue;
      if (y < Math.min(a.pitchUv, b.pitchUv) || y >= Math.max(a.pitchUv, b.pitchUv)) continue;
      crossings.push(a.time + ((y - a.pitchUv) / (b.pitchUv - a.pitchUv)) * (b.time - a.time));
    }
    crossings.sort((p, q) => p - q);
    const runs: number[] = [];
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const from = Math.max(0, (crossings[c] - start) / span);
      const to = Math.min(1, (crossings[c + 1] - start) / span);
      if (to > from) runs.push(from, to);
    }
    rowRuns.push(runs);
  }

  // An edge band whose centre scanline missed the path leaves an empty row;
  // trimming it pins the pitch bounds to band edges, so the box hugs the shape
  // and the band range round-trips exactly.
  let firstRow = 0;
  while (firstRow < rows && rowRuns[firstRow].length === 0) firstRow++;
  if (firstRow === rows) return null;
  let lastRow = rows - 1;
  while (lastRow > firstRow && rowRuns[lastRow].length === 0) lastRow--;
  return {
    ...box,
    pitchHi: bandIndexToPitchUv(lowBand + firstRow, spec.numBands),
    pitchLo: bandIndexToPitchUv(lowBand + lastRow + 1, spec.numBands),
    mask: maskFromRows(rowRuns.slice(firstRow, lastRow + 1)),
  };
}

// True when `outer` is a plain rectangle that covers all of `inner`.
function rectContains(outer: Selection, inner: Selection): boolean {
  return (
    !outer.mask &&
    outer.start <= inner.start &&
    outer.end >= inner.end &&
    outer.pitchLo <= inner.pitchLo &&
    outer.pitchHi >= inner.pitchHi
  );
}

/**
 * The runs of `band` a selection holds, as fraction pairs of the frame span
 * [boxStart, boxStart + boxSpan): its whole width for a plain rectangle, its
 * mask row's runs for a shape, nothing outside its bands.
 */
function bandRunsWithin(
  part: Selection,
  band: number,
  spec: SpectrogramData,
  boxStart: number,
  boxSpan: number,
): number[] {
  const { lowBand, highBand } = selectionBandRange(part, spec.numBands);
  if (band < lowBand || band > highBand) return [];
  const { startFrame, endFrame } = selectionFrameRange(part, spec.sampleRate);
  const toBox = (frame: number): number => (frame - boxStart) / boxSpan;
  if (!part.mask) return [toBox(startFrame), toBox(endFrame)];
  const span = endFrame - startFrame;
  const runs = maskRowRuns(part.mask, maskRow(part.mask, band, lowBand, highBand));
  const out: number[] = [];
  for (let i = 0; i + 1 < runs.length; i += 2)
    out.push(toBox(startFrame + runs[i] * span), toBox(startFrame + runs[i + 1] * span));
  return out;
}

/**
 * The union of two selections on one file, as one masked selection over their
 * combined bounding rectangle. Each side keeps its own shape: a plain
 * rectangle contributes its whole box, a masked one its mask. When one plain
 * rectangle already covers the other selection, it is returned unchanged.
 */
export function unionSelections(a: Selection, b: Selection, spec: SpectrogramData): Selection {
  if (rectContains(a, b)) return a;
  if (rectContains(b, a)) return b;
  const box: Selection = {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    pitchLo: Math.min(a.pitchLo, b.pitchLo),
    pitchHi: Math.max(a.pitchHi, b.pitchHi),
  };
  const { startFrame, endFrame } = selectionFrameRange(box, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(box, spec.numBands);
  const span = Math.max(1, endFrame - startFrame);
  const rows: number[][] = [];
  for (let band = lowBand; band <= highBand; band++) {
    rows.push([...bandRunsWithin(a, band, spec, startFrame, span), ...bandRunsWithin(b, band, spec, startFrame, span)]);
  }
  return { ...box, mask: maskFromRows(rows) };
}

/** The parts of [0, 1) outside merged, ordered fraction pairs. */
function complementRuns(runs: ArrayLike<number>): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    if (runs[i] > at) out.push(at, Math.min(1, runs[i]));
    at = Math.max(at, runs[i + 1]);
  }
  if (at < 1) out.push(at, 1);
  return out;
}

/** The parts of [0, 1) where exactly one of two merged run lists holds. */
function differingRuns(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const edges: number[] = [];
  for (let i = 0; i < a.length; i++) edges.push(a[i]);
  for (let i = 0; i < b.length; i++) edges.push(b[i]);
  edges.sort((p, q) => p - q);
  const inside = (runs: ArrayLike<number>, x: number): boolean => {
    for (let i = 0; i + 1 < runs.length; i += 2) if (x >= runs[i] && x < runs[i + 1]) return true;
    return false;
  };
  const out: number[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const from = edges[k];
    const to = edges[k + 1];
    if (to <= from) continue;
    const mid = (from + to) / 2;
    if (inside(a, mid) === inside(b, mid)) continue;
    const last = out.length - 2;
    if (last >= 0 && out[last + 1] === from) out[last + 1] = to;
    else out.push(from, to);
  }
  return out;
}

/**
 * The boundary of a mask as horizontal and vertical segments, `[x0, y0, x1,
 * y1, …]` with x as a fraction of the rectangle's width and y in rows.
 * Collinear edges merge into one segment, so a dashed stroke flows along a
 * straight boundary instead of restarting at every row.
 */
export function maskBoundarySegments(mask: SelectionMask): number[] {
  const segments: number[] = [];
  const none = new Float64Array(0);
  // A horizontal edge lies on line y where the rows above and below disagree.
  for (let y = 0; y <= mask.rows; y++) {
    const above = y > 0 ? maskRowRuns(mask, y - 1) : none;
    const below = y < mask.rows ? maskRowRuns(mask, y) : none;
    const edges = differingRuns(above, below);
    for (let i = 0; i + 1 < edges.length; i += 2) segments.push(edges[i], y, edges[i + 1], y);
  }
  // A vertical edge stands at each end of a run, joined down rows that share it.
  const open = new Map<number, number>();
  for (let row = 0; row <= mask.rows; row++) {
    const ends = new Set<number>();
    if (row < mask.rows) {
      const runs = maskRowRuns(mask, row);
      for (const x of runs) ends.add(x);
    }
    for (const [x, from] of [...open]) {
      if (ends.has(x)) continue;
      segments.push(x, from, x, row);
      open.delete(x);
    }
    for (const x of ends) if (!open.has(x)) open.set(x, row);
  }
  return segments;
}

/**
 * Everything the selection leaves out, as one selection over the whole file.
 * A rectangle whose complement is itself a rectangle keeps its exact edges;
 * every other shape comes back as a mask. Null when the selection already
 * covers the whole file.
 */
export function invertSelection(selection: Selection, spec: SpectrogramData): Selection | null {
  const totalDuration = spec.numFrames / spec.sampleRate;
  const whole: Selection = { start: 0, end: totalDuration, pitchLo: 0, pitchHi: 1 };
  if (!selection.mask) {
    const spansTime = selection.start <= 0 && selection.end >= totalDuration;
    const spansPitch = selection.pitchLo <= 0 && selection.pitchHi >= 1;
    if (spansTime && spansPitch) return null;
    if (spansPitch && selection.start <= 0) return { ...whole, start: selection.end };
    if (spansPitch && selection.end >= totalDuration) return { ...whole, end: selection.start };
    if (spansTime && selection.pitchLo <= 0) return { ...whole, pitchLo: selection.pitchHi };
    if (spansTime && selection.pitchHi >= 1) return { ...whole, pitchHi: selection.pitchLo };
  }

  const { startFrame, endFrame } = selectionFrameRange(whole, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(whole, spec.numBands);
  const span = Math.max(1, endFrame - startFrame);
  const rows: number[][] = [];
  let any = false;
  for (let band = lowBand; band <= highBand; band++) {
    const held = maskFromRows([bandRunsWithin(selection, band, spec, startFrame, span)]).runs;
    const outside = complementRuns(held);
    if (outside.length > 0) any = true;
    rows.push(outside);
  }
  if (!any) return null;
  return { ...whole, mask: maskFromRows(rows) };
}
