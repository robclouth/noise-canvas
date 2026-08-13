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
