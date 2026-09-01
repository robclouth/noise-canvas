import type { EffectItem } from "@renderer/effects/types";
import type { ParameterDef } from "@renderer/parameters";
import {
  getParameterDef,
  getQuantizeParamKey,
  isEffectParameter,
  isStepParameter,
  parameterDefs,
} from "@renderer/parameters";
import { getMacroValueIndex } from "@renderer/store";
import { getModAmountValuesNormalized } from "@renderer/store/modulators";
import type { ParameterKey, SliderMark, State } from "@renderer/store/types";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { quantizeParameterValue } from "./quantize-lut";
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

/** Float slack for matching a value against a mark, relative to the mark's own size. */
const MARK_EPSILON = 1e-6;

/** The mark `value` lands on, including the sentinel ends, or null when it sits between them. */
function markAt(def: ParameterDef, value: number): SliderMark | null {
  if (def.kind !== "number") return null;
  const candidates: SliderMark[] = [...(def.marks ?? [])];
  if (def.leftValue) candidates.push(def.leftValue);
  if (def.rightValue) candidates.push(def.rightValue);
  return (
    candidates.find((mark) => Math.abs(value - mark.value) <= MARK_EPSILON * Math.max(1, Math.abs(mark.value))) ?? null
  );
}

function formatValue(key: ParameterKey, value: number, withUnit: boolean, decimals: number, useMarks = true): string {
  const def = getParameterDef(key);
  const unit = withUnit && def.kind === "number" ? (def.unit ?? "") : "";
  const mark = useMarks ? markAt(def, value) : null;
  // A mark label that opens with a letter ("Grid", "Off") names a mode rather
  // than a value in the parameter's unit, so it renders bare.
  if (mark) return /^-?[\d.]/.test(mark.label) ? `${mark.label}${unit}` : mark.label;
  return `${parseFloat(value.toFixed(decimals))}${unit}`;
}

/** Formats a parameter value with its unit the way the num box does. */
export function formatParameterValue(key: ParameterKey, value: number): string {
  return formatValue(key, value, true, 2);
}

/** The span a parameter's sources can drive it across, in the slider's own units. */
export type ModulationReach = { lower: number; upper: number };

/**
 * How far `key` can be driven from where its knob sits, at a total modulation `weight`. Sources
 * sweep the slider's own arc, so the span is `weight` wide in knob position and the base value sits
 * at its own position inside it. Null when nothing modulates the parameter.
 */
export function modulationReach(view: State, key: ParameterKey, weight: number): ModulationReach | null {
  if (weight <= 0) return null;
  const position = normalizeParameterValue(key, view[key] as number);
  const lowerPosition = position * (1 - weight);
  const lower = denormalizeParameterValue(key, lowerPosition);
  const upper = denormalizeParameterValue(key, lowerPosition + weight);

  const quantizeKey = getQuantizeParamKey(key);
  if (quantizeKey && view[quantizeKey] === true) {
    return { lower: quantizeParameterValue(key, lower), upper: quantizeParameterValue(key, upper) };
  }

  return { lower, upper };
}

/**
 * Width the num box leaves the reach, in digit widths. A marked parameter at the compact
 * density is the tightest: 45 px of room against a 5.3 px digit, the reach sitting one size
 * below the value's own. Measured on the built app.
 */
export const REACH_BUDGET = 8.5;

/** Width of a character relative to a digit. Counting characters alone rates "-64 – -44" and "-253–148x" alike. */
function charWidth(character: string): number {
  if (character === " ") return 0.45;
  if (character === "-") return 0.6;
  if (character === "." || character === "/") return 0.5;
  if (character === "%") return 1.5;
  return 1;
}

/** Estimated width of a reach string, in digit widths. */
export function reachWidth(text: string): number {
  let total = 0;
  for (const character of text) total += charWidth(character);
  return total;
}

type ReachStyle = { withUnit: boolean; decimals: number; useMarks: boolean; spaced: boolean };

function reachText(key: ParameterKey, reach: ModulationReach, style: ReachStyle): string {
  const { withUnit, decimals, useMarks, spaced } = style;
  const lower = formatValue(key, reach.lower, false, decimals, useMarks);
  const upperBare = formatValue(key, reach.upper, false, decimals, useMarks);
  const upper = formatValue(key, reach.upper, withUnit, decimals, useMarks);
  if (lower === upperBare) return upper;
  if (lower === `-${upperBare}`) return `±${upper}`;
  // Only a negative upper end puts a minus sign against the en dash, where the two
  // read as one glyph; a leading minus on the lower end is never ambiguous.
  const separator = spaced && upperBare.startsWith("-") ? " – " : "–";
  return `${lower}${separator}${upper}`;
}

/**
 * A reach as text, e.g. "25–75%" or "±48". The unit rides on the upper end alone and the
 * decimals track the span, so the pair stays short. Past `maxWidth` it sheds the decimals,
 * then the unit, then the mark names, and last the spaces that hold a negative upper end off
 * the dash, rather than ellipsising in the box.
 */
export function formatModulationReach(key: ParameterKey, reach: ModulationReach, maxWidth = Infinity): string {
  const span = Math.abs(reach.upper - reach.lower);
  // Two significant figures on the span, so a wide range sheds its noise digits.
  const decimals = span > 0 ? Math.min(2, Math.max(0, 1 - Math.floor(Math.log10(span)))) : 2;

  let text = reachText(key, reach, { withUnit: true, decimals, useMarks: true, spaced: true });
  for (const style of [
    { withUnit: true, decimals: 0, useMarks: true, spaced: true },
    { withUnit: false, decimals: 0, useMarks: true, spaced: true },
    { withUnit: false, decimals: 0, useMarks: false, spaced: true },
    { withUnit: false, decimals: 0, useMarks: false, spaced: false },
  ]) {
    if (reachWidth(text) <= maxWidth) return text;
    text = reachText(key, reach, style);
  }
  return text;
}
