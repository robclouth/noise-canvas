import { Vector2 } from "three";

// Special sentinel values on the brush size sliders:
//   value === 0          → "Grid" mode (track the current time/pitch grid)
//   value >= *_FULL_*    → "Full" mode (brush spans the entire file on this axis)
export const BRUSH_SIZE_TIME_FULL = 32;
export const BRUSH_SIZE_PITCH_FULL = 128;

// Fallback grid interval in semis when the pitch grid is set to "Scale" mode
// (gridSizeSemis <= 0) but the brush size is linked to Grid.
const PITCH_GRID_SCALE_FALLBACK_SEMIS = 12;

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

  const timeBeats = gridTime ? gridSizeBeats : brushSizeTime;
  const pitchSemis = gridPitch ? (gridSizeSemis > 0 ? gridSizeSemis : PITCH_GRID_SCALE_FALLBACK_SEMIS) : brushSizePitch;

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

// Step to the adjacent swung grid line in the given direction. Assumes `value`
// is already snapped to a swung grid line (or close to one).
export function stepSwungGrid(value: number, gridSize: number, swing: number, direction: 1 | -1): number {
  if (gridSize <= 0) return value + direction * gridSize;
  const swingOffset = swing * gridSize * 0.5;
  const pairSize = gridSize * 2;
  const pairIndex = Math.floor(value / pairSize);
  const pairStart = pairIndex * pairSize;
  const oddLine = pairStart + gridSize + swingOffset;
  const onOdd = Math.abs(value - oddLine) < Math.abs(value - pairStart);
  if (direction === 1) {
    return onOdd ? pairStart + pairSize : oddLine;
  }
  if (onOdd) return pairStart;
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

// Convert beats to bars:beats:ticks format (480 ticks per beat, 4 beats per bar)
export function formatBeats(totalBeats: number, showSign: boolean = false): string {
  const sign = showSign ? (totalBeats >= 0 ? "+" : "") : "";
  const absBeats = Math.abs(totalBeats);

  const bars = Math.floor(absBeats / 4);
  const beats = Math.floor(absBeats % 4);
  const ticks = Math.floor((absBeats % 1) * 480);

  return `${sign}${totalBeats < 0 ? "-" : ""}${bars}:${beats}:${ticks}`;
}
