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

export const screenToZoomed = (screenUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return screenUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2(viewStartX + screenUv.x * viewWidth, screenUv.y);
};

export const zoomedToScreen = (zoomedUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return zoomedUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
};

// Convert beats to bars:beats:ticks format (480 ticks per beat, 4 beats per bar)
export function formatBeats(totalBeats: number, showSign: boolean = false): string {
  const sign = showSign ? (totalBeats >= 0 ? "+" : "") : "";
  const absBeats = Math.abs(totalBeats);

  const bars = Math.floor(absBeats / 4);
  const beats = Math.floor(absBeats % 4);
  const ticks = Math.floor((absBeats % 1) * 480);

  return `${sign}${totalBeats < 0 ? "-" : ""}${bars}:${beats}:${ticks}`;
}
