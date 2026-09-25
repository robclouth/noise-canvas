import { EFFECT_LABELS } from "@renderer/lib/constants";
import { brushReaches, type ReachContext } from "@renderer/lib/effect-reach";
import { createStepStateView } from "@renderer/store";
import type { State } from "@renderer/store/types";

const SOURCE_TRACKING = "Source tracking";
const SOURCE_TIME = "A source time offset";

/**
 * What in the active brush reads the whole file, named as the user sees it.
 * Empty means the brush paints the same over a window of the file as it does
 * over all of it. Effects are absent: each one declares a reach around the
 * dab in `effect-reach.ts`, which `overReachNeeds` measures.
 */
export function wholeFileNeeds(state: State): string[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const needs = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    if (!step.sourceFile) {
      // A step with no source file of its own reads the canvas it paints on.
      // Tracking and the time offset put that read anywhere in the file.
      if (step.sourcePositionMode !== "follow") needs.add(SOURCE_TRACKING);
      if (Number(step.sourceTimeOffset) !== 0) needs.add(SOURCE_TIME);
    }
  }
  return [...needs];
}

/**
 * Effects the canvas cannot hold enough of the file for: a dab is painted a
 * block at a time, and one block plus what the effect reads either side of it
 * is wider than the span the canvas holds. Named as the user sees them.
 */
export function overReachNeeds(state: State, ctx: ReachContext): string[] {
  const needs = new Set<string>();
  for (const entry of brushReaches(state, ctx)) {
    const span = (ctx.blockSeconds ?? 0) + entry.reach.before + entry.reach.after;
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
  return `${listOf(needs)} ${one ? "reaches" : "reach"} too far for this file. Turn ${one ? "it" : "them"} down to paint here.`;
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
