import { buildShapeTable, type CloneShapeKey } from "@renderer/effects/clone-shapes";
import type { EffectType } from "@renderer/effects/types";
import { EVOLVE_SCALE_FULL_BEATS, EVOLVE_SCALE_FULL_SEMIS, NUM_MODULATORS } from "@renderer/lib/constants";
import { impulseKey, responsePath } from "@renderer/lib/impulse-key";
import { modulatedRange, type ValueRange } from "@renderer/lib/modulation-range";
import { originFraction, resolveBrushFootprint } from "@renderer/lib/utils";
import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { ParameterKey, State } from "@renderer/store/types";

/** Seconds of the file an effect reads either side of the brush's own span. */
export type TimeReach = { before: number; after: number };

/** How long a file is, and how much real time its coarsest stored bin covers. */
export type FileSpan = {
  seconds: number;
  binSeconds: number;
  /** Seconds one bin lasts in the band that holds `hz`. */
  binSecondsAt?: (hz: number) => number;
  /** The band that holds `hz`, within the file's bands. */
  bandAt?: (hz: number) => number;
};

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
  /** The frequency of the file's lowest band. */
  minFreq?: number;
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

// The Transmute route that moves a band across pitch.
const TRANSMUTE_TO_PITCH = 3;

// Attract maps whose pull follows a field the shader reads off a spectrogram:
// Source, and the three modulators. Scale and Grid pull toward a lattice the
// shader works out, and read nothing.
const ATTRACT_MAP_SOURCE = 0;
const ATTRACT_MAP_FIRST_MODULATOR = 3;

// The field lattice rounds the kernel up to its next tap, and a tap is a
// quarter of the smoothing, so the read passes the smoothing by a little.
const ATTRACT_KERNEL_TAPS = 2;

// Neighbourhoods the flow step may carry a read, which the shader caps it at.
// Its gradient taps read one neighbourhood out, inside that.
const EVOLVE_FLOW_NEIGHBOURHOODS = 8;

/** The range a parameter's value can take once every source that drives it moves it. */
function valueRange(state: State, key: ParameterKey, value: number, range?: { min: number; max: number }): ValueRange {
  return modulatedRange(state, key, value, range);
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

// The modulator mode that follows the level of the step's input.
const MODULATOR_ENVELOPE = 1;

/**
 * Seconds either side of a texel an envelope-following modulator of the step
 * reads its input: half its smoothing window, and a quarter of a beat for a
 * full stereo spread. Every pass of the step samples its modulators.
 */
function envelopeReach(step: State, ctx: ReachContext): TimeReach {
  const beat = 60 / ctx.bpm;
  let reach = 0;
  for (let i = 1; i <= NUM_MODULATORS; i++) {
    if (Number(step[`modulator${i}Mode` as ParameterKey]) !== MODULATOR_ENVELOPE) continue;
    const smoothing = (Number(step[`modulator${i}EnvelopeSmoothingBeats` as ParameterKey] ?? 0) * beat) / 2;
    const spread = (widest(stateRange(step, `modulator${i}StereoSpread` as ParameterKey)) / 100) * 0.25 * beat;
    reach = Math.max(reach, smoothing + spread);
  }
  return { before: reach, after: reach };
}

/** `reach` widened by what the step's envelope followers read around each texel. */
function withEnvelope(reach: TimeReach, step: State, ctx: ReachContext): TimeReach {
  const envelope = envelopeReach(step, ctx);
  return { before: reach.before + envelope.before, after: reach.after + envelope.after };
}

/** Tap position in gap units, as the repeat shader interpolates its shape table. */
function tapAt(table: number[], index: number): number {
  const last = table.length - 1;
  if (last < 0) return 0;
  const i0 = Math.min(Math.max(0, Math.floor(index)), last);
  const i1 = Math.min(i0 + 1, last);
  return Math.abs(table[i0] + (table[i1] - table[i0]) * Math.min(1, Math.max(0, index - i0)));
}

// Semitones a full Blur ↕ smears, and a full noise moves a read: a fifth of that.
const BLUR_FULL_SEMIS = 12;
const BLUR_NOISE_FULL_SEMIS = BLUR_FULL_SEMIS / 5;

/** A smear reads past the brush only where the edge mode lets it. */
function blurReach(effect: State, ctx: ReachContext): TimeReach {
  if (!READS_PAST_BRUSH.has(Number(effect.blurEdgeMode))) return NO_REACH;
  return blurSmear(effect, ctx);
}

/**
 * How far the smear reads either side of a pixel, wherever the edge mode sends
 * it: a full Blur ↔ is four beats and a full noise a fifth of that, modulated
 * or not. Origin makes it one-sided.
 */
function blurSmear(effect: State, ctx: ReachContext): TimeReach {
  const beat = 60 / ctx.bpm;
  const smear = (widest(stateRange(effect, "blurAmountTime")) / 100) * 4 * beat;
  const noise = (widest(stateRange(effect, "blurNoiseTime")) / 100) * 0.8 * beat;
  const span = smear + noise;
  const origin = Number(effect.blurOrigin);
  return { before: origin === 2 ? 0 : span, after: origin === 0 ? 0 : span };
}

/** Copies are read at whole multiples of the gap, spaced by the shape table. */
function cloneReach(effect: State, ctx: ReachContext): TimeReach {
  if (!READS_PAST_BRUSH.has(Number(effect.cloneEdgeMode))) return NO_REACH;
  return cloneTaps(effect, ctx);
}

/**
 * Every tap's step from the original, in Gap units, as the shader walks one
 * axis's copies: Forward steps out one way, Backward the other, and Middle
 * spreads half each way, at half indices of the shape table.
 */
function cloneTapSteps(shape: CloneShapeKey, copies: number, direction: number): number[] {
  const count = Math.min(64, Math.max(1, copies + 1));
  const table = buildShapeTable(shape, count);
  return Array.from({ length: count }, (_, s) => {
    const index = direction === 0 ? s : direction === 2 ? -s : s - (count - 1) / 2;
    return tapAt(table, Math.abs(index)) * Math.sign(index);
  });
}

/**
 * How far the furthest copy along time is read from a pixel, each way. A tap
 * `k` Gap steps out reads the gap times `k` before the pixel, so a negative
 * gap or a backward step reads after it.
 */
function cloneTaps(effect: State, ctx: ReachContext): TimeReach {
  const copies = Number(effect.cloneCountX);
  if (copies <= 0) return NO_REACH;
  const gap = stateRange(effect, "cloneSpaceBeats");
  const beat = 60 / ctx.bpm;
  let before = 0;
  let after = 0;
  for (const step of cloneTapSteps(effect.cloneShapeX as CloneShapeKey, copies, Number(effect.cloneDirectionX))) {
    for (const g of [gap.lo, gap.hi]) {
      const read = -step * g * beat;
      before = Math.max(before, -read);
      after = Math.max(after, read);
    }
  }
  return { before, after };
}

/** Semitones the furthest copy across pitch is read from a pixel, either way. */
function cloneTapSemis(effect: State): number {
  const copies = Number(effect.cloneCountY);
  if (copies <= 0) return 0;
  const shape = effect.cloneShapeY as CloneShapeKey;
  const steps = cloneTapSteps(shape, copies, Number(effect.cloneDirectionY));
  const furthest = Math.max(...steps.map(Math.abs));
  return furthest * widest(stateRange(effect, "cloneSpaceSemis")) + (shape === "scale" ? SNAP_SEMIS : 0);
}

/**
 * The warp reads at the pivot plus the brush arm, turned, scaled and shifted. A
 * turn lays a semitone of pitch onto a beat of time. A scale that can pass
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
  const pitchArmSemis = uvToSemitones(Math.max(pitchPivot, brushPitchUv - pitchPivot), ctx);
  const turn = (turnAmount * pitchArmSemis * (60 / ctx.bpm)) / divisor;
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

/** Neighbourhoods Evolve reads from a point: one for its gradient taps, and the flow step's cap while Flow can move it. */
function evolveNeighbourhoods(effect: State): number {
  return only(stateRange(effect, "evolveFlow"), 0) ? 1 : EVOLVE_FLOW_NEIGHBOURHOODS;
}

/** Evolve reads past the brush only where the edge mode lets it. */
function evolveReach(effect: State, ctx: ReachContext): TimeReach {
  if (!READS_PAST_BRUSH.has(Number(effect.evolveEdgeMode))) return NO_REACH;
  return evolveSmear(effect, ctx);
}

/**
 * How far Evolve reads around a point, wherever the edge mode sends it: its
 * neighbourhood, measured by Scale, times the neighbourhoods it reads.
 */
function evolveSmear(effect: State, ctx: ReachContext): TimeReach {
  const beats = (widest(stateRange(effect, "evolveScaleX")) / 100) * EVOLVE_SCALE_FULL_BEATS;
  const span = evolveNeighbourhoods(effect) * beats * (60 / ctx.bpm);
  return { before: span, after: span };
}

/**
 * Convolve walks the response one bin per tap from IR Start, and each tap
 * steps the read through the file it filters by that bin's own length of real
 * time, scaled by Rate. Tap 0 reads the pixel itself, and a tap past the end of
 * the response is skipped, so the last tap that reads sits one tap short of
 * IR Size and inside what the response holds after IR Start. Rate's sign
 * decides which way they run, so a rate that cannot change sign reaches one
 * way only.
 */
function convolveReach(effect: State, ctx: ReachContext): TimeReach {
  const response = ctx.responseSpan?.(responsePath(effect)) ?? null;
  if (!response) return NO_REACH;
  const taps = Math.max(1, Math.floor(Number(effect.convolveIrSize)));
  const start = stateRange(effect, "convolveIrTimeOffset").lo / 100;
  const span = Math.min((taps - 1) * response.binSeconds, response.seconds * Math.max(0, 1 - start));
  const rate = stateRange(effect, "convolveIrRate");
  return { before: Math.max(0, rate.hi) * span, after: Math.max(0, -rate.lo) * span };
}

// The edge mode that zeroes every read past the brush.
const CUT_EDGE = 0;

/**
 * The frequencies at which the pixels of `region` read the response: each band
 * reads the response's band at its own frequency, moved by IR Pitch Shift.
 * The response's bands and bin lengths change monotonically with frequency,
 * so the extremes bound every band between.
 */
function convolveResponseHz(view: State, ctx: ReachContext, region: ReadBox): number[] {
  const hzAt = (pitchUv: number): number =>
    (ctx.minFreq ?? 1) * 2 ** ((pitchUv * ctx.numBands - 0.5) / ctx.bandsPerOctave);
  const shift = stateRange(view, "convolveIrPitchShift");
  return [hzAt(region.low), hzAt(region.high)].flatMap((f) => [f * 2 ** (-shift.hi / 12), f * 2 ** (-shift.lo / 12)]);
}

/** The brush's own span on each axis, in file seconds and in pitch UV. */
function brushSpan(step: State, ctx: ReachContext): BrushSpan {
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

/** The brush's own span on one step: seconds of the file along time, pitch UV across it. */
type BrushSpan = { seconds: number; pitchUv: number };

/**
 * What one effect reads around the pixels it writes. Every pass of the effect
 * counts, and what its modulators' envelope followers read is added on top.
 */
type EffectReach = {
  /** Seconds it reads past the brush's own span, either side. */
  pastBrush: (view: State, ctx: ReachContext, brush: BrushSpan) => TimeReach;
  /** Seconds it reads either side of each pixel, or null when it may read anywhere in the brush. */
  aroundPixel: (view: State, ctx: ReachContext) => TimeReach | null;
  /** Semitones it reads either side of each band, or null when it may read any band. */
  acrossPitch: (view: State, bandsPerOctave: number) => number | null;
  /**
   * Its reads of the input set apart, to paint `region` within `brush`, when
   * they may need more than one view; absent or null when it reads as any
   * other effect does.
   */
  apart?: (view: State, ctx: ReachContext, region: ReadBox, brush: BrushBox) => FarRead | null;
};

/**
 * How an effect that may read further than one window holds is read in parts,
 * when it is the brush's first effect and runs once: `own` is what the brush
 * reads besides those reads, through the view it paints on.
 */
export type FarRead =
  /**
   * Each channel of a pixel takes its value from one read point of the input,
   * which `far` holds every one of; `near` is what else it reads of the input,
   * which every part must hold.
   */
  | { kind: "point"; own: ReadBox; near: ReadBox | null; far: ReadBox }
  /**
   * The effect sums reads of the input tap by tap, and `taps` holds each
   * tap's. An effect that weighs each tap by a file it filters through names
   * that file in `response`, with the seconds of it each tap reads.
   */
  | {
      kind: "sum";
      own: ReadBox;
      taps: ReadBox[];
      response?: { key: string; reads: TimeSpan[]; bands: { first: number; last: number } };
    };

/** Seconds [start, end) of a file. */
export type TimeSpan = { start: number; end: number };

/** An effect that reads only the pixel it writes. */
const OWN_PIXEL: EffectReach = { pastBrush: () => NO_REACH, aroundPixel: () => NO_REACH, acrossPitch: () => 0 };

/**
 * Every effect's reach. A long file is painted in tiles that hold only what
 * this says a dab reads, so a reach set too small paints wrong values there
 * and nowhere else.
 */
const EFFECT_REACH: Record<EffectType, EffectReach> = {
  dynamics: OWN_PIXEL,
  synthesize: OWN_PIXEL,
  passthrough: OWN_PIXEL,
  binaural: OWN_PIXEL,
  waveshape: OWN_PIXEL,
  align: OWN_PIXEL,
  blur: {
    pastBrush: blurReach,
    aroundPixel: (view, ctx) => {
      const smear = blurSmear(view, ctx);
      const wraps = Number(view.blurEdgeMode) === WRAP_EDGE && (smear.before > 0 || smear.after > 0);
      return wraps ? null : smear;
    },
    acrossPitch: (view) =>
      (widest(stateRange(view, "blurAmountPitch")) / 100) * BLUR_FULL_SEMIS +
      (widest(stateRange(view, "blurNoisePitch")) / 100) * BLUR_NOISE_FULL_SEMIS,
  },
  clone: {
    pastBrush: cloneReach,
    aroundPixel: (view, ctx) => {
      const taps = cloneTaps(view, ctx);
      const wraps = Number(view.cloneEdgeMode) === WRAP_EDGE && (taps.before > 0 || taps.after > 0);
      return wraps ? null : taps;
    },
    acrossPitch: cloneTapSemis,
    // A repeat reads its input only where its copies along time land.
    apart: (view, ctx, region, brush) => {
      if (Number(view.cloneCountX) <= 0 || !READS_PAST_BRUSH.has(Number(view.cloneEdgeMode))) return null;
      const own = repeatOwnBox(view, ctx, region, brush);
      return { kind: "sum", own, taps: repeatTapBoxes(view, ctx, own, brush) };
    },
  },
  transform: {
    pastBrush: (view, ctx, brush) => transformReach(view, ctx, brush.seconds, brush.pitchUv),
    // Only a shift reads a fixed distance away; a warp that scales, turns or
    // mirrors may read anywhere in the brush.
    aroundPixel: (view, ctx) => {
      const warps =
        !only(stateRange(view, "transformScaleTime"), 1) ||
        !only(stateRange(view, "transformSpeed"), 1) ||
        !only(stateRange(view, "transformRotation"), 0);
      const shift = widest(stateRange(view, "transformShiftBeats")) * (60 / ctx.bpm);
      if (warps || (shift > 0 && Number(view.transformEdgeMode) === WRAP_EDGE)) return null;
      return { before: shift, after: shift };
    },
    // A pitch scale reads about the pivot, within the brush's height scaled by
    // the pitch scale. A turn brings time into pitch, by as much as the brush
    // is long, so it may read any band.
    acrossPitch: (view) => {
      const shift = widest(stateRange(view, "transformShiftSemis"));
      const scale = narrowest(stateRange(view, "transformScalePitch"));
      if (!only(stateRange(view, "transformRotation"), 0)) return null;
      if (only(stateRange(view, "transformScalePitch"), 1)) return shift;
      if (scale <= NO_SCALE_BELOW) return null;
      return shift + widest(stateRange(view, "brushSizePitch")) * Math.max(1, 1 / scale);
    },
    // A warp reads its input only where it samples. Locked also reads it under
    // the pixel it writes, which the view it paints on holds.
    apart: (view, ctx, region, brush) => {
      if (!moves(view)) return null;
      return {
        kind: "point",
        own: fitBox(withEnvelopeBox(region, view, ctx), brush, ctx),
        near: null,
        far: fitBox(warpBox(view, ctx, region, brush), brush, ctx),
      };
    },
  },
  sort: {
    pastBrush: () => NO_REACH,
    aroundPixel: (view, ctx) => {
      if (!SORTS_ALONG_TIME.has(Number(view.sortDirection))) return NO_REACH;
      const span = SORT_TIME_BINS * (ctx.binSeconds ?? 0);
      return { before: span, after: span };
    },
    acrossPitch: (view, bandsPerOctave) =>
      SORTS_ALONG_PITCH.has(Number(view.sortDirection)) ? (SORT_PITCH_BANDS * 12) / bandsPerOctave : 0,
  },
  attract: {
    pastBrush: attractReach,
    aroundPixel: (view, ctx) => {
      if (widest(stateRange(view, "attractAmountX")) === 0) return NO_REACH;
      const span = ATTRACT_PIECE_KERNELS * widest(stateRange(view, "attractSmoothX")) * (60 / ctx.bpm);
      return { before: span, after: span };
    },
    acrossPitch: (view) =>
      widest(stateRange(view, "attractAmountY")) === 0
        ? 0
        : ATTRACT_PIECE_KERNELS * widest(stateRange(view, "attractSmoothY")),
  },
  transmute: {
    pastBrush: transmuteReach,
    aroundPixel: transmuteReach,
    acrossPitch: (view) => (Number(view.transmuteTo) === TRANSMUTE_TO_PITCH ? null : 0),
  },
  evolve: {
    pastBrush: evolveReach,
    aroundPixel: (view, ctx) => {
      const smear = evolveSmear(view, ctx);
      const wraps = Number(view.evolveEdgeMode) === WRAP_EDGE && smear.before > 0;
      return wraps ? null : smear;
    },
    acrossPitch: (view) =>
      (evolveNeighbourhoods(view) * widest(stateRange(view, "evolveScaleY")) * EVOLVE_SCALE_FULL_SEMIS) / 100,
    // While Flow can move it, each channel of a pixel takes its value from one
    // advected read; its gradient taps read one neighbourhood around the pixel.
    apart: (view, ctx, region, brush) => {
      if (only(stateRange(view, "evolveFlow"), 0)) return null;
      const edge = Number(view.evolveEdgeMode);
      if (FOLDS_INTO_BRUSH.has(edge)) return null;
      const seconds = (widest(stateRange(view, "evolveScaleX")) / 100) * EVOLVE_SCALE_FULL_BEATS * (60 / ctx.bpm);
      const semis = (widest(stateRange(view, "evolveScaleY")) / 100) * EVOLVE_SCALE_FULL_SEMIS;
      const around = (neighbourhoods: number): ReadBox => {
        const pitch = semis === 0 ? 0 : semitonesToUv(neighbourhoods * semis, ctx) + 1 / ctx.numBands;
        const read = fitBox(
          {
            start: region.start - neighbourhoods * seconds,
            end: region.end + neighbourhoods * seconds,
            low: region.low - pitch,
            high: region.high + pitch,
          },
          brush,
          ctx,
        );
        return READS_PAST_BRUSH.has(edge) ? read : (intersectBox(read, brush) ?? region);
      };
      return {
        kind: "point",
        own: fitBox(withEnvelopeBox(region, view, ctx), brush, ctx),
        near: around(1),
        far: around(EVOLVE_FLOW_NEIGHBOURHOODS),
      };
    },
  },
  convolve: {
    pastBrush: convolveReach,
    aroundPixel: convolveReach,
    acrossPitch: () => 0,
    // Each tap reads the input a whole number of response bins away, and that
    // tap's bin of the response, so a group of taps reads both only there.
    apart: (view, ctx, region, brush) => {
      if (FOLDS_INTO_BRUSH.has(Number(view.convolveEdgeMode))) return null;
      const response = ctx.responseSpan?.(responsePath(view)) ?? null;
      if (!response?.binSecondsAt || !response.bandAt) return null;
      const bandAt = response.bandAt;
      const hz = convolveResponseHz(view, ctx, region);
      const seconds = hz.map(response.binSecondsAt);
      const bins = { min: Math.min(...seconds), max: Math.max(...seconds) };
      const bands = hz.map(bandAt);
      const start = stateRange(view, "convolveIrTimeOffset");
      const rate = stateRange(view, "convolveIrRate");
      const first = Math.max(0, start.lo / 100) * response.seconds;
      const last = Math.min(1, Math.max(0, start.hi / 100)) * response.seconds;
      const own = fitBox(withEnvelopeBox(region, view, ctx), brush, ctx);
      const cut = Number(view.convolveEdgeMode) === CUT_EDGE;
      const taps: ReadBox[] = [];
      const reads: TimeSpan[] = [];
      const count = Math.max(1, Math.floor(Number(view.convolveIrSize)));
      // Tap k moves its read by k times the rate times the bin; these bound it.
      const products = [rate.lo * bins.min, rate.lo * bins.max, rate.hi * bins.min, rate.hi * bins.max];
      const least = Math.min(...products);
      const most = Math.max(...products);
      for (let k = 0; k < count && first + k * bins.min < response.seconds; k++) {
        const read = fitBox({ ...own, start: own.start - k * most, end: own.end - k * least }, brush, ctx);
        taps.push(cut ? (intersectBox(read, brush) ?? own) : read);
        reads.push({
          start: Math.min(response.seconds, first + k * bins.min),
          end: Math.min(response.seconds, last + (k + 1) * bins.max),
        });
      }
      // A read between bands takes the band either side.
      return {
        kind: "sum",
        own,
        taps,
        response: {
          key: impulseKey(view),
          reads,
          bands: { first: Math.min(...bands) - 1, last: Math.max(...bands) + 1 },
        },
      };
    },
  },
};

/**
 * The reach of every enabled effect in the brush that reads past the dab's own
 * span. Effects that read only the texel they write are absent.
 */
export function brushReaches(state: State, ctx: ReachContext): StepReach[] {
  const out: StepReach[] = [];
  for (const { effect, view, step, repeats } of chainedEffects(state)) {
    const span = brushSpan(createStepStateView(state, step), ctx);
    const reach = withEnvelope(EFFECT_REACH[effect].pastBrush(view, ctx, span), view, ctx);
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
 * How far from each pixel it paints the brush reads, in seconds of the file:
 * what a dab painted a piece at a time must hold around each piece. Null
 * when some effect may read anywhere in the brush, so only the whole dab at
 * once can serve it.
 */
export function pieceReach(state: State, ctx: ReachContext): TimeReach | null {
  let before = 0;
  let after = 0;
  for (const { effect, view, repeats } of chainedEffects(state)) {
    const own = EFFECT_REACH[effect].aroundPixel(view, ctx);
    if (!own) return null;
    const reach = withEnvelope(own, view, ctx);
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
    if (steps[index].enabled === false) continue;
    const step = createStepStateView(state, index);
    const repeats = Math.max(1, Math.floor(Number(step.brushIterations) || 1));
    for (const item of step.effects) {
      if (item.enabled)
        out.push({ effect: item.effect, view: createEffectStateView(state, index, item), step: index, repeats });
    }
  }
  return out;
}

/** The index of the brush's first enabled step, which is the one that reads the file; -1 when none is. */
export function firstEnabledStep(state: State): number {
  return (state.brushes[state.activeBrushIndex]?.steps ?? []).findIndex((step) => step.enabled !== false);
}

/**
 * How far across pitch, in semitones, the brush reads from the bands it
 * writes, or null when some effect may read any band.
 */
export function pitchReach(state: State, bandsPerOctave: number): number | null {
  let reach = 0;
  for (const { effect, view, repeats } of chainedEffects(state)) {
    const semis = EFFECT_REACH[effect].acrossPitch(view, bandsPerOctave);
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

/** A step's brush as the region it covers, and the axes it wraps round the file on. */
export type BrushBox = ReadBox & { wrapsTime: boolean; wrapsPitch: boolean };

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
 * The brush's first effect, run once, reads the file as the first step's
 * input. One that sets those reads apart (`EffectReach.apart`) returns them
 * as `far`, and `own` is what the brush reads besides. `far` is null when the
 * first effect reads as any other does.
 */
export function readBoxes(
  state: State,
  ctx: ReachContext,
  box: ReadBox,
  brushes: readonly BrushBox[],
): { own: ReadBox; far: FarRead | null } {
  const chain = chainedEffects(state);
  const [first] = chain;
  let region = box;
  const brushOf = (step: number): BrushBox => brushes[step] ?? { ...region, wrapsTime: false, wrapsPitch: false };
  for (let i = chain.length - 1; i >= 1; i--) {
    const { effect, view, step, repeats } = chain[i];
    const brush = brushOf(step);
    for (let r = 0; r < repeats; r++) region = effectReadBox(effect, view, ctx, region, brush);
  }
  if (!first) return { own: region, far: null };
  const leads = first.step === firstEnabledStep(state) && first.repeats === 1;
  const far = leads ? (EFFECT_REACH[first.effect].apart?.(first.view, ctx, region, brushOf(first.step)) ?? null) : null;
  // A response another effect reads too is held whole for it anyway.
  const shared =
    far?.kind === "sum" &&
    far.response !== undefined &&
    chain.slice(1).some((later) => later.effect === "convolve" && impulseKey(later.view) === far.response?.key);
  if (far && !shared) return { own: far.own, far };
  const brush = brushOf(first.step);
  for (let r = 0; r < first.repeats; r++) region = effectReadBox(first.effect, first.view, ctx, region, brush);
  return { own: region, far: null };
}

/**
 * What a repeat reads to paint `box` besides its copies along time: its
 * copies across pitch, which read the time copies' sum, and what the envelope
 * follower reads around each pixel.
 */
function repeatOwnBox(view: State, ctx: ReachContext, box: ReadBox, brush: BrushBox): ReadBox {
  const envelope = envelopeReach(view, ctx);
  const semis = cloneTapSemis(view);
  const pitch = semis === 0 ? 0 : semitonesToUv(semis, ctx) + 1 / ctx.numBands;
  return fitBox(
    {
      start: box.start - envelope.before,
      end: box.end + envelope.after,
      low: box.low - pitch,
      high: box.high + pitch,
    },
    brush,
    ctx,
  );
}

/** The region each copy along time reads to paint `own`: `own` moved by every gap it can take. */
function repeatTapBoxes(view: State, ctx: ReachContext, own: ReadBox, brush: BrushBox): ReadBox[] {
  const gap = stateRange(view, "cloneSpaceBeats");
  const beat = 60 / ctx.bpm;
  return cloneTapSteps(view.cloneShapeX as CloneShapeKey, Number(view.cloneCountX), Number(view.cloneDirectionX)).map(
    (step) => {
      const reads = [gap.lo, gap.hi].map((g) => -step * g * beat);
      return fitBox({ ...own, start: own.start + Math.min(...reads), end: own.end + Math.max(...reads) }, brush, ctx);
    },
  );
}

/** `box` widened along time by what the step's envelope followers read around each pixel. */
function withEnvelopeBox(box: ReadBox, view: State, ctx: ReachContext): ReadBox {
  const envelope = envelopeReach(view, ctx);
  return { ...box, start: box.start - envelope.before, end: box.end + envelope.after };
}

/** What one effect reads to paint `box`, within its step's `brush`. */
function effectReadBox(effect: EffectType, view: State, ctx: ReachContext, box: ReadBox, brush: BrushBox): ReadBox {
  const envelope = envelopeReach(view, ctx);
  const read = (inner: ReadBox): ReadBox => ({
    ...inner,
    start: inner.start - envelope.before,
    end: inner.end + envelope.after,
  });
  if (effect === "transform" && moves(view))
    return fitBox(read(unionBox(box, warpBox(view, ctx, box, brush))), brush, ctx);
  const own = EFFECT_REACH[effect].aroundPixel(view, ctx);
  const time = own && withEnvelope(own, view, ctx);
  const semis = EFFECT_REACH[effect].acrossPitch(view, ctx.bandsPerOctave);
  // A read across pitch lands between bands, so it takes one band more.
  const pitch = semis === null ? 1 : semis === 0 ? 0 : semitonesToUv(semis, ctx) + 1 / ctx.numBands;
  return fitBox(
    {
      start: time ? box.start - time.before : Math.min(box.start, brush.start),
      end: time ? box.end + time.after : Math.max(box.end, brush.end),
      low: box.low - pitch,
      high: box.high + pitch,
    },
    brush,
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

/** True when a transform reads somewhere other than the pixel it writes: it warps or shifts. */
function moves(view: State): boolean {
  return (
    warps(view) ||
    !only(stateRange(view, "transformShiftBeats"), 0) ||
    !only(stateRange(view, "transformShiftSemis"), 0)
  );
}

/**
 * Where a transform reads to paint `box`: every corner turned about the pivot
 * by each turn it can take, divided by each scale, and shifted, as the shader
 * maps a pixel. A turn is taken with time measured in lengths of the file.
 * A read the edge mode folds back or zeroes stays within the brush.
 */
function warpBox(view: State, ctx: ReachContext, box: ReadBox, brush: BrushBox): ReadBox {
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
  for (const t of [box.start, box.end]) {
    for (const y of [box.low, box.high]) {
      // A turn takes place in beats along time and semitones across pitch.
      const relTime = (t - pivotTime) / beat;
      const relPitch = uvToSemitones(y - pivotPitch, ctx);
      // A corner turned by θ lands furthest along an axis where θ plus the
      // corner's own angle is a multiple of 90°, or at an end of the range.
      const angle = (Math.atan2(relPitch, relTime) * 180) / Math.PI;
      const turns = [rotation.lo, rotation.hi];
      for (let k = Math.ceil((rotation.lo + angle) / 90); k * 90 - angle <= rotation.hi; k++)
        turns.push(k * 90 - angle);
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
            let time = pivotTime + ((cos * relTime - sin * relPitch) / sx) * beat;
            let pitch = pivotPitch + semitonesToUv((sin * relTime + cos * relPitch) / sy, ctx);
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

function uvToSemitones(uv: number, ctx: ReachContext): number {
  return (uv * ctx.numBands * 12) / ctx.bandsPerOctave;
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

/**
 * `box` within the file. A read past either end of an axis the brush wraps
 * round lands at the other end, so it takes the whole of that axis.
 */
function fitBox(box: ReadBox, brush: BrushBox, ctx: ReachContext): ReadBox {
  const pastTime = box.start < 0 || box.end > ctx.fileSeconds;
  const pastPitch = box.low < 0 || box.high > 1;
  return {
    start: brush.wrapsTime && pastTime ? 0 : Math.max(0, box.start),
    end: brush.wrapsTime && pastTime ? ctx.fileSeconds : Math.min(ctx.fileSeconds, box.end),
    low: brush.wrapsPitch && pastPitch ? 0 : Math.max(0, box.low),
    high: brush.wrapsPitch && pastPitch ? 1 : Math.min(1, box.high),
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
