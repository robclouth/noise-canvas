import type { SliderMark } from "@renderer/store/types";

/** Normalised position covered by one pixel of a plain drag. */
export const BASE_SENSITIVITY = 1 / 200;

/** Normalised position covered by one pixel while the fine modifier is held. */
export const FINE_SENSITIVITY = 1 / 600;

const MARK_SWEEP_PX = 200;
const MIN_PX_PER_MARK = 3;
const MAX_PX_PER_MARK = 16;

/** Vertical pixels that carry a stepped drag from one mark to the next. */
export function pixelsPerMark(markCount: number): number {
  if (markCount < 2) return MAX_PX_PER_MARK;
  const even = MARK_SWEEP_PX / (markCount - 1);
  return Math.min(MAX_PX_PER_MARK, Math.max(MIN_PX_PER_MARK, even));
}

/**
 * Where `value` sits on `marks` as a fractional index. Marks must be in
 * ascending value order. A value between two marks returns a fraction between
 * their indices, so a value left off the grid resumes stepping from where it is
 * rather than from the start of the list.
 */
export function markFraction(value: number, marks: SliderMark[]): number {
  const last = marks.length - 1;
  if (last < 0) return 0;
  if (value <= marks[0].value) return 0;
  if (value >= marks[last].value) return last;
  for (let i = 0; i < last; i++) {
    const lo = marks[i].value;
    const hi = marks[i + 1].value;
    if (value < hi) return i + (value - lo) / (hi - lo);
  }
  return last;
}

/** The mark a fractional index lands on. */
export function markIndexFromFraction(fraction: number, markCount: number): number {
  if (markCount < 1) return 0;
  return Math.min(markCount - 1, Math.max(0, Math.round(fraction)));
}

/** Moves a fractional index by a drag delta in pixels, held inside the list. */
export function advanceMarkFraction(fraction: number, deltaPx: number, markCount: number): number {
  if (markCount < 1) return 0;
  const moved = fraction + deltaPx / pixelsPerMark(markCount);
  return Math.min(markCount - 1, Math.max(0, moved));
}
