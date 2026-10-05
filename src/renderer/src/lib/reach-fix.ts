import type { EffectItem } from "@renderer/effects/types";
import { EFFECT_LABELS, NUM_MODULATORS } from "@renderer/lib/constants";
import { formatParameterValue } from "@renderer/lib/macro-targets";
import { getEffectParameterKeys, getNumberParameterDef, parameterDefs, type BrushStep } from "@renderer/parameters";
import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { ParameterKey, State } from "@renderer/store/types";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";

/** One control of the active brush: a step's own parameter, or one of an effect item's. */
type Knob = { step: number; item: number | null; key: ParameterKey; owner: string };

/**
 * A setting of one control that lets the brush paint: the brush with it set,
 * how the message names it, and how far the knob moves to reach it (infinite
 * for a change of mode).
 */
export type ReachFix = { fixed: State; text: string; distance: number };

// Halvings of the knob's travel the search takes between a refused and a painting setting.
const SEARCH_HALVINGS = 14;

// Steps of the parameter past the boundary the search tries when the rounded value still refuses.
const ROUNDING_STEPS = 4;

// Fixes the message offers at most.
const MAX_FIXES = 3;

// Milliseconds the search for fixes may take before it offers what it has found.
const SEARCH_BUDGET_MS = 400;

// The modulator mode that follows the level of the step's input.
const MODULATOR_ENVELOPE = 1;

// A step's own controls that set how much of the file its brush covers and how often it runs.
const STEP_KNOBS: ParameterKey[] = ["brushSizeTime", "brushSizePitch", "brushIterations"];

function activeSteps(state: State) {
  return state.brushes[state.activeBrushIndex]?.steps ?? [];
}

/** Every control of the enabled steps that can change what the brush reads, effects' first. */
function knobsOf(state: State): Knob[] {
  const steps = activeSteps(state);
  const knobs: Knob[] = [];
  steps.forEach((step, index) => {
    if (step.enabled === false) return;
    const named = (owner: string) => (steps.length > 1 ? `${step.name} ${owner}` : owner);
    const view = createStepStateView(state, index);
    (step.effects ?? []).forEach((item: EffectItem, itemIndex: number) => {
      if (!item.enabled) return;
      const owner = named(EFFECT_LABELS[item.effect] ?? item.effect);
      for (const key of getEffectParameterKeys(item.effect)) {
        const kind = parameterDefs[key]?.kind;
        if (kind === "number" || (kind === "options" && key.endsWith("EdgeMode")))
          knobs.push({ step: index, item: itemIndex, key, owner });
      }
    });
    for (let i = 1; i <= NUM_MODULATORS; i++) {
      if (Number(view[`modulator${i}Mode` as ParameterKey]) !== MODULATOR_ENVELOPE) continue;
      for (const key of [`modulator${i}EnvelopeSmoothingBeats`, `modulator${i}StereoSpread`] as ParameterKey[])
        knobs.push({ step: index, item: null, key, owner: named(`Modulator ${i}`) });
    }
    for (const key of STEP_KNOBS) knobs.push({ step: index, item: null, key, owner: named("Brush") });
  });
  return knobs;
}

/** The value `knob` holds in `state`. */
function valueOf(state: State, knob: Knob): number {
  const step = activeSteps(state)[knob.step];
  const item = knob.item === null ? null : step?.effects?.[knob.item];
  const view = item ? createEffectStateView(state, knob.step, item) : createStepStateView(state, knob.step);
  return Number(view[knob.key]);
}

/** `state` with `knob` set to `value` and nothing else changed. */
function withValue(state: State, knob: Knob, value: number): State {
  const brushes = state.brushes.map((brush, b) => {
    if (b !== state.activeBrushIndex) return brush;
    const steps = brush.steps.map((step, s) => {
      if (s !== knob.step) return step;
      const next: BrushStep = { ...step };
      const writable: Record<string, unknown> = next;
      if (knob.item === null) writable[knob.key] = value;
      else
        writable.effects = (step.effects ?? []).map((item: EffectItem, i: number) =>
          i === knob.item ? { ...item, params: { ...item.params, [knob.key]: value } } : item,
        );
      return next;
    });
    return { ...brush, steps };
  });
  return { ...state, brushes };
}

/** `value` on the parameter's own step grid, rounded away from `from`. */
function onStep(key: ParameterKey, value: number, from: number): number {
  const { step, min, max } = getNumberParameterDef(key);
  if (step === undefined || !(step > 0)) return value;
  const steps = value / step;
  const rounded = (value < from ? Math.floor(steps) : Math.ceil(steps)) * step;
  return Math.min(max, Math.max(min, parseFloat(rounded.toPrecision(12))));
}

/**
 * `value` as the message shows it: in the control's own unit, or in beats or
 * semitones for a marked control along time or pitch that shows none.
 */
function shownValue(key: ParameterKey, value: number): string {
  const def = getNumberParameterDef(key);
  const shown = formatParameterValue(key, value);
  if (def.unit || !def.marks?.length) return shown;
  const one = Math.abs(value) === 1;
  if (def.label.includes("↔")) return `${shown} ${one ? "beat" : "beats"}`;
  if (def.label.includes("↕")) return `${shown} ${one ? "semitone" : "semitones"}`;
  return shown;
}

/**
 * How the message asks for `value` on a control now at `current`. A control
 * that runs either side of zero, moved toward zero, asks for the span about
 * zero when the other side paints too.
 */
function settingText(key: ParameterKey, value: number, current: number, paints: (value: number) => boolean): string {
  const def = getNumberParameterDef(key);
  const bipolar = def.min < 0 && def.max > 0;
  if (bipolar && value === 0) return `to ${shownValue(key, 0)}`;
  if (bipolar && Math.abs(value) < Math.abs(current) && Math.sign(value) === Math.sign(current)) {
    const size = Math.abs(value);
    if (paints(-value)) return `between ${formatParameterValue(key, -size)} and ${shownValue(key, size)}`;
    return `to ${shownValue(key, value)} or nearer 0`;
  }
  if (value <= def.min || value >= def.max) return `to ${shownValue(key, value)}`;
  return `to ${shownValue(key, value)} ${value < current ? "or less" : "or more"}`;
}

/**
 * The setting of a number knob nearest its current one that paints, found by
 * halving the knob's travel toward a painting landmark: its default when that
 * paints, otherwise the nearest of either end and zero. Null when none paints,
 * or when the setting found shows as the value the knob already has.
 */
function numberFix(state: State, knob: Knob, refuses: (state: State) => boolean): ReachFix | null {
  const key = knob.key;
  const def = getNumberParameterDef(key);
  const current = valueOf(state, knob);
  if (!Number.isFinite(current)) return null;
  const from = normalizeParameterValue(key, current);
  const at = (position: number) => denormalizeParameterValue(key, position);
  const paints = (position: number) => !refuses(withValue(state, knob, at(position)));
  const landmarks = [def.default, def.min, def.max, ...(def.min < 0 && def.max > 0 ? [0] : [])]
    .map((value) => normalizeParameterValue(key, value))
    .filter((position) => Math.abs(position - from) > 1e-9);
  const [home, ...rest] = landmarks;
  const pass =
    home !== undefined && Math.abs(normalizeParameterValue(key, def.default) - home) < 1e-9 && paints(home)
      ? home
      : rest.sort((a, b) => Math.abs(a - from) - Math.abs(b - from)).find(paints);
  if (pass === undefined) return null;

  let refused = from;
  let painted = pass;
  for (let i = 0; i < SEARCH_HALVINGS; i++) {
    const mid = (refused + painted) / 2;
    if (paints(mid)) painted = mid;
    else refused = mid;
  }
  let value = onStep(key, at(painted), current);
  const step = def.step ?? 0;
  for (let i = 0; i < ROUNDING_STEPS && step > 0 && refuses(withValue(state, knob, value)); i++)
    value = onStep(key, value + (value < current ? -step : step), current);
  if (refuses(withValue(state, knob, value))) value = at(pass);
  if (formatParameterValue(key, value) === formatParameterValue(key, current)) return null;
  return {
    fixed: withValue(state, knob, value),
    text: `${knob.owner} ${def.label} ${settingText(key, value, current, (v) => !refuses(withValue(state, knob, v)))}`,
    distance: Math.abs(normalizeParameterValue(key, value) - from),
  };
}

/** The first other option of an edge mode that paints. */
function optionFix(state: State, knob: Knob, refuses: (state: State) => boolean): ReachFix | null {
  const def = parameterDefs[knob.key];
  if (def?.kind !== "options") return null;
  const current = valueOf(state, knob);
  for (const option of def.options) {
    const value = Number(option.value);
    if (value === current || refuses(withValue(state, knob, value))) continue;
    return {
      fixed: withValue(state, knob, value),
      text: `${knob.owner} ${def.label} to ${option.label}`,
      distance: Infinity,
    };
  }
  return null;
}

/** "a", "a or b", "a, b or c". */
function either(parts: string[]): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * The settings that would let a brush paint where `refuses` says it cannot:
 * for each control of the brush, the value nearest its current one at which
 * it paints, the smallest moves first, then a change of edge mode. `refuses`
 * is the real test of whether a brush in a given state paints at this spot.
 * Controls left when `budgetMs` runs out are not searched.
 */
export function reachFixes(state: State, refuses: (state: State) => boolean, budgetMs = SEARCH_BUDGET_MS): ReachFix[] {
  const deadline = performance.now() + budgetMs;
  const fixes: ReachFix[] = [];
  for (const knob of knobsOf(state)) {
    if (performance.now() > deadline) break;
    const number = parameterDefs[knob.key]?.kind === "number";
    const fix = number ? numberFix(state, knob, refuses) : optionFix(state, knob, refuses);
    if (fix) fixes.push(fix);
  }
  const numbers = fixes.filter((fix) => Number.isFinite(fix.distance)).sort((a, b) => a.distance - b.distance);
  const edge = fixes.find((fix) => !Number.isFinite(fix.distance));
  return [...numbers.slice(0, edge ? MAX_FIXES - 1 : MAX_FIXES), ...(edge ? [edge] : [])];
}

/** Why a brush cannot paint at this spot, and the settings `fixes` that would let it. */
export function reachFixMessage(fixes: readonly ReachFix[]): string {
  const lead = "This brush reads more of the file around it than the canvas can hold at this spot.";
  if (fixes.length === 0)
    return `${lead} Turn down how far its effects move or smear the sound, or paint with a smaller brush.`;
  return `${lead} Set ${either(fixes.map((fix) => fix.text))}.`;
}
