import { buildShapeTable, type CloneShapeKey } from "@renderer/effects/clone-shapes";
import type { EffectType } from "@renderer/effects/types";
import { modulationWeight } from "@renderer/lib/static-modulation";
import { originFraction, resolveBrushFootprint } from "@renderer/lib/utils";
import { getNumberParameterDef } from "@renderer/parameters";
import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { ParameterKey, State } from "@renderer/store/types";

/** Seconds of the file an effect reads either side of the brush's own span. */
export type TimeReach = { before: number; after: number };

/** The clocks a reach is measured against. */
export type ReachContext = {
  /** The file's tempo. */
  bpm: number;
  /** The file's whole duration. */
  fileSeconds: number;
  /** The span the canvas holds. */
  canvasSeconds: number;
  bandsPerOctave: number;
  numBands: number;
};

/** One effect's reach in one step, with the brush span it is measured around. */
export type StepReach = { effect: EffectType; step: number; brushSeconds: number; reach: TimeReach };

const NO_REACH: TimeReach = { before: 0, after: 0 };

// Edge modes that let a read leave the brush. Cut, Wrap, Clamp and Reflect all
// fold it back inside, so the effect reads nothing the brush does not cover.
const READS_PAST_BRUSH: ReadonlySet<number> = new Set([1, 5]);

// Below this the shader applies no time scale at all, so the read stays the
// size of the brush instead of dividing by a value close to zero.
const NO_SCALE_BELOW = 1e-5;

type ValueRange = { lo: number; hi: number };

/** The range a parameter's value can take once every source that drives it moves it. */
function valueRange(state: State, key: ParameterKey, value: number, range?: { min: number; max: number }): ValueRange {
  const bounds = range ?? getNumberParameterDef(key);
  const weight = modulationWeight(state, key);
  if (weight === 0) return { lo: value, hi: value };
  const swing = weight * Math.max(Math.abs(bounds.min - value), Math.abs(bounds.max - value));
  return {
    lo: Math.max(Math.min(bounds.min, bounds.max, value), value - swing),
    hi: Math.min(Math.max(bounds.min, bounds.max, value), value + swing),
  };
}

/** The range of a parameter the effect reads straight out of the state. */
function stateRange(state: State, key: ParameterKey): ValueRange {
  return valueRange(state, key, Number(state[key] ?? 0));
}

/** The largest magnitude the range holds. */
function widest(range: ValueRange): number {
  return Math.max(Math.abs(range.lo), Math.abs(range.hi));
}

/** The smallest magnitude the range holds, which is zero when it crosses zero. */
function narrowest(range: ValueRange): number {
  return range.lo <= 0 && range.hi >= 0 ? 0 : Math.min(Math.abs(range.lo), Math.abs(range.hi));
}

/** Tap position in gap units, as the repeat shader interpolates its shape table. */
function tapAt(table: number[], index: number): number {
  const last = table.length - 1;
  if (last < 0) return 0;
  const i0 = Math.min(Math.max(0, Math.floor(index)), last);
  const i1 = Math.min(i0 + 1, last);
  return Math.abs(table[i0] + (table[i1] - table[i0]) * Math.min(1, Math.max(0, index - i0)));
}

/**
 * A smear is an offset added to the source UV, so its beats convert against the
 * span the canvas holds and its modulation sweeps that same UV. Origin makes it
 * one-sided.
 */
function blurReach(effect: State, ctx: ReachContext): TimeReach {
  if (!READS_PAST_BRUSH.has(Number(effect.blurEdgeMode)) || ctx.canvasSeconds <= 0) return NO_REACH;
  const uvPerBeat = 60 / ctx.bpm / ctx.canvasSeconds;
  const uvRange = { min: 0, max: 0.1 };
  const smearUv = ((Number(effect.blurAmountTime) * 4) / 100) * uvPerBeat;
  const noiseUv = ((Number(effect.blurNoiseTime) * 4) / 100) * uvPerBeat * 0.2;
  const smear = widest(valueRange(effect, "blurAmountTime", smearUv, uvRange));
  const noise = widest(valueRange(effect, "blurNoiseTime", noiseUv, uvRange));
  const span = (smear + noise) * ctx.canvasSeconds;
  const origin = Number(effect.blurOrigin);
  return { before: origin === 2 ? 0 : span, after: origin === 0 ? 0 : span };
}

/** Copies are read at whole multiples of the gap, spaced by the shape table. */
function cloneReach(effect: State, ctx: ReachContext): TimeReach {
  const copies = Number(effect.cloneCountX);
  if (!READS_PAST_BRUSH.has(Number(effect.cloneEdgeMode)) || copies <= 0) return NO_REACH;
  const taps = copies + 1;
  const gap = widest(stateRange(effect, "cloneSpaceBeats"));
  const table = buildShapeTable(effect.cloneShapeX as CloneShapeKey, taps);
  const furthest = Number(effect.cloneDirectionX) === 1 ? (taps - 1) / 2 : taps - 1;
  const span = tapAt(table, furthest) * gap * (60 / ctx.bpm);
  return { before: span, after: span };
}

/**
 * The warp reads at the pivot plus the brush arm, turned, scaled and shifted. A
 * turn is taken on the file's time axis, so its pitch arm scales with the whole
 * file rather than with the span the canvas holds. A scale that can pass
 * through zero divides the arm by nothing, which no window can serve.
 */
function transformReach(effect: State, ctx: ReachContext, brushSeconds: number, brushPitchUv: number): TimeReach {
  if (!READS_PAST_BRUSH.has(Number(effect.transformEdgeMode))) return NO_REACH;

  const scale = stateRange(effect, "transformScaleTime");
  const speed = stateRange(effect, "transformSpeed");
  const speedWidest = widest(speed);
  const speedNarrowest = narrowest(speed);
  const scaleWidest = speedNarrowest === 0 ? Infinity : widest(scale) / speedNarrowest;
  const scaleNarrowest = speedWidest === 0 ? 0 : narrowest(scale) / speedWidest;
  const divisor = scaleWidest <= NO_SCALE_BELOW ? 1 : scaleNarrowest;
  if (divisor === 0) return { before: Infinity, after: Infinity };

  const rotation = stateRange(effect, "transformRotation");
  const quarterTurn = (rotation.lo <= 90 && rotation.hi >= 90) || (rotation.lo <= -90 && rotation.hi >= -90);
  const turnAmount = quarterTurn
    ? 1
    : Math.max(Math.abs(Math.sin((rotation.lo * Math.PI) / 180)), Math.abs(Math.sin((rotation.hi * Math.PI) / 180)));

  const originTime = originFraction(Number(effect.transformOriginTime));
  const pivot = originTime * brushSeconds;
  const mirrors = scale.lo < 0;
  const armBefore = (mirrors ? Math.max(pivot, brushSeconds - pivot) : pivot) / divisor;
  const armAfter = (mirrors ? Math.max(pivot, brushSeconds - pivot) : brushSeconds - pivot) / divisor;

  const pitchPivot = originFraction(Number(effect.transformOriginPitch)) * brushPitchUv;
  const turn = (turnAmount * Math.max(pitchPivot, brushPitchUv - pitchPivot) * ctx.fileSeconds) / divisor;
  const flipped = mirrors ? Math.abs(1 - 2 * originTime) * brushSeconds : 0;
  const shift = widest(stateRange(effect, "transformShiftBeats")) * (60 / ctx.bpm);
  const extra = turn + flipped + shift;

  return {
    before: Math.max(0, armBefore + extra - pivot),
    after: Math.max(0, armAfter + extra - (brushSeconds - pivot)),
  };
}

/** The brush's own span on each axis, in file seconds and in pitch UV. */
function brushSpan(step: State, ctx: ReachContext): { seconds: number; pitchUv: number } {
  const footprint = resolveBrushFootprint({
    brushSizeTime: Number(step.brushSizeTime),
    brushSizePitch: Number(step.brushSizePitch),
    gridSizeBeats: Number(step.gridSizeBeats),
    gridSizeSemis: Number(step.gridSizeSemis),
    bpm: ctx.bpm,
    totalDuration: ctx.fileSeconds,
    bandsPerOctave: ctx.bandsPerOctave,
    numBands: ctx.numBands,
  });
  return { seconds: footprint.sizeUv.x * ctx.fileSeconds, pitchUv: footprint.sizeUv.y };
}

/**
 * The reach of every enabled effect in the brush that reads past the dab's own
 * span. Effects that read only the texel they write are absent, and so are the
 * ones that read the whole file whatever their settings — `WHOLE_FILE_EFFECTS`
 * covers those.
 */
export function brushReaches(state: State, ctx: ReachContext): StepReach[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const out: StepReach[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    const span = brushSpan(step, ctx);
    for (const item of step.effects) {
      if (!item.enabled) continue;
      const effect = createEffectStateView(state, index, item);
      let reach = NO_REACH;
      if (item.effect === "blur") reach = blurReach(effect, ctx);
      else if (item.effect === "clone") reach = cloneReach(effect, ctx);
      else if (item.effect === "transform") reach = transformReach(effect, ctx, span.seconds, span.pitchUv);
      if (reach.before <= 0 && reach.after <= 0) continue;
      out.push({ effect: item.effect, step: index, brushSeconds: span.seconds, reach });
    }
  }
  return out;
}

/**
 * The furthest any enabled effect in the brush reads either side of the dab's
 * own span, in seconds of the file.
 */
export function strokeReach(state: State, ctx: ReachContext): TimeReach {
  let before = 0;
  let after = 0;
  for (const entry of brushReaches(state, ctx)) {
    before = Math.max(before, entry.reach.before);
    after = Math.max(after, entry.reach.after);
  }
  return { before, after };
}
