import type { BaseEffect } from "../effects/base-effect";
import type { EffectItem, EffectType } from "../effects/types";
import { getParameterDef } from "../parameters";
import type { ParameterKey, State } from "../store/types";
import { resolvedStaticValue, scopedStateView, totalModulationWeight } from "./macro-targets";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL, resolveBrushFootprint } from "./utils";

/** How far beyond its own pixel one effect pass reads along time, per iteration. */
export type TimeReach = { kind: "none" } | { kind: "frames"; frames: number } | { kind: "wholeFile" };

/** What an effect's reach declaration may ask about the stroke it runs in. */
export interface TimeReachContext {
  /**
   * The largest absolute value the parameter can take during the stroke: its
   * resolved value when nothing modulates it, its range extreme when
   * something does.
   */
  maxAbs(key: ParameterKey): number;
  /**
   * The smallest absolute value the parameter can take during the stroke —
   * zero when modulation can sweep it through zero.
   */
  minAbs(key: ParameterKey): number;
  /** Time extent of the brush box, in frames. */
  brushSpanFrames: number;
  /** Pitch extent of the brush box, as a fraction of the file's band range. */
  brushPitchUvSpan: number;
  framesPerBeat: number;
  numFrames: number;
}

/** One step's contribution to what a stroke reads, resolved at stroke start. */
export interface StepReach {
  /** Wrap mode sends out-of-file reads around the ends, so nothing bounds them. */
  wrap: boolean;
  /** True when the step's source reads land on this file (Self, or Original). */
  selfSource: boolean;
  /** dest→source UV slope of the source transform. */
  sourceTimeScale: number;
  /** Stroke-locked source offset plus the Time parameter's extremes, in source UV. */
  sourceOffsetUvLow: number;
  sourceOffsetUvHigh: number;
  iterations: number;
  /** One entry per enabled effect, from its timeReach declaration. */
  effectReaches: TimeReach[];
}

export interface StrokeReadSpan {
  startFrame: number;
  endFrame: number;
  /** True when no finite span bounds the reads and the whole file must be resident. */
  wholeFile: boolean;
}

/**
 * The file frame span a stroke can read, from the span its dabs can land on
 * (the view, since the cursor cannot leave it) and each step's source
 * transform and effect stencils. Finite stencils sample around the source
 * position, so they only widen this file's span when the source is this file;
 * a cross-file step reads the other file instead and contributes nothing here.
 */
export function strokeReadSpan(
  view: { startFrame: number; endFrame: number },
  steps: StepReach[],
  numFrames: number,
): StrokeReadSpan {
  let start = view.startFrame;
  let end = view.endFrame;
  let wholeFile = false;

  for (const step of steps) {
    if (step.wrap) wholeFile = true;

    let stencilFrames = 0;
    for (const reach of step.effectReaches) {
      if (reach.kind === "wholeFile") wholeFile = true;
      else if (reach.kind === "frames") stencilFrames += reach.frames * Math.max(1, step.iterations);
    }
    if (!step.selfSource) continue;

    const corners = [
      view.startFrame * step.sourceTimeScale + step.sourceOffsetUvLow * numFrames,
      view.startFrame * step.sourceTimeScale + step.sourceOffsetUvHigh * numFrames,
      view.endFrame * step.sourceTimeScale + step.sourceOffsetUvLow * numFrames,
      view.endFrame * step.sourceTimeScale + step.sourceOffsetUvHigh * numFrames,
    ];
    start = Math.min(start, Math.min(...corners) - stencilFrames);
    end = Math.max(end, Math.max(...corners) + stencilFrames);
  }

  if (wholeFile) return { startFrame: 0, endFrame: numFrames, wholeFile: true };
  return {
    startFrame: Math.max(0, Math.floor(start)),
    endFrame: Math.min(numFrames, Math.ceil(end)),
    wholeFile: false,
  };
}

/** The largest and smallest values a number parameter can take during a stroke. */
function parameterBounds(view: State, key: ParameterKey): [number, number] {
  const def = getParameterDef(key);
  if (def.kind !== "number") return [0, 0];
  if (totalModulationWeight(view, key) > 0) return [def.min, def.max];
  const value = resolvedStaticValue(view, key);
  return [value, value];
}

function reachContext(
  view: State,
  dims: Pick<TimeReachContext, "brushSpanFrames" | "brushPitchUvSpan" | "framesPerBeat" | "numFrames">,
): TimeReachContext {
  return {
    maxAbs: (key) => {
      const [low, high] = parameterBounds(view, key);
      return Math.max(Math.abs(low), Math.abs(high));
    },
    minAbs: (key) => {
      const [low, high] = parameterBounds(view, key);
      return low <= 0 && high >= 0 ? 0 : Math.min(Math.abs(low), Math.abs(high));
    },
    ...dims,
  };
}

export interface StrokeReachOptions {
  bpm: number;
  numFrames: number;
  sampleRate: number;
  bandsPerOctave: number;
  numBands: number;
  /** The file the stroke lands on, to tell a Self source from a cross-file one. */
  destFilePath: string | null;
  /** Per step: the stroke-locked source offset in dest UV, 0 when the step has none. */
  lockedOffsetUv?: number[];
}

/**
 * One StepReach per step of the active brush, resolved through the parameter
 * layers (effect params over step over defaults) with every modulated
 * parameter taken at its range, so the combined span covers whatever the
 * modulators do mid-stroke.
 */
export function resolveStrokeReach(
  state: State,
  registry: Partial<Record<EffectType, BaseEffect>>,
  opts: StrokeReachOptions,
): StepReach[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const framesPerBeat = (opts.sampleRate * 60) / opts.bpm;
  const totalDuration = opts.numFrames / opts.sampleRate;

  return steps.map((step, stepIndex) => {
    const view = scopedStateView(state, stepIndex);

    const [, sizeTimeHigh] = parameterBounds(view, "brushSizeTime");
    const [, sizePitchHigh] = parameterBounds(view, "brushSizePitch");
    const footprint = resolveBrushFootprint({
      brushSizeTime: Math.min(sizeTimeHigh, BRUSH_SIZE_TIME_FULL),
      brushSizePitch: Math.min(sizePitchHigh, BRUSH_SIZE_PITCH_FULL),
      gridSizeBeats: view.gridSizeBeats,
      gridSizeSemis: view.gridSizeSemis,
      bpm: opts.bpm,
      totalDuration,
      bandsPerOctave: opts.bandsPerOctave,
      numBands: opts.numBands,
    });
    const dims = {
      brushSpanFrames: footprint.sizeUv.x * opts.numFrames,
      brushPitchUvSpan: footprint.sizeUv.y,
      framesPerBeat,
      numFrames: opts.numFrames,
    };

    const wrapMode = view.brushWrapMode as number;
    const lockedUv = opts.lockedOffsetUv?.[stepIndex] ?? 0;
    const [offsetLow, offsetHigh] = parameterBounds(view, "sourceTimeOffset");

    const effectReaches: TimeReach[] = [];
    for (const item of (step.effects ?? []) as EffectItem[]) {
      if (!item.enabled) continue;
      const effect = registry[item.effect];
      if (!effect) continue;
      effectReaches.push(effect.timeReach(reachContext(scopedStateView(state, stepIndex, item.id), dims)));
    }

    return {
      wrap: wrapMode === 1 || wrapMode === 3,
      selfSource: !step.sourceFile || step.sourceFile.path === opts.destFilePath,
      sourceTimeScale: 1,
      sourceOffsetUvLow: lockedUv + offsetLow / 100,
      sourceOffsetUvHigh: lockedUv + offsetHigh / 100,
      iterations: Math.max(1, view.brushIterations as number),
      effectReaches,
    };
  });
}
