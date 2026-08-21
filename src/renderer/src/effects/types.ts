/**
 * Effect type definitions - no dependencies on store or effect implementations.
 * This file exists to break the circular dependency between store and effects.
 */

// Effect keys as a const tuple for type inference
export const EFFECT_KEYS = [
  "dynamics",
  "transform",
  "blur",
  "clone",
  "synthesize",
  "evolve",
  "passthrough",
  "binaural",
  "sort",
  "transmute",
  "waveshape",
  "convolve",
  "align",
  "attract",
] as const;

// Effect type derived from the keys
export type EffectType = (typeof EFFECT_KEYS)[number];

/**
 * Effects the Add Effect picker does not offer. They still run in brushes that
 * already hold them, but they are absent from the manual, so their parameters
 * resolve no manual section.
 */
export const HIDDEN_EFFECTS = new Set<string>(["waveshape", "align"]);

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

const OVERTONES_SHAPE_TO_CLONE_SHAPE: Record<string, string> = {
  logarithmic: "harmonic",
  exponential: "geometric",
  octaves: "even",
  selectedScale: "scale",
};

function migrateOvertonesParams(params: EffectParams): EffectParams {
  const scale = typeof params.overtonesScale === "number" ? params.overtonesScale : 1;
  const partials = typeof params.overtonesCount === "number" ? params.overtonesCount : 32;
  const migrated: EffectParams = {
    cloneCountX: 0,
    // The overtones count included the fundamental; clone counts copies added.
    cloneCountY: Math.max(0, partials - 1),
    cloneSpaceSemis: 12 * scale,
    cloneSpaceBeats: 0,
    cloneDirectionY: 0,
    cloneShapeY: OVERTONES_SHAPE_TO_CLONE_SHAPE[String(params.overtonesShape ?? "logarithmic")] ?? "harmonic",
    cloneEdgeMode: 1,
  };
  if (typeof params.overtonesDecay === "number") migrated.cloneDecay = params.overtonesDecay;
  return migrated;
}

/**
 * Synchronizes an effects array with the current EFFECT_KEYS.
 * - Rewrites retired effects onto their replacement
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
    .map((item) =>
      item.effect === "overtones"
        ? { ...item, effect: "clone", params: migrateOvertonesParams(item.params ?? {}) }
        : item,
    )
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
