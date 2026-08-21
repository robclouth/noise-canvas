import {
  getContextualModAmountsNormalized,
  getMacroAmountValuesNormalized,
  getModAmountValuesNormalized,
} from "@renderer/store/modulators";
import { ParameterKey, State } from "@renderer/store/types";
import { normalizeParameterValue } from "@renderer/store/utils";
import { getNumberParameterDef } from "@renderer/parameters";
import { ParameterScaleKind, ParameterUniform } from "@renderer/types";
import { Vector2 } from "three";
import { CONTEXTUAL_MOD_SOURCES, NUM_MACROS } from "./constants";

/** Modulation sources that hold one value across a whole dab: the stroke context and the resolved macro knobs, all 0–1. */
export type ModContext = {
  iteration: number;
  time: number;
  pitch: number;
  random: number;
  step: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  macros: number[];
};

export type StrokeContext = Omit<ModContext, "macros">;

/** The static pair an effect parameter carries: the signed sum of its static contributions and their total weight. */
export type StaticModulation = { staticSum: number; staticWeight: number };

/** The affine pair a modulator parameter carries, applied after pattern nesting as `scale * x + offset`. */
export type NestedStaticModulation = { staticScale: number; staticOffset: number };

export const NEUTRAL_STROKE_CONTEXT: Readonly<StrokeContext> = {
  iteration: 0,
  time: 0.5,
  pitch: 0.5,
  random: 0,
  step: 0,
  pressure: 0,
  tiltX: 0.5,
  tiltY: 0.5,
};

const DEFAULT_MACROS = [50, 50, 50, 50];

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Stroke-context source values in `CONTEXTUAL_MOD_SOURCES` order. */
export function contextualSourceValues(ctx: StrokeContext): number[] {
  const byKey: Record<string, number> = {
    Iteration: ctx.iteration,
    Time: ctx.time,
    Pitch: ctx.pitch,
    Random: ctx.random,
    Step: ctx.step,
    Pressure: ctx.pressure,
    TiltX: ctx.tiltX,
    TiltY: ctx.tiltY,
  };
  return CONTEXTUAL_MOD_SOURCES.map((source) => byKey[source.key] ?? 0);
}

function accumulateStatic(
  acc: { sum: number; weight: number },
  amounts: number[],
  sources: number[],
  minValue: number,
  maxValue: number,
): void {
  for (let i = 0; i < amounts.length; i++) {
    const amount = amounts[i];
    if (amount === 0 || Number.isNaN(amount)) continue;
    const minV = amount < 0 ? maxValue : minValue;
    const maxV = amount < 0 ? minValue : maxValue;
    const weight = Math.abs(amount);
    acc.sum += mix(minV, maxV, sources[i] ?? 0) * weight;
    acc.weight += weight;
  }
}

/** Macro knob values for the step, 0–1, after their own stroke-context modulation. */
export function resolveMacroValues(state: State, ctx: StrokeContext): number[] {
  const base = state.brushes[state.activeBrushIndex]?.macroValues ?? DEFAULT_MACROS;
  const sources = contextualSourceValues(ctx);
  const out = new Array<number>(NUM_MACROS);
  for (let i = 0; i < NUM_MACROS; i++) {
    const baseValue = base[i] ?? 50;
    const amounts = getContextualModAmountsNormalized(state, `macro${i + 1}Value` as ParameterKey);
    const acc = { sum: 0, weight: 0 };
    accumulateStatic(acc, amounts, sources, 0, 100);
    const value = acc.weight === 0 ? baseValue : mix(baseValue, acc.sum / acc.weight, clamp01(acc.weight));
    out[i] = value / 100;
  }
  return out;
}

export function createModContext(state: State, stroke: StrokeContext): ModContext {
  return { ...stroke, macros: resolveMacroValues(state, stroke) };
}

/** Static contributions of `key` over its shader range, folded into the shader's weighted average as one term. */
export function staticModulation(
  state: State,
  key: ParameterKey,
  minValue: number,
  maxValue: number,
  ctx: ModContext,
): StaticModulation {
  const acc = { sum: 0, weight: 0 };
  accumulateStatic(acc, getContextualModAmountsNormalized(state, key), contextualSourceValues(ctx), minValue, maxValue);
  accumulateStatic(acc, getMacroAmountValuesNormalized(state, key), ctx.macros, minValue, maxValue);
  return { staticSum: acc.sum, staticWeight: acc.weight };
}

/** A linear parameter's value and range in shader units, when they differ from the slider's. */
export type ShaderRange = { value: number; min: number; max: number };

type ParameterScale = { scaleKind: ParameterScaleKind; logEnds: Vector2 };

const LINEAR_SCALE: Readonly<ParameterScale> = { scaleKind: ParameterScaleKind.Linear, logEnds: new Vector2(0, 0) };

const scaleCache = new Map<ParameterKey, ParameterScale>();

/** The slider scale of `key` as the shader needs it to map a knob position back to a value. */
export function parameterScale(key: ParameterKey): ParameterScale {
  const cached = scaleCache.get(key);
  if (cached) return cached;
  const { min, max, scale } = getNumberParameterDef(key);
  let out: ParameterScale = LINEAR_SCALE;
  if (scale === "logBipolar") {
    out = {
      scaleKind: ParameterScaleKind.LogBipolar,
      logEnds: new Vector2(Math.log1p(Math.max(Math.abs(min), Math.abs(max))), 0),
    };
  } else if (scale === "log" && min <= 0) {
    out = { scaleKind: ParameterScaleKind.Log1p, logEnds: new Vector2(Math.log1p(max), 0) };
  } else if (scale === "log") {
    out = { scaleKind: ParameterScaleKind.Log, logEnds: new Vector2(Math.log(min), Math.log(max)) };
  }
  scaleCache.set(key, out);
  return out;
}

/** A parameter uniform with no modulation, parked at `value`. */
export function defaultParameterUniform(value: number, minValue: number, maxValue: number): ParameterUniform {
  return {
    value,
    position: 0,
    minValue,
    maxValue,
    modulationAmounts: [],
    staticSum: 0,
    staticWeight: 0,
    scaleKind: ParameterScaleKind.Linear,
    logEnds: new Vector2(0, 0),
  };
}

/**
 * Writes the uniform for a modulatable parameter into `target`. A log slider crosses in its own
 * units with its knob position alongside, so every source sweeps the slider's own arc; a linear one
 * crosses in `range`, or in the slider's units when no range is given.
 */
export function writeParameterUniform(
  target: ParameterUniform,
  state: State,
  key: ParameterKey,
  ctx: ModContext,
  range?: ShaderRange,
): void {
  const scale = parameterScale(key);
  const isLog = scale.scaleKind !== ParameterScaleKind.Linear;
  if (isLog) {
    const def = getNumberParameterDef(key);
    target.value = state[key] as number;
    target.position = normalizeParameterValue(key, target.value);
    target.minValue = def.min;
    target.maxValue = def.max;
  } else if (range) {
    target.value = range.value;
    target.position = 0;
    target.minValue = range.min;
    target.maxValue = range.max;
  } else {
    const def = getNumberParameterDef(key);
    target.value = state[key] as number;
    target.position = 0;
    target.minValue = def.min;
    target.maxValue = def.max;
  }
  target.modulationAmounts = getModAmountValuesNormalized(state, key);
  const sweepMin = isLog ? 0 : target.minValue;
  const sweepMax = isLog ? 1 : target.maxValue;
  const { staticSum, staticWeight } = staticModulation(state, key, sweepMin, sweepMax, ctx);
  target.staticSum = staticSum;
  target.staticWeight = staticWeight;
  target.scaleKind = scale.scaleKind;
  target.logEnds = scale.logEnds;
}

/** The uniform for a modulatable parameter; see `writeParameterUniform`. */
export function parameterUniform(
  state: State,
  key: ParameterKey,
  ctx: ModContext,
  range?: ShaderRange,
): ParameterUniform {
  const out = defaultParameterUniform(0, 0, 1);
  writeParameterUniform(out, state, key, ctx, range);
  return out;
}

function chainNested(
  acc: { scale: number; offset: number },
  amounts: number[],
  sources: number[],
  minValue: number,
  maxValue: number,
): void {
  for (let i = 0; i < amounts.length; i++) {
    const amount = amounts[i];
    if (amount === 0 || Number.isNaN(amount)) continue;
    const minV = amount < 0 ? maxValue : minValue;
    const maxV = amount < 0 ? minValue : maxValue;
    const c = clamp01(Math.abs(amount));
    const swept = mix(minV, maxV, sources[i] ?? 0);
    acc.scale *= 1 - c;
    acc.offset = acc.offset * (1 - c) + swept * c;
  }
}

/** Static contributions of a modulator parameter as the affine map its chain of sequential mixes reduces to. */
export function nestedStaticModulation(
  state: State,
  key: ParameterKey,
  minValue: number,
  maxValue: number,
  ctx: ModContext,
): NestedStaticModulation {
  const acc = { scale: 1, offset: 0 };
  chainNested(acc, getContextualModAmountsNormalized(state, key), contextualSourceValues(ctx), minValue, maxValue);
  chainNested(acc, getMacroAmountValuesNormalized(state, key), ctx.macros, minValue, maxValue);
  return { staticScale: acc.scale, staticOffset: acc.offset };
}
