import type { SpectrogramData } from "../store/types";
import {
  selectionBandRange,
  selectionFrameRange,
  selectionMaskTest,
  type Selection,
  type SelectionMask,
} from "./selection";
import { bandIndexToPitchUv } from "./utils";

/** One vertex of a freehand path, in the file's seconds and pitch UV. */
export type LassoPoint = { time: number; pitchUv: number };

// Mask columns are capped so a whole-file lasso stays a small texture; below
// the cap the grid follows the finest band step inside the box, so the finest
// bins still resolve one cell each.
const MAX_MASK_COLS = 1024;
const MIN_MASK_COLS = 16;

/** The mask column count for a frame span over the given bands. */
export function maskColsFor(
  spec: SpectrogramData,
  startFrame: number,
  endFrame: number,
  lowBand: number,
  highBand: number,
): number {
  let finestStep = Number.POSITIVE_INFINITY;
  for (let band = lowBand; band <= highBand; band++) {
    finestStep = Math.min(finestStep, 1 << spec.synthesisMetadata.bandStepLog2s[band]);
  }
  if (!Number.isFinite(finestStep)) finestStep = 1;
  const cols = Math.ceil((endFrame - startFrame) / finestStep);
  return Math.max(MIN_MASK_COLS, Math.min(MAX_MASK_COLS, cols));
}

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
  const cols = maskColsFor(spec, startFrame, endFrame, lowBand, highBand);
  const cells = new Uint8Array(rows * cols);
  const secondsPerCol = (endFrame - startFrame) / spec.sampleRate / cols;

  let any = false;
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
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      // A cell is inside when its time centre is.
      const from = Math.max(0, Math.ceil((crossings[c] - start) / secondsPerCol - 0.5));
      const to = Math.min(cols - 1, Math.floor((crossings[c + 1] - start) / secondsPerCol - 0.5));
      for (let col = from; col <= to; col++) {
        cells[row * cols + col] = 255;
        any = true;
      }
    }
  }
  if (!any) return null;

  // An edge band whose centre scanline missed the path leaves an empty row;
  // trimming it pins the pitch bounds to band edges, so the box hugs the shape
  // and the band range round-trips exactly.
  let firstRow = 0;
  while (firstRow < rows && cells.subarray(firstRow * cols, (firstRow + 1) * cols).every((c) => c === 0)) firstRow++;
  let lastRow = rows - 1;
  while (lastRow > firstRow && cells.subarray(lastRow * cols, (lastRow + 1) * cols).every((c) => c === 0)) lastRow--;
  const trimmedLow = lowBand + firstRow;
  const trimmedHigh = lowBand + lastRow;
  return {
    ...box,
    pitchHi: bandIndexToPitchUv(trimmedLow, spec.numBands),
    pitchLo: bandIndexToPitchUv(trimmedHigh + 1, spec.numBands),
    mask: {
      cols,
      rows: lastRow - firstRow + 1,
      cells: cells.slice(firstRow * cols, (lastRow + 1) * cols),
    },
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
  const rows = highBand - lowBand + 1;
  const cols = maskColsFor(spec, startFrame, endFrame, lowBand, highBand);
  const cells = new Uint8Array(rows * cols);
  const framesPerCol = (endFrame - startFrame) / cols;

  const parts = [a, b].map((part) => ({
    frames: selectionFrameRange(part, spec.sampleRate),
    bands: selectionBandRange(part, spec.numBands),
    mask: selectionMaskTest(part, spec.sampleRate, spec.numBands),
  }));
  for (let row = 0; row < rows; row++) {
    const band = lowBand + row;
    for (let col = 0; col < cols; col++) {
      // A cell joins when its time centre is inside either side's shape.
      const frame = startFrame + Math.floor((col + 0.5) * framesPerCol);
      const inside = parts.some(
        (part) =>
          band >= part.bands.lowBand &&
          band <= part.bands.highBand &&
          frame >= part.frames.startFrame &&
          frame < part.frames.endFrame &&
          (!part.mask || part.mask(band, frame)),
      );
      if (inside) cells[row * cols + col] = 255;
    }
  }
  return { ...box, mask: { cols, rows, cells } };
}

/**
 * The boundary of a mask as horizontal and vertical cell-edge segments, in
 * cell coordinates: `[x0, y0, x1, y1, …]` with x in columns and y in rows.
 * Collinear edges merge into one segment, so a dashed stroke flows along a
 * straight boundary instead of restarting at every cell.
 */
export function maskBoundarySegments(mask: SelectionMask): number[] {
  const { rows, cols, cells } = mask;
  const inside = (row: number, col: number): boolean =>
    row >= 0 && row < rows && col >= 0 && col < cols && cells[row * cols + col] > 0;
  const segments: number[] = [];
  // A horizontal edge lies on line y where the cells above and below disagree.
  for (let y = 0; y <= rows; y++) {
    let runStart = -1;
    for (let col = 0; col <= cols; col++) {
      const edge = col < cols && inside(y, col) !== inside(y - 1, col);
      if (edge && runStart < 0) runStart = col;
      if (!edge && runStart >= 0) {
        segments.push(runStart, y, col, y);
        runStart = -1;
      }
    }
  }
  for (let x = 0; x <= cols; x++) {
    let runStart = -1;
    for (let row = 0; row <= rows; row++) {
      const edge = row < rows && inside(row, x) !== inside(row, x - 1);
      if (edge && runStart < 0) runStart = row;
      if (!edge && runStart >= 0) {
        segments.push(x, runStart, x, row);
        runStart = -1;
      }
    }
  }
  return segments;
}
