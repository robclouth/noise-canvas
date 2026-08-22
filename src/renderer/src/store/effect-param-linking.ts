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

/**
 * Seeds a freshly linked effect parameter across every step. The value comes
 * from the first step holding the matching effect, not from the step the switch
 * was flipped on, so a step added later cannot overwrite the earlier ones. When
 * no step holds a value the parameter is dropped everywhere, so each falls back
 * to its step value.
 */
export function seedLinkedEffectParam(
  brush: Brush,
  activeStepIndex: number,
  effectId: string,
  key: ParameterKey,
): void {
  const seed = matchingEffects(brush, activeStepIndex, effectId)[0];
  const seedParams = seed && seed.effects[seed.index].params;
  if (seedParams && key in seedParams) {
    writeEffectParam(brush, activeStepIndex, effectId, key, seedParams[key], true);
  } else {
    clearLinkedEffectParam(brush, activeStepIndex, effectId, key);
  }
}

/** Seeds a freshly linked step parameter across every step from the first step's value. */
export function seedLinkedStepParam(brush: Brush, key: ParameterKey): void {
  const firstValue = brush.steps[0]?.[key];
  brush.steps.forEach((step) => {
    (step as Record<string, unknown>)[key] = firstValue;
  });
}
