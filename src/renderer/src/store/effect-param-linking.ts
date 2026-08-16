import type { EffectItem } from "@renderer/effects/types";
import type { Brush, ParameterKey } from "./types";

/**
 * The effect `effectId` names in the active step, plus the matching one in
 * every other step. Each step builds its own effect instances with their own
 * ids, so the match across steps follows the effect's type and its position
 * among that step's effects of that type; matching by id finds only the step
 * the edit came from.
 */
export function matchingEffects(
  brush: Brush,
  activeStepIndex: number,
  effectId: string,
): { effects: EffectItem[]; index: number }[] {
  const activeEffects = (brush.steps[activeStepIndex]?.effects ?? []) as EffectItem[];
  const activeIndex = activeEffects.findIndex((e) => e.id === effectId);
  if (activeIndex < 0) return [];

  const effectType = activeEffects[activeIndex].effect;
  const ordinal = activeEffects.slice(0, activeIndex).filter((e) => e.effect === effectType).length;

  const matches: { effects: EffectItem[]; index: number }[] = [];
  for (const step of brush.steps) {
    const effects = (step.effects ?? []) as EffectItem[];
    let seen = 0;
    const index = effects.findIndex((e) => e.effect === effectType && seen++ === ordinal);
    if (index >= 0) matches.push({ effects, index });
  }
  return matches;
}

/** Writes `value` into the named effect, or into every step's when linked. */
export function writeEffectParam(
  brush: Brush,
  activeStepIndex: number,
  effectId: string,
  key: ParameterKey,
  value: unknown,
  linked: boolean,
): void {
  const write = (effects: EffectItem[], index: number) => {
    if (!effects[index].params) effects[index].params = {};
    effects[index].params[key] = value;
  };

  if (linked) {
    for (const { effects, index } of matchingEffects(brush, activeStepIndex, effectId)) write(effects, index);
    return;
  }

  const effects = (brush.steps[activeStepIndex]?.effects ?? []) as EffectItem[];
  const index = effects.findIndex((e) => e.id === effectId);
  if (index >= 0) write(effects, index);
}

/**
 * Drops the named effect parameter from every linked step, so each falls back
 * to the step's value. Used when linking is switched on for a parameter the
 * edited effect holds no value of its own for; storing an explicit undefined
 * would instead read back as a set value.
 */
export function clearLinkedEffectParam(
  brush: Brush,
  activeStepIndex: number,
  effectId: string,
  key: ParameterKey,
): void {
  for (const { effects, index } of matchingEffects(brush, activeStepIndex, effectId)) {
    if (effects[index].params) delete effects[index].params[key];
  }
}
