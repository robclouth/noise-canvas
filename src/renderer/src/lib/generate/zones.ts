import { BRUSH_SIZE_PITCH_FULL } from "@renderer/lib/utils";
import type { StampEvent } from "./pattern-engine";

/** Where a spectrum slice sits and how tall it is, in semitones. */
export interface ZoneSlice {
  /**
   * Pitch to anchor the brush at, in semitones above the lowest band. A stamp
   * reaches upward in pitch from its anchor, so this is the slice's low edge.
   */
  anchorSemis: number;
  /** Slice height, in semitones. Uses the Full sentinel for a single slice. */
  heightSemis: number;
}

/**
 * How many slices the spectrum is cut into when the pattern never says. Taking
 * the highest slice index it uses means `zone("0 1 2")` reads as "in thirds"
 * without having to state the count.
 */
export function inferZoneCount(events: readonly StampEvent[]): number {
  let highest = -1;
  for (const event of events) {
    if (event.zoneIndex === undefined) continue;
    if (event.zoneCount !== undefined) continue;
    highest = Math.max(highest, Math.floor(event.zoneIndex));
  }
  return highest < 0 ? 1 : highest + 1;
}

/**
 * Cuts the spectrum into `count` equal slices and returns slice `index`,
 * counting up from the lowest. Indices outside the range wrap, so a pattern
 * that climbs past the top comes back in at the bottom.
 */
export function zoneSlice(index: number, count: number, spectrumSemis: number): ZoneSlice {
  const slices = Math.max(1, Math.floor(count));
  const wrapped = ((Math.floor(index) % slices) + slices) % slices;
  const sliceSemis = spectrumSemis / slices;
  return {
    anchorSemis: wrapped * sliceSemis,
    // One slice is the whole range, which is what the Full size means — and it
    // anchors on its own.
    heightSemis: slices === 1 ? BRUSH_SIZE_PITCH_FULL : sliceSemis,
  };
}
