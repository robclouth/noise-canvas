import { EFFECT_LABELS } from "@renderer/lib/constants";
import { BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import { createStepStateView } from "@renderer/store";
import type { State } from "@renderer/store/types";

/**
 * Effects that read the file rather than a span around the brush, so a canvas
 * holding a window of the file cannot serve them.
 */
export const WHOLE_FILE_EFFECTS: ReadonlySet<string> = new Set(["attract", "convolve", "evolve", "sort", "transmute"]);

const TIME_WRAP = "Wrap in time";
const FULL_BRUSH = "A brush the length of the file";

/**
 * What in the active brush reads the whole file, named as the user sees it.
 * Empty means the brush paints the same over a window of the file as it does
 * over all of it. Wrapping in time folds a read back onto the far end of the
 * canvas, and a full-length brush spans the canvas, so both read whatever span
 * the canvas holds rather than the file.
 */
export function wholeFileNeeds(state: State): string[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const needs = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    const wrapMode = step.brushWrapMode as number;
    if (wrapMode === 1 || wrapMode === 3) needs.add(TIME_WRAP);
    if ((step.brushSizeTime as number) >= BRUSH_SIZE_TIME_FULL) needs.add(FULL_BRUSH);
    for (const item of step.effects) {
      if (item.enabled && WHOLE_FILE_EFFECTS.has(item.effect)) needs.add(EFFECT_LABELS[item.effect] ?? item.effect);
    }
  }
  return [...needs];
}

/** The refusal a brush gets when the file is too long for what it asks for. */
export function wholeFileRefusal(needs: string[]): string {
  const one = needs.length === 1;
  const list = one ? needs[0] : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
  return `${list} ${one ? "reads" : "read"} the whole file, and this file is too long for that. Switch ${one ? "it" : "them"} off to paint here.`;
}
