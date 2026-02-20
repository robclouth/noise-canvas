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
  "binaural",
  "sort",
] as const;

// Effect type derived from the keys
export type EffectType = (typeof EFFECT_KEYS)[number];

// Per-instance effect parameters
export type EffectParams = Record<string, unknown>;

// Effect item with unique ID and per-instance parameters
export type EffectItem = {
  id: string;
  effect: EffectType;
  enabled: boolean;
  params: EffectParams;
};

// Backward compatibility alias
export type EffectOrderItem = EffectItem;

// Default effects - starts empty, user adds effects via modal
export const DEFAULT_EFFECTS: EffectItem[] = [];

// Backward compatibility alias
export const DEFAULT_EFFECT_ORDER = DEFAULT_EFFECTS;

/**
 * Synchronizes an effects array with the current EFFECT_KEYS.
 * - Removes effects that no longer exist in EFFECT_KEYS
 * - Adds unique IDs to entries that don't have them (migration from old format)
 * - Adds empty params object if missing
 * - Preserves the order and enabled state of existing effects
 */
export function syncEffects(
  effects: { id?: string; effect: string; enabled: boolean; params?: EffectParams }[] | undefined,
): EffectItem[] {
  // Get valid effect keys (excluding passthrough)
  const validEffectKeys = EFFECT_KEYS.filter((key) => key !== "passthrough") as EffectType[];

  // If no effects provided, return default (empty)
  if (!effects || !Array.isArray(effects)) {
    return DEFAULT_EFFECTS;
  }

  // Filter out effects that no longer exist and ensure all fields are present
  return effects
    .filter((item) => validEffectKeys.includes(item.effect as EffectType))
    .map((item) => ({
      id: item.id ?? crypto.randomUUID(),
      effect: item.effect as EffectType,
      enabled: item.enabled,
      params: item.params ?? {},
    }));
}

// Backward compatibility alias
export const syncEffectOrder = syncEffects;
