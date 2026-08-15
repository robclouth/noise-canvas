import type { CommitStroke, CommitWindow } from "../../../main/lib/types";
import type { HistoryDimensions } from "./history-manager";
import type { SpectrogramData, State } from "@renderer/store/types";

/** Modified span of the canvas in UV, where Y=0 is the visual top. */
export interface DirtyRegionUv {
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

/** A stroke's committed footprint in unpacked UV. */
export interface FootprintUv {
  timeMin: number;
  timeMax: number;
  pitchMin: number;
  pitchMax: number;
}

/** The renderer reads a commit snapshot needs, taken at mouse-up. */
export interface StrokeCommitRenderer {
  consumeDirtyRegion: () => DirtyRegionUv | null;
  getDirtyPixelRanges: () => Uint32Array | null;
  getCommittedFootprintUv: () => FootprintUv | null;
  getStrokeGeneration: () => number;
}

/**
 * Everything a queued stroke commit needs, read once at mouse-up. The commit
 * body runs behind any earlier commit, by which time the renderer holds the
 * next stroke's state, so nothing in the body may read the renderer live.
 */
export interface StrokeCommitSnapshot {
  dirtyRegion: DirtyRegionUv | null;
  dirtyRanges: Uint32Array | null;
  footprintUv: FootprintUv | null;
  strokeGeneration: number;
  curveTime: number;
  wrapMode: number;
  limiterEnabled: boolean;
  reanalyzeEnabled: boolean;
  /** Whether the canvas still holds paint that no projection has passed over. */
  hasUnprojectedPaint: boolean;
  spec: SpectrogramData;
  dimensions: HistoryDimensions;
  brushName: string;
  autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null;
}

/**
 * Takes the snapshot for the stroke that just finished. Consumes the dirty
 * region, so calling this twice for one stroke loses the second caller's span.
 */
export function buildStrokeCommitSnapshot(opts: {
  renderer: StrokeCommitRenderer;
  state: State;
  spec: SpectrogramData;
  brushName: string;
  autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null;
  hasUnprojectedPaint?: boolean;
}): StrokeCommitSnapshot {
  const { renderer, state, spec, brushName, autoPlaybackParams } = opts;
  const step = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
    | Record<string, unknown>
    | undefined;

  return {
    dirtyRegion: renderer.consumeDirtyRegion(),
    dirtyRanges: renderer.getDirtyPixelRanges(),
    footprintUv: renderer.getCommittedFootprintUv(),
    strokeGeneration: renderer.getStrokeGeneration(),
    curveTime: (step?.brushCurveTime as number | undefined) ?? state.brushCurveTime,
    wrapMode: (step?.brushWrapMode as number | undefined) ?? state.brushWrapMode,
    limiterEnabled: state.limiterEnabled,
    reanalyzeEnabled: state.reanalyzeStrokes,
    hasUnprojectedPaint: opts.hasUnprojectedPaint ?? false,
    spec,
    dimensions: {
      textureWidth: spec.textureWidth,
      textureHeight: spec.textureHeight,
      numFrames: spec.numFrames,
      numBands: spec.numBands,
      numChannels: spec.numChannels,
      sampleRate: spec.sampleRate,
      minFreq: spec.minFreq,
      bandsPerOctave: spec.bandsPerOctave,
    },
    brushName,
    autoPlaybackParams,
  };
}

// Time-envelope curve above which a stamp edge counts as hard. The curve runs
// -100 (spike) to +100 (rectangle); a soft edge has no discontinuity to make
// exact, and cutting the audio at it would be the discontinuity.
const HARD_EDGE_CURVE_MIN = 80;

/** Wrap modes that carry the time axis round, leaving no in-file time edges. */
function wrapsTime(wrapMode: number): boolean {
  return wrapMode === 1 || wrapMode === 3;
}

/**
 * Whether the commit rebuilds and projects the whole file rather than the span
 * the stroke touched. Paint made with re-analysis off is not what the audio
 * analyses to, so projecting only the new span would leave a seam against it.
 */
export function projectsWholeFile(snapshot: StrokeCommitSnapshot): boolean {
  return snapshot.reanalyzeEnabled && snapshot.hasUnprojectedPaint;
}

/** The span of the canvas the commit rebuilds, or null for the whole file. */
export function commitWindowOf(snapshot: StrokeCommitSnapshot): CommitWindow | null {
  const { dirtyRegion, spec } = snapshot;
  if (!dirtyRegion || projectsWholeFile(snapshot)) return null;
  const startFrame = Math.max(0, Math.floor(dirtyRegion.startX * spec.numFrames));
  const endFrame = Math.min(spec.numFrames, Math.ceil(dirtyRegion.endX * spec.numFrames));
  if (endFrame <= startFrame) return null;
  // UV Y=0 is the visual top (the highest band); invert so the range covers
  // the bands the stroke actually reached.
  const startBand = Math.max(0, Math.floor((1 - dirtyRegion.endY) * spec.numBands));
  const endBand = Math.min(spec.numBands, Math.ceil((1 - dirtyRegion.startY) * spec.numBands));
  return { startFrame, endFrame, startBand, endBand };
}

/**
 * What the stroke asks of the commit: where its time edges are, whether each
 * is hard, and the shape of its time envelope.
 */
export function commitStrokeOf(snapshot: StrokeCommitSnapshot, limitStrokes: boolean): CommitStroke {
  const { footprintUv, spec, curveTime, wrapMode } = snapshot;
  const footStartFrame = footprintUv ? Math.round(footprintUv.timeMin * spec.numFrames) : 0;
  const footEndFrame = footprintUv ? Math.round(footprintUv.timeMax * spec.numFrames) : 0;
  const hard = curveTime >= HARD_EDGE_CURVE_MIN && !wrapsTime(wrapMode) && footEndFrame > footStartFrame;

  return {
    footStartFrame,
    footEndFrame,
    hardEdgeStart: hard && footStartFrame > 0,
    hardEdgeEnd: hard && footEndFrame < spec.numFrames,
    applyLimiter: limitStrokes,
    project: snapshot.reanalyzeEnabled,
  };
}
