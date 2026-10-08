import type { CommitStroke, CommitWindow, PackedLayout } from "../../../main/lib/types";
import { commitViewSpan } from "./commit-view";
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
      texels: spec.texels,
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

// Windows a commit is cut into at most; a stroke painted in more pieces commits as one.
const MAX_COMMIT_WINDOWS = 4;

/**
 * The commit's window cut where the stroke's paint leaves a gap wider than a
 * windowed commit reaches, one window per piece in file order, so a brush that
 * wraps across the end of the file rebuilds its two ends and not the file
 * between them. One window when the paint has no such gap, when the commit
 * projects or makes hard edges exact, or when the pieces would not save
 * synthesis. Null for the whole file, as `commitWindowOf`.
 */
export function commitWindowsOf(snapshot: StrokeCommitSnapshot, layout: PackedLayout): CommitWindow[] | null {
  const whole = commitWindowOf(snapshot);
  if (!whole) return null;
  const stroke = commitStrokeOf(snapshot, snapshot.limiterEnabled);
  const ranges = snapshot.dirtyRanges;
  if (snapshot.reanalyzeEnabled || stroke.hardEdgeStart || stroke.hardEdgeEnd || !ranges) return [whole];

  const order = [...layout.bandOffsets.keys()].sort((a, b) => layout.bandOffsets[a] - layout.bandOffsets[b]);
  const spans: { startFrame: number; endFrame: number }[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    let lo = 0;
    let hi = order.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (layout.bandOffsets[order[mid]] <= ranges[i]) lo = mid;
      else hi = mid - 1;
    }
    const band = order[lo];
    const k = ranges[i] - layout.bandOffsets[band];
    const step = layout.bandStepLog2s[band];
    const startFrame = Math.max(whole.startFrame, k * 2 ** step);
    const endFrame = Math.min(whole.endFrame, (k + ranges[i + 1]) * 2 ** step);
    if (endFrame > startFrame) spans.push({ startFrame, endFrame });
  }
  spans.sort((a, b) => a.startFrame - b.startFrame);

  const sampleRate = snapshot.spec.sampleRate;
  const pieces: { startFrame: number; endFrame: number }[] = [];
  for (const span of spans) {
    const last = pieces[pieces.length - 1];
    if (
      last &&
      commitViewSpan(layout, last, sampleRate).endFrame > commitViewSpan(layout, span, sampleRate).startFrame
    ) {
      last.endFrame = Math.max(last.endFrame, span.endFrame);
    } else pieces.push({ ...span });
  }
  if (pieces.length < 2 || pieces.length > MAX_COMMIT_WINDOWS) return [whole];
  const frames = (span: { startFrame: number; endFrame: number }): number => {
    const view = commitViewSpan(layout, span, sampleRate);
    return view.endFrame - view.startFrame;
  };
  if (pieces.reduce((sum, piece) => sum + frames(piece), 0) >= frames(whole)) return [whole];
  return pieces.map((piece) => ({ ...whole, ...piece }));
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
