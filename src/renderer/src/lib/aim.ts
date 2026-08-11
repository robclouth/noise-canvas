import { Vector2 } from "three";
import { BRUSH_ANCHOR_MODE_CENTER, isOnsetGrid } from "./constants";
import type { Onset } from "./onset-map";
import { buildScaleOffsets, minFreqSemisAboveC0, snapSemisToScale } from "./scale-snap";
import { screenToZoomed, snapToSwungGridCenter, snapToSwungGridFloor, viewUvYToPitchUv } from "./utils";

/** The file geometry an aim is resolved against. */
export interface AimSpectrogram {
  numBands: number;
  bandsPerOctave: number;
  minFreq: number;
  totalDuration: number;
}

/** Grid and anchor settings, read off the store by the caller. */
export interface AimSnapping {
  snapTime: boolean;
  snapPitch: boolean;
  gridSizeBeats: number;
  gridSizeSemis: number;
  gridSwing: number;
  scaleTonic: string;
  scaleType: string;
  anchorMode: number;
}

export interface AimUv {
  x: number;
  /** Pitch UV: 0 at the file's lowest band, 1 above its highest. */
  y: number;
}

// Snaps a time-axis UV to the time grid. Below the smallest beat value the
// grid control means the file's detected onsets. The beat grid snaps to cell
// midpoints in center-anchor mode and cell starts otherwise; onset snapping
// lands the aim on the onset in either mode, since an onset is a position
// rather than a cell to sit inside.
function snapTimeUv(
  uvX: number,
  bpm: number,
  totalDuration: number,
  isCenter: boolean,
  snapping: AimSnapping,
  onsets: readonly Onset[],
): number {
  if (isOnsetGrid(snapping.gridSizeBeats)) {
    if (onsets.length === 0) return uvX;
    const currentTime = uvX * totalDuration;
    let nearest = onsets[0].timeSec;
    for (const onset of onsets) {
      if (Math.abs(onset.timeSec - currentTime) < Math.abs(nearest - currentTime)) nearest = onset.timeSec;
    }
    return nearest / totalDuration;
  }

  const gridIntervalSeconds = (60 / bpm) * snapping.gridSizeBeats;
  const snapFn = isCenter ? snapToSwungGridCenter : snapToSwungGridFloor;
  return snapFn(uvX * totalDuration, gridIntervalSeconds, snapping.gridSwing / 100) / totalDuration;
}

// Snaps a pitch UV to the scale (when gridSizeSemis is 0 / "Scale" mode) or to
// the chromatic gridSizeSemis cell. In chromatic mode, centerSnap returns the
// cell midpoint; otherwise the cell start. Scale mode always returns the
// nearest scale note (scale notes are points, not cells).
function snapPitchUv(uvY: number, isCenter: boolean, spectrogram: AimSpectrogram, snapping: AimSnapping): number {
  const { numBands, bandsPerOctave, minFreq } = spectrogram;
  const bandsPerSemitone = bandsPerOctave / 12;
  const bandsAboveMin = uvY * numBands;

  if (snapping.gridSizeSemis <= 0) {
    const semisAboveMin = bandsAboveMin / bandsPerSemitone;
    const pitchOffset = minFreqSemisAboveC0(minFreq);
    const absSemis = pitchOffset + semisAboveMin;
    const offsets = buildScaleOffsets(snapping.scaleTonic, snapping.scaleType);
    const snappedAbs = snapSemisToScale(absSemis, offsets);
    return ((snappedAbs - pitchOffset) * bandsPerSemitone) / numBands;
  }

  const gridIntervalBands = snapping.gridSizeSemis * bandsPerSemitone;
  const snappedBands = isCenter
    ? (Math.round(bandsAboveMin / gridIntervalBands - 0.5) + 0.5) * gridIntervalBands
    : Math.floor(bandsAboveMin / gridIntervalBands) * gridIntervalBands;
  return snappedBands / numBands;
}

/**
 * Turns a pointer position into the aim point the brush is placed from.
 *
 * This is the one crossing from view UV (y-down, as the DOM reports it) into
 * pitch UV (y-up, as every shader reads it): the flip happens here and nowhere
 * downstream. Snapping runs after the flip, so both axes are already in the
 * space the brush anchor and the stroke shaders use.
 */
export function resolveAimUv(params: {
  /** Pointer position as a fraction of the lane, y measured down from its top. */
  viewUv: Vector2;
  zoom: Vector2;
  offset: Vector2;
  bpm: number;
  spectrogram: AimSpectrogram;
  snapping: AimSnapping;
  onsets: readonly Onset[];
}): AimUv {
  const { viewUv, zoom, offset, bpm, spectrogram, snapping, onsets } = params;
  const zoomed = screenToZoomed(viewUv, zoom, offset);
  const isCenter = snapping.anchorMode === BRUSH_ANCHOR_MODE_CENTER;

  const x = snapping.snapTime
    ? snapTimeUv(zoomed.x, bpm, spectrogram.totalDuration, isCenter, snapping, onsets)
    : zoomed.x;

  const pitchY = viewUvYToPitchUv(zoomed.y);
  const y = snapping.snapPitch ? snapPitchUv(pitchY, isCenter, spectrogram, snapping) : pitchY;

  return { x, y };
}
