import type { CommitStroke, CommitWindow } from "../../../main/lib/types";
import { brushEnvelopeShape } from "./brush-envelope";
import { LEVEL_HOP_SECONDS } from "./output-levels";
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
  skewTime: number;
  wrapMode: number;
  limiterEnabled: boolean;
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
    skewTime: (step?.brushSkewTime as number | undefined) ?? state.brushSkewTime,
    wrapMode: (step?.brushWrapMode as number | undefined) ?? state.brushWrapMode,
    limiterEnabled: state.limiterEnabled,
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

/** The span of the canvas the commit rebuilds, or null when nothing changed. */
export function commitWindowOf(snapshot: StrokeCommitSnapshot): CommitWindow | null {
  const { dirtyRegion, spec } = snapshot;
  if (!dirtyRegion) return null;
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
    envelope: buildTimeEnvelope(snapshot),
  };
}

/**
 * The brush's time envelope across the whole file, one point per level hop.
 * Each point holds the envelope's largest value over its own hop, so a
 * rectangular brush stays rectangular at this resolution rather than losing
 * its last hop to a ramp.
 */
export function buildTimeEnvelope(snapshot: StrokeCommitSnapshot): Float32Array {
  const { footprintUv, spec, curveTime, skewTime } = snapshot;
  const hop = Math.max(1, Math.round(spec.sampleRate * LEVEL_HOP_SECONDS));
  const points = Math.ceil(spec.numFrames / hop) + 1;
  const envelope = new Float32Array(points);
  if (!footprintUv) return envelope;

  const startFrame = footprintUv.timeMin * spec.numFrames;
  const span = (footprintUv.timeMax - footprintUv.timeMin) * spec.numFrames;
  if (span <= 0) return envelope;

  const curve = curveTime / 100;
  const skew = (skewTime + 100) / 200;
  // Sub-samples each hop so the point holds the envelope's peak over it, not
  // whatever the envelope happens to be at its left edge.
  const SUBSTEPS = 4;
  for (let p = 0; p < points; p++) {
    let peak = 0;
    for (let s = 0; s <= SUBSTEPS; s++) {
      const sample = p * hop + (s / SUBSTEPS) * hop;
      peak = Math.max(peak, brushEnvelopeShape((sample - startFrame) / span, curve, skew));
    }
    envelope[p] = peak;
  }
  return envelope;
}
