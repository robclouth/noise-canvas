import { EFFECT_LABELS } from "@renderer/lib/constants";
import { brushReaches, type ReachContext } from "@renderer/lib/effect-reach";
import type { State } from "@renderer/store/types";

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

/** The refusal a brush gets when an effect reads further than the canvas holds. */
export function overReachRefusal(needs: string[]): string {
  const one = needs.length === 1;
  return `${listOf(needs)} ${one ? "reaches" : "reach"} too far for this file. Turn ${one ? "it" : "them"} down to paint here.`;
}

/** The refusal a brush wider than the canvas gets when an effect reads anywhere in it. */
export function wholeBrushRefusal(needs: string[]): string {
  const one = needs.length === 1;
  return `${listOf(needs)} ${one ? "reads" : "read"} across the whole brush, and this brush is too long for this file. Shorten it to paint here.`;
}

/** The refusal a brush wider than the canvas gets when it builds up on what it has just painted. */
export function liveReadRefusal(): string {
  return "Accumulate reads what the brush has just painted, and this brush is too long for this file. Shorten it to paint here.";
}

/**
 * Why the brush cannot paint on a canvas holding a window of the file, or null
 * when it can. A canvas over the whole file passes no context and never
 * refuses.
 */
export function strokeRefusal(state: State, ctx: ReachContext | null): string | null {
  if (!ctx) return null;
  const over = overReachNeeds(state, ctx);
  return over.length > 0 ? overReachRefusal(over) : null;
}
