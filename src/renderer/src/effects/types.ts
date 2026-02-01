/**
 * Effect type definitions - no dependencies on store or effect implementations.
 * This file exists to break the circular dependency between store and effects.
 */

// Effect keys as a const tuple for type inference
export const EFFECT_KEYS = [
  "dynamics",
  "transform",
  "overtones",
  "blur",
  "synthesize",
  "evolve",
  "passthrough",
] as const;

// Effect type derived from the keys
export type EffectType = (typeof EFFECT_KEYS)[number];

// Default effect order (excluding passthrough which is internal)
export const DEFAULT_EFFECT_ORDER: { effect: EffectType; enabled: boolean }[] = EFFECT_KEYS.filter(
  (key) => key !== "passthrough"
).map((k) => ({ effect: k, enabled: false }));

/**
 * Synchronizes an effectOrder array with the current EFFECT_KEYS.
 * - Removes effects that no longer exist in EFFECT_KEYS
 * - Adds new effects that exist in EFFECT_KEYS but are missing from effectOrder (disabled by default)
 * - Preserves the order and enabled state of existing effects
 */
export function syncEffectOrder(
  effectOrder: { effect: string; enabled: boolean }[] | undefined,
): { effect: EffectType; enabled: boolean }[] {
  // Get valid effect keys (excluding passthrough)
  const validEffectKeys = EFFECT_KEYS.filter((key) => key !== "passthrough") as EffectType[];

  // If no effectOrder provided, return default
  if (!effectOrder || !Array.isArray(effectOrder)) {
    return DEFAULT_EFFECT_ORDER;
  }

  // Filter out effects that no longer exist
  const filteredOrder = effectOrder.filter(
    (item) => validEffectKeys.includes(item.effect as EffectType),
  ) as { effect: EffectType; enabled: boolean }[];

  // Find effects that exist in EFFECT_KEYS but are missing from effectOrder
  const existingEffects = new Set(filteredOrder.map((item) => item.effect));
  const missingEffects = validEffectKeys.filter((key) => !existingEffects.has(key));

  // Add missing effects at the end (disabled by default)
  const newEffects = missingEffects.map((effect) => ({ effect, enabled: false }));

  return [...filteredOrder, ...newEffects];
}
