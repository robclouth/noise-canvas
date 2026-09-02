import { EFFECT_LABELS } from "@renderer/lib/constants";
import { brushReaches, type ReachContext } from "@renderer/lib/effect-reach";
import { BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { State } from "@renderer/store/types";

/**
 * Effects that read the file rather than a span around the brush, so a canvas
 * holding a window of the file cannot serve them. Every effect declares a
 * reach in `effect-reach.ts` instead, except convolve with no response file
 * named, which reads the canvas from its first frame.
 */
export const WHOLE_FILE_EFFECTS: ReadonlySet<string> = new Set();

// Convolve with no response file named filters through the canvas itself, read
// from its first frame whatever the dab covers.
const SELF_RESPONSE = "Convolve with no IR";

const TIME_WRAP = "Wrap in time";
const FULL_BRUSH = "A brush the length of the file";
const SOURCE_TRACKING = "Source tracking";
const SOURCE_TIME = "A source time offset";

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
    if (!step.sourceFile) {
      // A step with no source file of its own reads the canvas it paints on.
      // Tracking and the time offset put that read anywhere in the file.
      if (step.sourcePositionMode !== "follow") needs.add(SOURCE_TRACKING);
      if (Number(step.sourceTimeOffset) !== 0) needs.add(SOURCE_TIME);
    }
    for (const item of step.effects) {
      if (!item.enabled) continue;
      if (WHOLE_FILE_EFFECTS.has(item.effect)) needs.add(EFFECT_LABELS[item.effect] ?? item.effect);
      if (item.effect === "convolve" && !createEffectStateView(state, index, item).convolveIrFile) {
        needs.add(SELF_RESPONSE);
      }
    }
  }
  return [...needs];
}

/**
 * Effects the canvas cannot hold enough of the file for: the brush plus what
 * the effect reads either side of it is wider than the span the canvas holds.
 * Named as the user sees them.
 */
export function overReachNeeds(state: State, ctx: ReachContext): string[] {
  const needs = new Set<string>();
  for (const entry of brushReaches(state, ctx)) {
    const span = entry.brushSeconds + entry.reach.before + entry.reach.after;
    if (span > ctx.canvasSeconds) needs.add(EFFECT_LABELS[entry.effect] ?? entry.effect);
  }
  return [...needs];
}

function listOf(needs: string[]): string {
  return needs.length === 1 ? needs[0] : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
}

/** The refusal a brush gets when the file is too long for what it asks for. */
export function wholeFileRefusal(needs: string[]): string {
  const one = needs.length === 1;
  return `${listOf(needs)} ${one ? "reads" : "read"} the whole file, and this file is too long for that. Switch ${one ? "it" : "them"} off to paint here.`;
}

/** The refusal a brush gets when an effect reads further than the canvas holds. */
export function overReachRefusal(needs: string[]): string {
  const one = needs.length === 1;
  return `${listOf(needs)} ${one ? "reaches" : "reach"} too far for this file. Turn ${one ? "it" : "them"} down, or paint a shorter brush, to paint here.`;
}

/**
 * Why the brush cannot paint on a canvas holding a window of the file, or null
 * when it can. A canvas over the whole file passes no context and never
 * refuses.
 */
export function strokeRefusal(state: State, ctx: ReachContext | null): string | null {
  if (!ctx) return null;
  const whole = wholeFileNeeds(state);
  if (whole.length > 0) return wholeFileRefusal(whole);
  const over = overReachNeeds(state, ctx);
  return over.length > 0 ? overReachRefusal(over) : null;
}
