import type { ParameterKey } from "../store/types";

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
