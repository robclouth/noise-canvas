import { BRUSH_ANCHOR_MODE_CORNER } from "@renderer/lib/constants";
import { BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import type { BrushStep } from "@renderer/parameters";
import type { State } from "@renderer/store/types";
import type { StampEvent } from "./pattern-engine";

/** Shortest stamp the brush size parameter accepts before it means "Grid". */
export const MIN_STAMP_BEATS = 0.05;

/** Longest stamp before the brush size parameter means "Full file". */
export const MAX_STAMP_BEATS = BRUSH_SIZE_TIME_FULL - 0.1;

export interface ResolvedStamp extends StampEvent {
  /** Brush slot this stamp paints with, already resolved to a real index. */
  brushIndex: number;
  /** Absolute pitch, in semitones above the lowest band. */
  pitchSemis: number;
}

/**
 * A state snapshot for one stamp: the pattern's brush selected, and every step
 * of it stretched to the event's length and anchored at its onset. Both are
 * per-step parameters, so they are written onto cloned steps.
 */
export function buildStampState(base: State, stamp: ResolvedStamp): State {
  const brush = base.brushes[stamp.brushIndex];
  if (!brush) return base;

  const sizeTime = Math.min(MAX_STAMP_BEATS, Math.max(MIN_STAMP_BEATS, stamp.durationBeats));
  const steps: BrushStep[] = brush.steps.map((step) => {
    const next: BrushStep = { ...step };
    const writable: Record<string, unknown> = next;
    writable.brushSizeTime = sizeTime;
    writable.brushAnchorMode = BRUSH_ANCHOR_MODE_CORNER;
    return next;
  });

  const brushes = [...base.brushes];
  brushes[stamp.brushIndex] = { ...brush, steps };

  return {
    ...base,
    brushes,
    activeBrushIndex: stamp.brushIndex,
    brushSizeTime: sizeTime,
    brushAnchorMode: BRUSH_ANCHOR_MODE_CORNER,
  };
}
