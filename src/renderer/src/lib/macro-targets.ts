import type { EffectItem } from "@renderer/effects/types";
import { getParameterDef, isEffectParameter, isStepParameter, parameterDefs } from "@renderer/parameters";
import { getMacroValueIndex } from "@renderer/store";
import { getModAmountValuesNormalized } from "@renderer/store/modulators";
import type { ParameterKey, State } from "@renderer/store/types";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { createModContext, NEUTRAL_STROKE_CONTEXT, staticModulation } from "./static-modulation";

/** One parameter a macro drives: where it lives and the signed amount, −100…100. */
export type MacroTarget = {
  key: ParameterKey;
  stepIndex: number;
  effectId?: string;
  amount: number;
};

let targetableKeys: ParameterKey[] | null = null;

function macroTargetableKeys(): ParameterKey[] {
  if (targetableKeys) return targetableKeys;
  targetableKeys = Object.entries(parameterDefs)
    .filter(([, def]) => def.kind === "number" && def.modulatable && def.modulationSourcesAllowed !== "contextualOnly")
    .map(([key]) => key as ParameterKey);
  return targetableKeys;
}

/** Every parameter in the active brush that macro `macroIndex` drives, across all of its steps. */
export function macroTargets(state: State, macroIndex: number): MacroTarget[] {
  const brush = state.brushes[state.activeBrushIndex];
  if (!brush) return [];
  const suffix = `ModMacro${macroIndex + 1}Amount`;
  const out: MacroTarget[] = [];
  brush.steps.forEach((step, stepIndex) => {
    for (const key of macroTargetableKeys()) {
      if (isEffectParameter(key)) continue;
      const amountKey = `${key}${suffix}` as ParameterKey;
      const amount = (isStepParameter(amountKey) ? step[amountKey] : undefined) ?? state[amountKey];
      if (typeof amount === "number" && amount !== 0) out.push({ key, stepIndex, amount });
    }
    const effects = (step.effects ?? []) as EffectItem[];
    for (const effect of effects) {
      for (const [paramKey, amount] of Object.entries(effect.params ?? {})) {
        if (!paramKey.endsWith(suffix) || typeof amount !== "number" || amount === 0) continue;
        const key = paramKey.slice(0, -suffix.length) as ParameterKey;
        if (!(key in parameterDefs)) continue;
        out.push({ key, stepIndex, effectId: effect.id, amount });
      }
    }
  });
  return out;
}

/**
 * A read-only view of `state` that resolves parameter keys through the layers of one step and,
 * when `effectId` is given, one effect item: effect params, then the step, then the defaults.
 */
export function scopedStateView(state: State, stepIndex: number, effectId?: string | null): State {
  const brush = state.brushes[state.activeBrushIndex];
  const step = brush?.steps[stepIndex];
  const effects = (step?.effects ?? []) as EffectItem[];
  const effect = effectId ? effects.find((item) => item.id === effectId) : undefined;
  // The store's state is frozen, so the proxy's target is an empty object and
  // every read is forwarded; a frozen target would pin each property to its own value.
  return new Proxy({} as State, {
    get(_target, prop) {
      if (typeof prop === "string" && prop in parameterDefs) {
        const key = prop as ParameterKey;
        if (effect && isEffectParameter(key)) return effect.params?.[key] ?? getParameterDef(key).default;
        const macroIndex = getMacroValueIndex(key);
        if (macroIndex !== null) return brush?.macroValues[macroIndex] ?? getParameterDef(key).default;
        if (isStepParameter(key)) return step && key in step ? step[key] : getParameterDef(key).default;
      }
      return Reflect.get(state, prop);
    },
    has(_target, prop) {
      return prop in state;
    },
  });
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** True when a modulator, which moves across the stroke, also drives `key`. */
export function hasDynamicSources(view: State, key: ParameterKey): boolean {
  return getModAmountValuesNormalized(view, key).some((amount) => amount !== 0);
}

/**
 * The value `key` sits at with the macro knobs where they are and no stroke under way, in its
 * slider's units. The static sources are folded in knob position, as the shader sweeps them.
 */
export function resolvedStaticValue(view: State, key: ParameterKey): number {
  const base = view[key] as number;
  const ctx = createModContext(view, NEUTRAL_STROKE_CONTEXT);
  const { staticSum, staticWeight } = staticModulation(view, key, 0, 1, ctx);
  if (staticWeight === 0) return base;
  const position = normalizeParameterValue(key, base);
  const swept = mix(position, staticSum / staticWeight, Math.min(1, staticWeight));
  return denormalizeParameterValue(key, swept);
}

/** Total modulation weight on `key` from every source, as the shader clamps it: 1 means the base value no longer counts. */
export function totalModulationWeight(view: State, key: ParameterKey): number {
  const ctx = createModContext(view, NEUTRAL_STROKE_CONTEXT);
  const { staticWeight } = staticModulation(view, key, 0, 1, ctx);
  const dynamicWeight = getModAmountValuesNormalized(view, key).reduce((sum, amount) => sum + Math.abs(amount), 0);
  return Math.min(1, staticWeight + dynamicWeight);
}

/** Formats a parameter value with its unit the way the num box does. */
export function formatParameterValue(key: ParameterKey, value: number): string {
  const def = getParameterDef(key);
  const unit = def.kind === "number" ? (def.unit ?? "") : "";
  return `${parseFloat(value.toFixed(2))}${unit}`;
}
