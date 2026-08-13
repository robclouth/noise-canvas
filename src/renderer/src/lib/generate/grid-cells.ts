import { isOnsetGrid } from "@renderer/lib/constants";
import type { Onset } from "@renderer/lib/onset-map";
import { buildScaleOffsets, minFreqSemisAboveC0, snapSemisToScale, stepScaleSemis } from "@renderer/lib/scale-snap";
import { stepSwungGrid } from "@renderer/lib/utils";

/** One cell of the fill grid, in the axis's own units. */
export interface GridCell {
  /** Low edge: seconds on time, semitones above the file's lowest band on pitch. */
  start: number;
  /** Distance to the next cell's low edge. */
  size: number;
}

/** The span a fill covers on one axis, in that axis's units. */
export interface CellRange {
  min: number;
  max: number;
}

export interface TimeCellParams {
  gridSizeBeats: number;
  gridSwing: number;
  snapTime: boolean;
  bpm: number;
  onsets: readonly Onset[];
}

export interface PitchCellParams {
  gridSizeSemis: number;
  snapPitch: boolean;
  scaleTonic: string;
  scaleType: string;
  /** Lowest analysed frequency, which fixes the pitch class of the bottom of the range. */
  minFreq: number;
}

/** Cells past this many on one axis mean the grid is too fine to fill. */
export const MAX_CELLS_PER_AXIS = 4096;

// A file's lowest band reaches the scale through a log, so a note sitting on it
// can come back a fraction of a cent below the range. Treat that as inside, or
// the fill loses its bottom row.
const SCALE_EPSILON_SEMIS = 1e-6;

/** A single cell spanning the range, for an axis whose snapping is off. */
function wholeRange(range: CellRange): GridCell[] {
  const size = range.max - range.min;
  return size > 0 ? [{ start: range.min, size }] : [];
}

/** The onsets inside the range, each owning the span up to the next one. */
function onsetCells(range: CellRange, onsets: readonly Onset[]): GridCell[] {
  const inside = onsets.filter((onset) => onset.timeSec >= range.min && onset.timeSec < range.max);
  if (inside.length === 0) return [];

  return inside.map((onset, index) => ({
    start: onset.timeSec,
    size: (index + 1 < inside.length ? inside[index + 1].timeSec : range.max) - onset.timeSec,
  }));
}

/**
 * The time cells a fill covers, in seconds. Snapping off collapses the range to
 * one cell. Swing alternates cell widths, so each cell carries its own.
 */
export function resolveTimeCells(range: CellRange, params: TimeCellParams): GridCell[] {
  if (!params.snapTime) return wholeRange(range);
  if (isOnsetGrid(params.gridSizeBeats)) return onsetCells(range, params.onsets);

  const interval = (60 / params.bpm) * params.gridSizeBeats;
  if (!(interval > 0)) return wholeRange(range);

  const swing = params.gridSwing / 100;
  const cells: GridCell[] = [];
  // Step back off the range's low edge so a line sitting exactly on it is found.
  let start = stepSwungGrid(range.min, interval, swing, -1);

  while (start < range.max && cells.length <= MAX_CELLS_PER_AXIS) {
    const next = stepSwungGrid(start, interval, swing, 1);
    if (!(next > start)) break;
    if (next > range.min) cells.push({ start, size: next - start });
    start = next;
  }
  return cells;
}

/**
 * The pitch cells a fill covers, in semitones above the file's lowest band.
 * Scale mode walks the selected scale's notes, which are positions rather than
 * cells, so each takes the gap up to the next note.
 */
export function resolvePitchCells(range: CellRange, params: PitchCellParams): GridCell[] {
  if (!params.snapPitch) return wholeRange(range);

  const cells: GridCell[] = [];

  if (params.gridSizeSemis > 0) {
    const interval = params.gridSizeSemis;
    let start = Math.floor(range.min / interval) * interval;
    while (start < range.max && cells.length <= MAX_CELLS_PER_AXIS) {
      if (start + interval > range.min) cells.push({ start, size: interval });
      start += interval;
    }
    return cells;
  }

  // Scale mode. Snapping works in semitones above C0 so pitch classes line up,
  // then the notes come back into the file's own bottom-relative measure.
  const offsets = buildScaleOffsets(params.scaleTonic, params.scaleType);
  const bottomAbs = minFreqSemisAboveC0(params.minFreq);
  const lowAbs = bottomAbs + range.min;
  let noteAbs = snapSemisToScale(lowAbs, offsets);
  if (noteAbs < lowAbs - SCALE_EPSILON_SEMIS) noteAbs = stepScaleSemis(noteAbs, 1, offsets);

  while (noteAbs - bottomAbs < range.max && cells.length <= MAX_CELLS_PER_AXIS) {
    const nextAbs = stepScaleSemis(noteAbs, 1, offsets);
    if (!(nextAbs > noteAbs)) break;
    cells.push({ start: noteAbs - bottomAbs, size: nextAbs - noteAbs });
    noteAbs = nextAbs;
  }
  return cells;
}
