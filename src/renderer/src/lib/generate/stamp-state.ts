import { BRUSH_ANCHOR_MODE_CORNER } from "@renderer/lib/constants";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import type { BrushStep } from "@renderer/parameters";
import type { State } from "@renderer/store/types";
import { MACRO_COUNT, type StampEvent } from "./pattern-engine";

/** Shortest stamp the brush size parameter accepts before it means "Grid". */
export const MIN_STAMP_BEATS = 0.05;

/** Longest stamp before the brush size parameter means "Full file". */
export const MAX_STAMP_BEATS = BRUSH_SIZE_TIME_FULL - 0.1;

/** Strength, pan and macros are all percentages in the app. */
const MAX_PERCENT = 100;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface ResolvedStamp extends StampEvent {
  /** Brush slot this stamp paints with, already resolved to a real index. */
  brushIndex: number;
  /** Absolute pitch of the brush's lower edge, in semitones above the lowest band. */
  pitchSemis: number;
  /** Brush pitch size in semitones, from a spectrum slice; `height` overrides it. */
  sliceSemis?: number;
}

/**
 * A state snapshot for one stamp: the pattern's brush selected, its steps
 * stretched to the event's length and anchored at its onset, and any strength,
 * pan or size the pattern set. All of those are per-step parameters, so they are
 * written onto cloned steps; macros live on the brush and are cloned there.
 */
export function buildStampState(base: State, stamp: ResolvedStamp): State {
  const brush = base.brushes[stamp.brushIndex];
  if (!brush) return base;

  const sizeTime =
    stamp.widthBeats !== undefined
      ? clamp(stamp.widthBeats, 0, BRUSH_SIZE_TIME_FULL)
      : clamp(stamp.durationBeats, MIN_STAMP_BEATS, MAX_STAMP_BEATS);
  const requestedPitch = stamp.heightSemis ?? stamp.sliceSemis;
  const sizePitch = requestedPitch !== undefined ? clamp(requestedPitch, 0, BRUSH_SIZE_PITCH_FULL) : undefined;
  const panPercent = stamp.pan !== undefined ? clamp(stamp.pan, -1, 1) * MAX_PERCENT : undefined;

  const steps: BrushStep[] = brush.steps.map((step) => {
    const next: BrushStep = { ...step };
    const writable: Record<string, unknown> = next;
    writable.brushSizeTime = sizeTime;
    writable.brushAnchorMode = BRUSH_ANCHOR_MODE_CORNER;
    if (sizePitch !== undefined) writable.brushSizePitch = sizePitch;
    if (panPercent !== undefined) writable.brushPan = panPercent;
    if (stamp.gain !== undefined) {
      // Gain scales the brush's own strength, so a gain of 1 changes nothing.
      const stepIntensity = typeof step.brushIntensity === "number" ? step.brushIntensity : base.brushIntensity;
      writable.brushIntensity = clamp(stepIntensity * stamp.gain, 0, MAX_PERCENT);
    }
    return next;
  });

  const macroValues = stamp.macros
    ? brush.macroValues.map((value, index) =>
        index < MACRO_COUNT && stamp.macros?.[index] !== undefined
          ? clamp(stamp.macros[index] * MAX_PERCENT, 0, MAX_PERCENT)
          : value,
      )
    : brush.macroValues;

  const brushes = [...base.brushes];
  brushes[stamp.brushIndex] = { ...brush, steps, macroValues };

  return {
    ...base,
    brushes,
    activeBrushIndex: stamp.brushIndex,
    brushSizeTime: sizeTime,
    brushAnchorMode: BRUSH_ANCHOR_MODE_CORNER,
  };
}
