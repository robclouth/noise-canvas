import { Vector2 } from "three";

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
