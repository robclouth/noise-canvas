import { Vector2 } from "three";
import { isOnsetGrid } from "./constants";
import type { Onset } from "./onset-map";

// Special sentinel values on the brush size sliders:
//   value === 0          → "Grid" mode (track the current time/pitch grid)
//   value >= *_FULL_*    → "Full" mode (brush spans the entire file on this axis)
export const BRUSH_SIZE_TIME_FULL = 32;
export const BRUSH_SIZE_PITCH_FULL = 128;

// Fallback grid interval in semis when the pitch grid is set to "Scale" mode
// (gridSizeSemis <= 0) but a control is linked to Grid.
const PITCH_GRID_SCALE_FALLBACK_SEMIS = 12;

// Fallback grid interval in beats when the time grid is set to "Onsets" but a
// control is linked to Grid. Onset spans are measured per hit, so this only
// applies where there is no hit to measure — time snap off, or a file with no
// detected onsets — and the sentinel's own value (a 128th of a beat) would
// otherwise leave a brush too small to paint with.
const TIME_GRID_ONSET_FALLBACK_BEATS = 1;

/** Width of one time-grid cell in beats, resolving the Onsets grid to a fixed span. */
export function gridCellBeats(gridSizeBeats: number): number {
  return isOnsetGrid(gridSizeBeats) ? TIME_GRID_ONSET_FALLBACK_BEATS : gridSizeBeats;
}

/** Height of one pitch-grid cell in semitones, resolving the Scale grid to a fixed span. */
export function gridCellSemis(gridSizeSemis: number): number {
  return gridSizeSemis > 0 ? gridSizeSemis : PITCH_GRID_SCALE_FALLBACK_SEMIS;
}

// The anchor round-trips through UV, so a value on an onset can come back a
// hair below it. Nudge forward by a microsecond so it resolves to that onset's
// span rather than the one before.
const GRID_CELL_EPSILON_SEC = 1e-6;

export interface ResolvedBrushFootprint {
  sizeUv: Vector2;
  fullTime: boolean;
  fullPitch: boolean;
}

export function resolveBrushFootprint(params: {
  brushSizeTime: number;
  brushSizePitch: number;
  gridSizeBeats: number;
  gridSizeSemis: number;
  bpm: number;
  totalDuration: number;
  bandsPerOctave: number;
  numBands: number;
}): ResolvedBrushFootprint {
  const { brushSizeTime, brushSizePitch, gridSizeBeats, gridSizeSemis, bpm, totalDuration, bandsPerOctave, numBands } =
    params;

  const fullTime = brushSizeTime >= BRUSH_SIZE_TIME_FULL;
  const fullPitch = brushSizePitch >= BRUSH_SIZE_PITCH_FULL;
  const gridTime = brushSizeTime <= 0;
  const gridPitch = brushSizePitch <= 0;

  const timeBeats = gridTime ? gridCellBeats(gridSizeBeats) : brushSizeTime;
  const pitchSemis = gridPitch ? gridCellSemis(gridSizeSemis) : brushSizePitch;

  const timeUv = fullTime ? 1 : unitsToUv(timeBeats, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
  const pitchUv = fullPitch ? 1 : unitsToUv(0, pitchSemis, bpm, totalDuration, bandsPerOctave, numBands).y;

  return { sizeUv: new Vector2(timeUv, pitchUv), fullTime, fullPitch };
}

// When a brush axis is in Full mode, the brush anchors to 0 on that axis so it always
// spans the whole file regardless of cursor position.
export function resolveBrushAnchor(cursorPos: Vector2, fullTime: boolean, fullPitch: boolean): Vector2 {
  if (!fullTime && !fullPitch) return cursorPos;
  return new Vector2(fullTime ? 0 : cursorPos.x, fullPitch ? 0 : cursorPos.y);
}

// Three vertical coordinate spaces meet in this app:
//
//   view UV     the DOM's y-down fraction of a file lane: 0 at the top of the
//               view (highest frequency), 1 at the bottom (lowest). Pointer
//               events, pan/zoom offsets and the legends work in it.
//   pitch UV    the y-up space every shader works in: 0 at the file's lowest
//               band, 1 above its highest. unitsToUv/uvToUnits convert to and
//               from it, and brushBottomLeftUv is expressed in it.
//   band index  a row of the packed spectrogram: 0 is the highest band and the
//               index counts downward in frequency.
//
// Pointer input crosses from view UV into pitch UV exactly once, in
// lib/aim.ts; nothing downstream of that flips again.
export function viewUvYToPitchUv(viewY: number): number {
  return 1 - viewY;
}

export function pitchUvToViewUvY(pitchY: number): number {
  return 1 - pitchY;
}

export function pitchUvToBandIndex(pitchY: number, numBands: number): number {
  return (1 - pitchY) * numBands;
}

export function bandIndexToPitchUv(bandIndex: number, numBands: number): number {
  return 1 - bandIndex / numBands;
}

export function unitsToUv(
  beats: number,
  semitones: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): Vector2 {
  // Convert musical units to normalized UV offsets without imposing a floor at 0.
  // This allows both positive and negative offsets, and zero maps to zero offset.
  const safeTotalDuration = totalDuration > 0 ? totalDuration : 1.0;
  const u = (beats * (60.0 / bpm)) / safeTotalDuration;

  const bandsPerSemitone = bandsPerOctave / 12;
  const safeNumBands = numBands > 0 ? numBands : 1.0;
  const v = (semitones * bandsPerSemitone) / safeNumBands;

  return new Vector2(u, v);
}

/**
 * Slope of the frequency-preserving dest→source band-UV map (the shader's
 * destToSourceBandUv): how far the source read moves, in source UV, per unit
 * of dest UV. Equals the plain band-count ratio only when both files share a
 * bands-per-octave setting — offsets that compensate cursor movement (Fixed
 * and Anchored source tracking) must use this slope, not the count ratio.
 */
export function sourceBandUvSlope(
  dest: { numBands: number; bandsPerOctave: number },
  source: { numBands: number; bandsPerOctave: number },
): number {
  const safeDestBpo = dest.bandsPerOctave > 0 ? dest.bandsPerOctave : 1;
  const safeSourceBands = source.numBands > 0 ? source.numBands : 1;
  return (dest.numBands * source.bandsPerOctave) / (safeDestBpo * safeSourceBands);
}

/**
 * CPU mirror of the shader's destToSourceBandUv: the source band-UV that holds
 * the same frequency as a dest band-UV. Anchored on each file's configured
 * minFreq, which can sit up to half a band from gaborator's snapped tuning, so
 * it serves display geometry, not sample-exact reads.
 */
export function destToSourceBandUv(
  destUvY: number,
  dest: { numBands: number; bandsPerOctave: number; minFreq: number },
  source: { numBands: number; bandsPerOctave: number; minFreq: number },
): number {
  const safeDestBpo = dest.bandsPerOctave > 0 ? dest.bandsPerOctave : 1;
  const destIdx = destUvY * dest.numBands - 0.5;
  const destFreq = dest.minFreq * Math.pow(2, destIdx / safeDestBpo);
  const safeSourceMin = source.minFreq > 0 ? source.minFreq : 1e-6;
  const srcIdx = source.bandsPerOctave * Math.log2(Math.max(destFreq, 1e-6) / safeSourceMin);
  return (srcIdx + 0.5) / (source.numBands > 0 ? source.numBands : 1);
}

export function uvToUnits(
  u: number,
  v: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
) {
  const seconds = u * totalDuration;
  const beats = seconds / (60.0 / bpm);

  const bandsPerSemitone = bandsPerOctave / 12;
  const semitones = (v * numBands) / bandsPerSemitone;

  return [beats, semitones];
}

type Axis = number | Vector2;

function axisToVec(value: Axis): Vector2 {
  return typeof value === "number" ? new Vector2(value, 0) : value;
}

export const screenToZoomed = (screenUv: Vector2, viewZoomPower: Axis, viewOffset: Axis): Vector2 => {
  const zp = axisToVec(viewZoomPower);
  const of = axisToVec(viewOffset);
  const zx = Math.pow(2, zp.x);
  const zy = Math.pow(2, zp.y);
  const vwX = 1.0 / zx;
  const vwY = 1.0 / zy;
  const vsX = zx > 1 ? of.x * (1.0 - vwX) : 0;
  const vsY = zy > 1 ? of.y * (1.0 - vwY) : 0;
  const x = zx > 1 ? vsX + screenUv.x * vwX : screenUv.x;
  const y = zy > 1 ? vsY + screenUv.y * vwY : screenUv.y;
  return new Vector2(x, y);
};

export const zoomedToScreen = (zoomedUv: Vector2, viewZoomPower: Axis, viewOffset: Axis): Vector2 => {
  const zp = axisToVec(viewZoomPower);
  const of = axisToVec(viewOffset);
  const zx = Math.pow(2, zp.x);
  const zy = Math.pow(2, zp.y);
  const vwX = 1.0 / zx;
  const vwY = 1.0 / zy;
  const vsX = zx > 1 ? of.x * (1.0 - vwX) : 0;
  const vsY = zy > 1 ? of.y * (1.0 - vwY) : 0;
  const x = zx > 1 ? (zoomedUv.x - vsX) / vwX : zoomedUv.x;
  const y = zy > 1 ? (zoomedUv.y - vsY) / vwY : zoomedUv.y;
  return new Vector2(x, y);
};

// Snap a value to the start of a swung grid cell. Even-indexed cell starts lie at
// multiples of gridSize; odd-indexed starts are delayed by `swing * gridSize * 0.5`.
// swing ∈ [0, 1] — 0 is straight, ~0.667 gives a triplet feel, 1 shifts odd lines by half a cell.
export function snapToSwungGridFloor(value: number, gridSize: number, swing: number): number {
  if (gridSize <= 0) return value;
  const swingOffset = swing * gridSize * 0.5;
  const pairSize = gridSize * 2;
  const pairIndex = Math.floor(value / pairSize);
  const pairStart = pairIndex * pairSize;
  const inPair = value - pairStart;
  if (inPair < gridSize + swingOffset) {
    return pairStart;
  }
  return pairStart + gridSize + swingOffset;
}

// Return the next swung grid line in `direction` from `value`. Accepts any
// `value` — if it lies between grid lines, the nearest line in the given
// direction is returned; if it is on a grid line, the adjacent line is returned.
export function stepSwungGrid(value: number, gridSize: number, swing: number, direction: 1 | -1): number {
  if (gridSize <= 0) return value + direction * gridSize;
  const swingOffset = swing * gridSize * 0.5;
  const pairSize = gridSize * 2;
  // Tolerance for treating a near-grid value as exactly on the grid.
  const eps = gridSize * 1e-6;

  if (direction === 1) {
    const pairIndex = Math.floor((value + eps) / pairSize);
    const pairStart = pairIndex * pairSize;
    const oddLine = pairStart + gridSize + swingOffset;
    if (value < oddLine - eps) return oddLine;
    if (value < pairStart + pairSize - eps) return pairStart + pairSize;
    return pairStart + pairSize + gridSize + swingOffset;
  }

  const pairIndex = Math.floor((value - eps) / pairSize);
  const pairStart = pairIndex * pairSize;
  const oddLine = pairStart + gridSize + swingOffset;
  if (value > oddLine + eps) return oddLine;
  if (value > pairStart + eps) return pairStart;
  return pairStart - pairSize + gridSize + swingOffset;
}

// Snaps to the nearest cell midpoint. Brush anchor = center uses this so the
// brush's visual center sits in the middle of a grid cell rather than on a
// grid line. With swing, cell widths alternate but midpoints stay gridSize
// apart.
export function snapToSwungGridCenter(value: number, gridSize: number, swing: number): number {
  if (gridSize <= 0) return value;
  const swingOffset = swing * gridSize * 0.5;
  const pairSize = gridSize * 2;
  const pairIndex = Math.floor(value / pairSize);
  const pairStart = pairIndex * pairSize;
  const b1 = pairStart + gridSize + swingOffset;
  const m1 = (pairStart + b1) / 2;
  const m2 = (b1 + pairStart + pairSize) / 2;
  const candidates = [m1 - pairSize, m2 - pairSize, m1, m2, m1 + pairSize, m2 + pairSize];
  let best = candidates[0];
  let bestDist = Math.abs(value - best);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(value - candidates[i]);
    if (d < bestDist) {
      best = candidates[i];
      bestDist = d;
    }
  }
  return best;
}

// Steps to the neighboring cell midpoint. Midpoints are gridSize apart under
// swing, so the step is a flat gridSize after snapping to the current
// midpoint.
export function stepSwungGridCenter(value: number, gridSize: number, swing: number, direction: 1 | -1): number {
  if (gridSize <= 0) return value + direction * gridSize;
  const snapped = snapToSwungGridCenter(value, gridSize, swing);
  return snapped + direction * gridSize;
}

// Round a value to the nearest swung grid line.
export function snapToSwungGridRound(value: number, gridSize: number, swing: number): number {
  if (gridSize <= 0) return value;
  const swingOffset = swing * gridSize * 0.5;
  const pairSize = gridSize * 2;
  const pairIndex = Math.floor(value / pairSize);
  const pairStart = pairIndex * pairSize;
  const b0 = pairStart;
  const b1 = pairStart + gridSize + swingOffset;
  const b2 = pairStart + pairSize;
  let nearest = b0;
  let minDist = Math.abs(value - b0);
  const d1 = Math.abs(value - b1);
  if (d1 < minDist) {
    nearest = b1;
    minDist = d1;
  }
  const d2 = Math.abs(value - b2);
  if (d2 < minDist) {
    nearest = b2;
  }
  return nearest;
}

// Width in UV of the span the onset at or before `anchorTimeUv` owns: from that
// onset to the next one, or to the end of the file for the last. The aim snaps
// onto the onset, so a Grid-size brush covers exactly one hit however unevenly
// the hits are spaced. Returns null when the file has no onsets to measure.
export function onsetCellWidthUv(
  anchorTimeUv: number,
  onsets: Onset[] | undefined,
  totalDuration: number,
): number | null {
  if (!onsets?.length) return null;
  const anchorSeconds = anchorTimeUv * totalDuration + GRID_CELL_EPSILON_SEC;

  // Last onset at or before the anchor; -1 when the anchor precedes them all,
  // whose span then runs from the start of the file.
  let lo = 0;
  let hi = onsets.length - 1;
  let index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].timeSec <= anchorSeconds) {
      index = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const start = index < 0 ? 0 : onsets[index].timeSec;
  const end = index + 1 < onsets.length ? onsets[index + 1].timeSec : totalDuration;
  return end > start ? (end - start) / totalDuration : null;
}

// Width in UV of the grid cell containing `anchorTimeUv`, for when the time
// brush tracks the grid ("Grid" size) and time-snap is on. Swing alternates cell
// widths, so a constant-width brush leaves gaps on the wider cells; sizing each
// stroke to its own cell makes snapped strokes tile exactly. On the onset grid
// the cell is the span between hits instead. Returns null when it does not apply
// (snap off, or an explicit/Full brush size), leaving callers on the constant
// footprint.
export function swungGridCellWidthUv(
  anchorTimeUv: number,
  opts: { brushSizeTime: number; gridSizeBeats: number; gridSwing: number; snapTime: boolean; onsets?: Onset[] },
  bpm: number,
  totalDuration: number,
): number | null {
  if (!opts.snapTime || opts.brushSizeTime > 0) return null;
  if (!(totalDuration > 0)) return null;
  if (isOnsetGrid(opts.gridSizeBeats)) return onsetCellWidthUv(anchorTimeUv, opts.onsets, totalDuration);
  const gridInterval = (60 / bpm) * opts.gridSizeBeats;
  if (!(gridInterval > 0)) return null;
  const swing = opts.gridSwing / 100;
  // The anchor is the brush's BL, itself produced by snapping and round-tripped
  // through UV, so it can land a hair below an odd cell start. Nudge forward by
  // a sub-cell epsilon so a value on a grid line resolves to that cell, not the
  // previous (wider) one — otherwise odd cells get the wrong width and re-open gaps.
  const anchorSeconds = anchorTimeUv * totalDuration + gridInterval * 1e-6;
  const cellStart = snapToSwungGridFloor(anchorSeconds, gridInterval, swing);
  const cellWidthSeconds = stepSwungGrid(cellStart, gridInterval, swing, 1) - cellStart;
  return cellWidthSeconds / totalDuration;
}

// Convert beats to bars:beats:ticks format (480 ticks per beat, 4 beats per bar)
export function formatBeats(totalBeats: number, showSign: boolean = false): string {
  const sign = showSign ? (totalBeats >= 0 ? "+" : "") : "";
  const absBeats = Math.abs(totalBeats);

  const bars = Math.floor(absBeats / 4);
  const beats = Math.floor(absBeats % 4);
  const ticks = Math.floor((absBeats % 1) * 480);

  return `${sign}${totalBeats < 0 ? "-" : ""}${bars}:${beats}:${ticks}`;
}
