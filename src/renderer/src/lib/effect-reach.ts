import { buildShapeTable, type CloneShapeKey } from "@renderer/effects/clone-shapes";
import type { EffectType } from "@renderer/effects/types";
import { EVOLVE_SCALE_FULL_BEATS, EVOLVE_SCALE_FULL_SEMIS } from "@renderer/lib/constants";
import { responsePath } from "@renderer/lib/impulse-key";
import { modulationWeight } from "@renderer/lib/static-modulation";
import { originFraction, resolveBrushFootprint } from "@renderer/lib/utils";
import { getNumberParameterDef } from "@renderer/parameters";
import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { ParameterKey, State } from "@renderer/store/types";

/** Seconds of the file an effect reads either side of the brush's own span. */
export type TimeReach = { before: number; after: number };

/** How long a file is, and how much real time its coarsest stored bin covers. */
export type FileSpan = { seconds: number; binSeconds: number };

/** The clocks a reach is measured against. */
export type ReachContext = {
  /** The file's tempo. */
  bpm: number;
  /**
   * The file an effect filters through: the one at `path`, or the file the
   * brush paints from when `path` is null. Absent where none can be resolved,
   * which makes those effects read nothing.
   */
  responseSpan?: (path: string | null) => FileSpan | null;
  /** The file's whole duration. */
  fileSeconds: number;
  /** The span the canvas holds. */
  canvasSeconds: number;
  /** The span one block of the canvas holds: a dab is painted a block at a time. */
  blockSeconds?: number;
  bandsPerOctave: number;
  numBands: number;
  /** One bin of the file's coarsest band, in seconds. */
  binSeconds?: number;
};

/** One effect's reach in one step, with the brush span it is measured around and how many times it runs. */
export type StepReach = { effect: EffectType; step: number; brushSeconds: number; reach: TimeReach; repeats: number };

const NO_REACH: TimeReach = { before: 0, after: 0 };

// Edge modes that let a read leave the brush. Cut, Wrap, Clamp and Reflect all
// fold it back inside, so the effect reads nothing the brush does not cover.
const READS_PAST_BRUSH: ReadonlySet<number> = new Set([1, 5]);

// The edge mode that folds a read past one end of the brush in at the other.
const WRAP_EDGE = 2;

// Sort directions that order a band along time.
const SORTS_ALONG_TIME: ReadonlySet<number> = new Set([0, 2]);

// Sort directions that order a frame across pitch.
const SORTS_ALONG_PITCH: ReadonlySet<number> = new Set([1, 2]);

// Bins of its band one sort reads either side of a pixel: its two passes along
// time each swap with a neighbour whose own neighbours set its instantaneous
// frequency, and its two passes across pitch read one more bin each side.
const SORT_TIME_BINS = 6;

// Bands one sort reads either side of a pixel: one for each pass across pitch.
const SORT_PITCH_BANDS = 2;

// The attract time pass gathers over three kernels and reads its field a
// kernel past that.
const ATTRACT_PIECE_KERNELS = 4;

// Below this the shader applies no time scale at all, so the read stays the
// size of the brush instead of dividing by a value close to zero.
const NO_SCALE_BELOW = 1e-5;

// The Transmute route that moves a band along time. Every other route writes
// the bin it read.
const TRANSMUTE_TO_TIME = 2;

// Attract maps whose pull follows a field the shader reads off a spectrogram:
// Source, and the three modulators. Scale and Grid pull toward a lattice the
// shader works out, and read nothing.
const ATTRACT_MAP_SOURCE = 0;
const ATTRACT_MAP_FIRST_MODULATOR = 3;

// The field lattice rounds the kernel up to its next tap, and a tap is a
// quarter of the smoothing, so the read passes the smoothing by a little.
const ATTRACT_KERNEL_TAPS = 2;

// The gradient taps read one neighbourhood out, and the shader holds the flow
// step to eight more.
const EVOLVE_REACH_NEIGHBOURHOODS = 9;

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
  if (!READS_PAST_BRUSH.has(Number(effect.blurEdgeMode))) return NO_REACH;
  return blurSmear(effect, ctx);
}

/** How far the smear reads either side of a pixel, wherever the edge mode sends it. */
function blurSmear(effect: State, ctx: ReachContext): TimeReach {
  if (ctx.canvasSeconds <= 0) return NO_REACH;
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
  if (!READS_PAST_BRUSH.has(Number(effect.cloneEdgeMode))) return NO_REACH;
  return cloneTaps(effect, ctx);
}

/** How far the furthest copy is read from a pixel. */
function cloneTaps(effect: State, ctx: ReachContext): TimeReach {
  const copies = Number(effect.cloneCountX);
  if (copies <= 0) return NO_REACH;
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

/**
 * Transmute's time route moves each band by up to its amount, in beats, and
 * reads where it lands. The move is centred, so it goes both ways.
 */
function transmuteReach(effect: State, ctx: ReachContext): TimeReach {
  if (Number(effect.transmuteTo) !== TRANSMUTE_TO_TIME) return NO_REACH;
  const span = widest(stateRange(effect, "transmuteAmount")) * (60 / ctx.bpm);
  return { before: span, after: span };
}

/**
 * Attract's time pass gathers only bins the brush covers. What leaves the
 * brush is the field it reads to decide where they land, and the kernel holds
 * that to the smoothing either side.
 */
function attractReach(effect: State, ctx: ReachContext): TimeReach {
  const map = Number(effect.attractMap);
  if (map !== ATTRACT_MAP_SOURCE && map < ATTRACT_MAP_FIRST_MODULATOR) return NO_REACH;
  if (widest(stateRange(effect, "attractAmountX")) === 0) return NO_REACH;
  const span = ATTRACT_KERNEL_TAPS * widest(stateRange(effect, "attractSmoothX")) * (60 / ctx.bpm);
  return { before: span, after: span };
}

/**
 * Evolve reads a neighbourhood around each point and flows it upstream, both
 * measured against the neighbourhood Scale sets.
 */
function evolveReach(effect: State, ctx: ReachContext): TimeReach {
  const beats = (widest(stateRange(effect, "evolveScaleX")) / 100) * EVOLVE_SCALE_FULL_BEATS;
  const span = EVOLVE_REACH_NEIGHBOURHOODS * beats * (60 / ctx.bpm);
  return { before: span, after: span };
}

/**
 * Convolve walks the response one bin per tap, and each tap steps the read
 * through the file it filters by that bin's own length of real time, scaled by
 * Rate. The taps cannot outrun the response either, so its length bounds them
 * as well. Rate's sign decides which way they run, so a rate that cannot change
 * sign reaches one way only.
 */
function convolveReach(effect: State, ctx: ReachContext): TimeReach {
  const response = ctx.responseSpan?.(responsePath(effect)) ?? null;
  if (!response) return NO_REACH;
  const taps = Math.max(1, Math.floor(Number(effect.convolveIrSize)));
  const span = Math.min(taps * response.binSeconds, response.seconds);
  const rate = stateRange(effect, "convolveIrRate");
  return { before: Math.max(0, rate.hi) * span, after: Math.max(0, -rate.lo) * span };
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
 * span. Effects that read only the texel they write are absent.
 */
export function brushReaches(state: State, ctx: ReachContext): StepReach[] {
  const out: StepReach[] = [];
  for (const { effect, view, step, repeats } of chainedEffects(state)) {
    const span = brushSpan(createStepStateView(state, step), ctx);
    let reach = NO_REACH;
    if (effect === "blur") reach = blurReach(view, ctx);
    else if (effect === "clone") reach = cloneReach(view, ctx);
    else if (effect === "transform") reach = transformReach(view, ctx, span.seconds, span.pitchUv);
    else if (effect === "transmute") reach = transmuteReach(view, ctx);
    else if (effect === "attract") reach = attractReach(view, ctx);
    else if (effect === "evolve") reach = evolveReach(view, ctx);
    else if (effect === "convolve") reach = convolveReach(view, ctx);
    if (reach.before <= 0 && reach.after <= 0) continue;
    out.push({ effect, step, brushSeconds: span.seconds, reach, repeats });
  }
  return out;
}

/** True while the range holds only `value`. */
function only(range: ValueRange, value: number): boolean {
  return range.lo === value && range.hi === value;
}

/**
 * How far from each pixel it paints one effect reads, in seconds of the file,
 * or null when it may read anywhere in the brush: a warp that scales, turns or
 * mirrors, a sort along time, and any read an edge mode wraps round to the
 * brush's far end.
 */
function pieceReachOf(effect: EffectType, state: State, ctx: ReachContext): TimeReach | null {
  switch (effect) {
    case "blur": {
      const smear = blurSmear(state, ctx);
      const wraps = Number(state.blurEdgeMode) === WRAP_EDGE && (smear.before > 0 || smear.after > 0);
      return wraps ? null : smear;
    }
    case "clone": {
      const taps = cloneTaps(state, ctx);
      const wraps = Number(state.cloneEdgeMode) === WRAP_EDGE && (taps.before > 0 || taps.after > 0);
      return wraps ? null : taps;
    }
    case "transform": {
      const warps =
        !only(stateRange(state, "transformScaleTime"), 1) ||
        !only(stateRange(state, "transformSpeed"), 1) ||
        !only(stateRange(state, "transformRotation"), 0);
      const shift = widest(stateRange(state, "transformShiftBeats")) * (60 / ctx.bpm);
      if (warps || (shift > 0 && Number(state.transformEdgeMode) === WRAP_EDGE)) return null;
      return { before: shift, after: shift };
    }
    case "sort": {
      if (!SORTS_ALONG_TIME.has(Number(state.sortDirection))) return NO_REACH;
      const span = SORT_TIME_BINS * (ctx.binSeconds ?? 0);
      return { before: span, after: span };
    }
    case "attract": {
      if (widest(stateRange(state, "attractAmountX")) === 0) return NO_REACH;
      const span = ATTRACT_PIECE_KERNELS * widest(stateRange(state, "attractSmoothX")) * (60 / ctx.bpm);
      return { before: span, after: span };
    }
    case "transmute":
      return transmuteReach(state, ctx);
    case "evolve":
      return evolveReach(state, ctx);
    case "convolve":
      return convolveReach(state, ctx);
    default:
      return NO_REACH;
  }
}

/**
 * How far from each pixel it paints the brush reads, in seconds of the file:
 * what a dab painted a piece at a time must hold around each piece. Null
 * when some effect may read anywhere in the brush, so only the whole dab at
 * once can serve it.
 */
export function pieceReach(state: State, ctx: ReachContext): TimeReach | null {
  let before = 0;
  let after = 0;
  for (const { effect, view, repeats } of chainedEffects(state)) {
    const reach = pieceReachOf(effect, view, ctx);
    if (!reach) return null;
    before += reach.before * repeats;
    after += reach.after * repeats;
  }
  return { before, after };
}

/**
 * Every enabled effect of the brush in the order it runs, with how many times
 * it runs. Each reads what the one before it wrote, so reaches along the
 * chain add up.
 */
function chainedEffects(state: State): { effect: EffectType; view: State; step: number; repeats: number }[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const out: { effect: EffectType; view: State; step: number; repeats: number }[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    const repeats = Math.max(1, Math.floor(Number(step.brushIterations) || 1));
    for (const item of step.effects) {
      if (item.enabled)
        out.push({ effect: item.effect, view: createEffectStateView(state, index, item), step: index, repeats });
    }
  }
  return out;
}

// The Transmute route that moves a band across pitch.
const TRANSMUTE_TO_PITCH = 3;

/**
 * How far across pitch, in semitones, one effect reads from a band it
 * writes, or null when it may read any band.
 */
function pitchReachOf(effect: EffectType, state: State, bandsPerOctave: number): number | null {
  switch (effect) {
    case "transform": {
      // A turn or a pitch scale reads about the pivot, within the brush's
      // height scaled by the pitch scale.
      const shift = widest(stateRange(state, "transformShiftSemis"));
      const scale = narrowest(stateRange(state, "transformScalePitch"));
      if (only(stateRange(state, "transformScalePitch"), 1) && only(stateRange(state, "transformRotation"), 0))
        return shift;
      if (scale <= NO_SCALE_BELOW) return null;
      return shift + widest(stateRange(state, "brushSizePitch")) * Math.max(1, 1 / scale);
    }
    case "blur":
      return ((widest(stateRange(state, "blurAmountPitch")) + widest(stateRange(state, "blurNoisePitch"))) / 100) * 12;
    case "clone":
      return Number(state.cloneCountY) * widest(stateRange(state, "cloneSpaceSemis"));
    case "evolve":
      return (EVOLVE_REACH_NEIGHBOURHOODS * widest(stateRange(state, "evolveScaleY")) * EVOLVE_SCALE_FULL_SEMIS) / 100;
    case "attract":
      return widest(stateRange(state, "attractAmountY")) === 0
        ? 0
        : ATTRACT_PIECE_KERNELS * widest(stateRange(state, "attractSmoothY"));
    case "transmute":
      return Number(state.transmuteTo) === TRANSMUTE_TO_PITCH ? null : 0;
    case "convolve":
      return widest(stateRange(state, "convolveIrPitchShift"));
    case "sort":
      return SORTS_ALONG_PITCH.has(Number(state.sortDirection)) ? (SORT_PITCH_BANDS * 12) / bandsPerOctave : 0;
    default:
      return 0;
  }
}

/**
 * How far across pitch, in semitones, the brush reads from the bands it
 * writes, or null when some effect may read any band.
 */
export function pitchReach(state: State, bandsPerOctave: number): number | null {
  let reach = 0;
  for (const { effect, view, repeats } of chainedEffects(state)) {
    const semis = pitchReachOf(effect, view, bandsPerOctave);
    if (semis === null) return null;
    reach += semis * repeats;
  }
  return reach;
}

/**
 * How many bands either side of the bands it writes the brush reads, with one
 * more for reads between bands, or null when some effect may read any band.
 */
export function pitchReachBands(state: State, bandsPerOctave: number): number | null {
  const semis = pitchReach(state, bandsPerOctave);
  if (semis === null) return null;
  return semis === 0 ? 0 : Math.ceil((semis * bandsPerOctave) / 12) + 1;
}

/** A region of the file: seconds [start, end) along time and pitch UV [low, high] across it. */
export type ReadBox = { start: number; end: number; low: number; high: number };

// The edge modes that fold a read past the brush back inside it rather than
// zero it or let it through: Wrap, Clamp and Reflect.
const FOLDS_INTO_BRUSH: ReadonlySet<number> = new Set([2, 3, 4]);

// Semitones a scale snap can move a transform's pitch shift either way.
const SNAP_SEMIS = 6;

/**
 * The region of the file the brush reads to paint `box`, where `brushes`
 * holds each step's own brush. Effects run one after another, so the region
 * is worked out from the last effect back: each widens what the one after it
 * reads by what it reads around each pixel, or maps it through its warp.
 *
 * A warp that is the brush's first effect, run once, reads the file only
 * where it samples the first step's input, so that read is set apart:
 * `input` is where it samples, and `own` what the rest of the brush reads.
 * `input` is null when the first effect is no such warp.
 */
export function readBoxes(
  state: State,
  ctx: ReachContext,
  box: ReadBox,
  brushes: readonly ReadBox[],
): { own: ReadBox; input: ReadBox | null } {
  const chain = chainedEffects(state);
  const [first] = chain;
  const apart = !!first && first.step === 0 && first.repeats === 1 && first.effect === "transform" && warps(first.view);
  let region = box;
  for (let i = chain.length - 1; i >= (apart ? 1 : 0); i--) {
    const { effect, view, step, repeats } = chain[i];
    const brush = brushes[step] ?? region;
    for (let r = 0; r < repeats; r++) region = effectReadBox(effect, view, ctx, region, brush);
  }
  if (!apart) return { own: region, input: null };
  return { own: region, input: clampBox(warpBox(first.view, ctx, region, brushes[0] ?? region), ctx) };
}

/** What one effect reads to paint `box`, within its step's `brush`. */
function effectReadBox(effect: EffectType, view: State, ctx: ReachContext, box: ReadBox, brush: ReadBox): ReadBox {
  if (effect === "transform" && warps(view)) return clampBox(unionBox(box, warpBox(view, ctx, box, brush)), ctx);
  const time = pieceReachOf(effect, view, ctx);
  const semis = pitchReachOf(effect, view, ctx.bandsPerOctave);
  // A read across pitch lands between bands, so it takes one band more.
  const pitch = semis === null ? 1 : semis === 0 ? 0 : semitonesToUv(semis, ctx) + 1 / ctx.numBands;
  return clampBox(
    {
      start: time ? box.start - time.before : Math.min(box.start, brush.start),
      end: time ? box.end + time.after : Math.max(box.end, brush.end),
      low: box.low - pitch,
      high: box.high + pitch,
    },
    ctx,
  );
}

/** True when a transform scales, turns or mirrors rather than only shifting. */
function warps(view: State): boolean {
  return (
    !only(stateRange(view, "transformScaleTime"), 1) ||
    !only(stateRange(view, "transformScalePitch"), 1) ||
    !only(stateRange(view, "transformSpeed"), 1) ||
    !only(stateRange(view, "transformRotation"), 0)
  );
}

/**
 * Where a transform reads to paint `box`: every corner turned about the pivot
 * by each turn it can take, divided by each scale, and shifted, as the shader
 * maps a pixel. A turn is taken with time measured in lengths of the file.
 * A read the edge mode folds back or zeroes stays within the brush.
 */
function warpBox(view: State, ctx: ReachContext, box: ReadBox, brush: ReadBox): ReadBox {
  const edge = Number(view.transformEdgeMode);
  const inside = !READS_PAST_BRUSH.has(edge);
  if (FOLDS_INTO_BRUSH.has(edge)) return brush;
  const speed = stateRange(view, "transformSpeed");
  const scaleTime = stateRange(view, "transformScaleTime");
  const scalePitch = stateRange(view, "transformScalePitch");
  if ([speed, scaleTime, scalePitch].some((range) => narrowest(range) <= NO_SCALE_BELOW)) {
    return inside ? brush : { start: 0, end: ctx.fileSeconds, low: 0, high: 1 };
  }
  const rotation = valueRange(view, "transformRotation", Number(view.transformRotation ?? 0), { min: -180, max: 180 });
  const turns = [rotation.lo, rotation.hi];
  for (let quarter = Math.ceil(rotation.lo / 90); quarter * 90 <= rotation.hi; quarter++) turns.push(quarter * 90);
  const originTime = originFraction(Number(view.transformOriginTime));
  const originPitch = originFraction(Number(view.transformOriginPitch));
  const pivotTime = brush.start + originTime * (brush.end - brush.start);
  const pivotPitch = brush.low + originPitch * (brush.high - brush.low);
  const beat = 60 / ctx.bpm;
  const shiftTime = stateRange(view, "transformShiftBeats");
  const shiftSemis = stateRange(view, "transformShiftSemis");
  const snap = Number(view.gridSizeSemis) <= 0 && Boolean(view.snapPitch) ? SNAP_SEMIS : 0;
  const speedSemis = [12 * Math.log2(speed.lo), 12 * Math.log2(speed.hi)];
  let out: ReadBox | null = null;
  for (const turn of turns) {
    const cos = Math.cos((turn * Math.PI) / 180);
    const sin = Math.sin((turn * Math.PI) / 180);
    for (const sx of [
      scaleTime.lo / speed.lo,
      scaleTime.lo / speed.hi,
      scaleTime.hi / speed.lo,
      scaleTime.hi / speed.hi,
    ]) {
      for (const sy of [scalePitch.lo, scalePitch.hi]) {
        for (const t of [box.start, box.end]) {
          for (const y of [box.low, box.high]) {
            const relTime = (t - pivotTime) / ctx.fileSeconds;
            const relPitch = y - pivotPitch;
            let time = pivotTime + ((cos * relTime - sin * relPitch) / sx) * ctx.fileSeconds;
            let pitch = pivotPitch + (sin * relTime + cos * relPitch) / sy;
            if (sx < 0) time += (1 - 2 * originTime) * (brush.end - brush.start);
            if (sy < 0) pitch += (1 - 2 * originPitch) * (brush.high - brush.low);
            const read: ReadBox = {
              start: time - shiftTime.hi * beat,
              end: time - shiftTime.lo * beat,
              low: pitch - semitonesToUv(shiftSemis.hi + Math.max(...speedSemis) + snap, ctx) - 1 / ctx.numBands,
              high: pitch - semitonesToUv(shiftSemis.lo + Math.min(...speedSemis) - snap, ctx) + 1 / ctx.numBands,
            };
            out = out ? unionBox(out, read) : read;
          }
        }
      }
    }
  }
  const warped = out ?? box;
  return inside ? (intersectBox(warped, brush) ?? box) : warped;
}

function semitonesToUv(semis: number, ctx: ReachContext): number {
  return (semis * ctx.bandsPerOctave) / 12 / ctx.numBands;
}

/** The smallest region holding both. */
export function unionBox(a: ReadBox, b: ReadBox): ReadBox {
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    low: Math.min(a.low, b.low),
    high: Math.max(a.high, b.high),
  };
}

function intersectBox(a: ReadBox, b: ReadBox): ReadBox | null {
  const out = {
    start: Math.max(a.start, b.start),
    end: Math.min(a.end, b.end),
    low: Math.max(a.low, b.low),
    high: Math.min(a.high, b.high),
  };
  return out.end > out.start && out.high > out.low ? out : null;
}

function clampBox(box: ReadBox, ctx: ReachContext): ReadBox {
  return {
    start: Math.max(0, box.start),
    end: Math.min(ctx.fileSeconds, box.end),
    low: Math.max(0, box.low),
    high: Math.min(1, box.high),
  };
}

/**
 * The furthest any enabled effect in the brush reads either side of the dab's
 * own span, in seconds of the file.
 */
export function strokeReach(state: State, ctx: ReachContext): TimeReach {
  let before = 0;
  let after = 0;
  for (const entry of brushReaches(state, ctx)) {
    before += entry.reach.before * entry.repeats;
    after += entry.reach.after * entry.repeats;
  }
  return { before, after };
}
