import { getNumberParameterDef, getQuantizeParamKey } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getMacroAmountValuesNormalized,
  getModAmountValuesNormalized,
} from "@renderer/store/modulators";
import type { ParameterKey, State } from "@renderer/store/types";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { ParameterScaleKind } from "@renderer/types";
import { NUM_MACROS } from "./constants";
import { quantizeParameterValue } from "./quantize-lut";
import { parameterScale } from "./static-modulation";

/** The lowest and highest value a parameter can take. */
export type ValueRange = { lo: number; hi: number };

/** A source's possible outputs, 0–1, and its signed amount on the parameter. */
type Source = { amount: number; lo: number; hi: number };

const FULL: Readonly<{ lo: number; hi: number }> = { lo: 0, hi: 1 };

/**
 * The value each macro knob of the active brush can hold, 0–1: its own value,
 * or anywhere when the stroke context moves it.
 */
function macroRanges(state: State): ValueRange[] {
  const base = state.brushes[state.activeBrushIndex]?.macroValues ?? [];
  return Array.from({ length: NUM_MACROS }, (_, i) => {
    const moved = getContextualModAmountsNormalized(state, `macro${i + 1}Value` as ParameterKey).some(
      (amount) => amount !== 0 && !Number.isNaN(amount),
    );
    const value = (base[i] ?? 50) / 100;
    return moved ? FULL : { lo: value, hi: value };
  });
}

/** Every source that drives `key`, with the outputs it can give across a dab. */
function sourcesOf(state: State, key: ParameterKey): Source[] {
  const out: Source[] = [];
  for (const amount of getModAmountValuesNormalized(state, key)) out.push({ amount, ...FULL });
  for (const amount of getContextualModAmountsNormalized(state, key)) out.push({ amount, ...FULL });
  const macros = macroRanges(state);
  getMacroAmountValuesNormalized(state, key).forEach((amount, i) => out.push({ amount, ...(macros[i] ?? FULL) }));
  return out.filter((source) => source.amount !== 0 && !Number.isNaN(source.amount));
}

/** True while the parameter's quantise toggle is on. */
function quantizes(state: State, key: ParameterKey): boolean {
  const toggle = getQuantizeParamKey(key);
  return toggle !== null && state[toggle] === true;
}

/**
 * The values `key` can take across a dab, as the shader resolves it from
 * `value`: every source blended by its weight, in knob position for a log
 * slider and in `range` (the slider's own when absent) for a linear one, then
 * snapped where the parameter quantises.
 */
export function modulatedRange(
  state: State,
  key: ParameterKey,
  value: number,
  range?: { min: number; max: number },
): ValueRange {
  const sources = sourcesOf(state, key);
  if (sources.length === 0) return { lo: value, hi: value };
  const def = getNumberParameterDef(key);
  const log = parameterScale(key).scaleKind !== ParameterScaleKind.Linear;
  const bounds = log ? { min: 0, max: 1 } : (range ?? { min: def.min, max: def.max });
  const at = log ? normalizeParameterValue(key, value) : value;

  let weight = 0;
  let sumLo = 0;
  let sumHi = 0;
  for (const source of sources) {
    const w = Math.abs(source.amount);
    const from = source.amount < 0 ? bounds.max : bounds.min;
    const to = source.amount < 0 ? bounds.min : bounds.max;
    const a = from + (to - from) * source.lo;
    const b = from + (to - from) * source.hi;
    sumLo += w * Math.min(a, b);
    sumHi += w * Math.max(a, b);
    weight += w;
  }
  const blend = Math.min(1, weight);
  let lo = at + blend * (sumLo / weight - at);
  let hi = at + blend * (sumHi / weight - at);
  if (log) {
    lo = denormalizeParameterValue(key, Math.min(1, Math.max(0, lo)));
    hi = denormalizeParameterValue(key, Math.min(1, Math.max(0, hi)));
  }
  if (quantizes(state, key)) {
    lo = Math.min(lo, quantizeParameterValue(key, lo));
    hi = Math.max(hi, quantizeParameterValue(key, hi));
  }
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}
