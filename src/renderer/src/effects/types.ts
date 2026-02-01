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
  "passthrough",
] as const;

// Effect type derived from the keys
export type EffectType = (typeof EFFECT_KEYS)[number];

// Default effect order (excluding passthrough which is internal)
export const DEFAULT_EFFECT_ORDER: { effect: EffectType; enabled: boolean }[] = EFFECT_KEYS.filter(
  (key) => key !== "passthrough"
).map((k) => ({ effect: k, enabled: false }));
