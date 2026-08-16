const MAX_LABELS = 20;
const MIN_TICK_SPACING_PX = 6;

/** One legend mark: `position` is the 0..1 fraction across the strip. */
export type TimeMarker = { position: number; label: string; isTick: boolean };

/**
 * Beat-aligned ticks and bar.beat labels for the visible window of a file's
 * time legend. Tick density is capped by pixel spacing: the beat stride
 * doubles until ticks fit.
 */
export function computeTimeMarkers(opts: {
  zoom: number;
  offset: number;
  totalDuration: number;
  bpm: number;
  gridSizeBeats: number;
  widthPx: number;
}): TimeMarker[] {
  const { zoom, offset, totalDuration, bpm, gridSizeBeats, widthPx } = opts;
  const markers: TimeMarker[] = [];

  const zoomFactor = Math.pow(2, zoom);
  const visibleDuration = totalDuration / zoomFactor;
  const beatDuration = 60 / bpm;
  if (!(visibleDuration > 0) || !(beatDuration > 0)) return markers;

  const startTime = offset * (totalDuration - visibleDuration);
  const endTime = startTime + visibleDuration;

  let tickInterval = beatDuration;
  if (widthPx > 0) {
    while ((tickInterval / visibleDuration) * widthPx < MIN_TICK_SPACING_PX) tickInterval *= 2;
  }

  // Labels every beat, or at grid intervals for beat-level and larger grids.
  let labelInterval = gridSizeBeats > 0 && gridSizeBeats < 1 ? beatDuration : beatDuration * Math.max(1, gridSizeBeats);
  const potentialLabelCount = visibleDuration / labelInterval;
  if (potentialLabelCount > MAX_LABELS) {
    labelInterval = Math.ceil(potentialLabelCount / MAX_LABELS) * beatDuration;
  }
  // Labels must land on drawn ticks once ticks are thinned.
  labelInterval = Math.ceil(labelInterval / tickInterval - 1e-9) * tickInterval;

  const firstTickTime = Math.ceil(startTime / tickInterval) * tickInterval;
  for (let time = firstTickTime; time <= endTime; time += tickInterval) {
    if (time > totalDuration) break;

    const beat = (time / 60) * bpm;
    const measure = Math.floor(beat / 4) + 1;
    const beatInMeasure = Math.floor(beat % 4) + 1;
    const screenX = (time - startTime) / visibleDuration;

    if (screenX >= 0 && screenX <= 1) {
      const timeDiff = Math.abs(time - Math.round(time / labelInterval) * labelInterval);
      const shouldHaveLabel = timeDiff < tickInterval * 0.01;
      markers.push({
        position: screenX,
        label: shouldHaveLabel ? `${measure}.${beatInMeasure}` : "",
        isTick: !shouldHaveLabel,
      });
    }
  }
  return markers;
}
