import type { DataTexture, Texture, Vector2, WebGLRenderTarget } from "three";
import type { State, SpectrogramData } from "../store/types";
import type { CanvasView } from "./canvas-view";
import type { ImageExportOptions } from "./image-export";
import type { PosterInfo } from "./image-export-poster";
import type { SourceFileInfo } from "./stroke-renderer";
import type { DabNeeds } from "./windowed-canvas";
import type { ImpulseNeed } from "./impulse-need";

/** A stroke over one region, painted from a state built for it. */
export interface RegionStroke {
  aimX: number;
  aimY: number;
  state: State;
  /** The spectrogram the stroke samples, when it is not an open file. */
  source?: SourceFileInfo;
}

export interface StrokeDispatch {
  /** Aim point in pitch UV — y up from the file's lowest band, as unitsToUv gives it. */
  aimX: number;
  aimY: number;
  state: State;
}

/** The union of the steps' brush rectangles for one aim, in file UV. */
export interface BrushUnionUv {
  min: Vector2;
  max: Vector2;
  sizeUv: Vector2;
  fullTime: boolean;
  fullPitch: boolean;
  wrapsTime: boolean;
  wrapsPitch: boolean;
  hasSteps: boolean;
}

/** The frames a dab reads and writes, with what it reads of other files. */
export interface DabSpan {
  startFrame: number;
  endFrame: number;
  needs: DabNeeds;
  impulseBindings: readonly ImpulseNeed[];
}

export interface FileRendererHandle {
  /** Renders a brush stroke at the current cursor position. */
  renderStroke: (preview: boolean) => void;
  /**
   * Paints a batch of strokes into the FBO, each from its own state snapshot,
   * as part of the stroke already opened with beginStrokePreview(). A stroke
   * on frames the canvas does not hold waits for its window; `settleStroke`
   * lands what is waiting. The blocks under `ahead`, the strokes that follow
   * this batch, are read towards while it lands. Returns how many were taken.
   */
  renderStrokeBatch: (strokes: StrokeDispatch[], ahead?: StrokeDispatch[]) => number;
  /**
   * Paints one stroke from an explicit state, optionally sampling a spectrogram
   * that is not an open file. A preview goes to the partner buffer and can be
   * redrawn as the pointer moves; a commit is the caller's to make.
   */
  renderRegionStroke: (stroke: RegionStroke, preview: boolean) => boolean;
  /** GPU textures for a detached spectrogram, for `renderRegionStroke` to sample. */
  createRegionSource: (
    id: string,
    spec: SpectrogramData,
    onsets?: Float32Array,
    onsetSensitivity?: number,
  ) => SourceFileInfo | null;
  disposeRegionSource: (source: SourceFileInfo) => void;
  /**
   * Opens a stroke and saves the spectrogram (or restores an already-saved
   * one), so the strokes painted next can be taken back without touching
   * history.
   */
  beginStrokePreview: () => void;
  /** Puts back the pixels from before the preview. Resolves false if none were saved. */
  discardStrokePreview: () => Promise<boolean>;
  /**
   * The longest stroke the canvas takes at once, in seconds, while it holds a
   * window of the file; null while it holds all of it.
   */
  maxStrokeSeconds: () => number | null;
  /** Keeps the previewed pixels and forgets the saved ones, so they can be committed. */
  keepStrokePreview: () => void;
  /** The whole packed state from the frame buffer, or null when the canvas view does not hold the whole file. */
  getFBOData: () => Promise<Float32Array | null>;
  /**
   * Reads only the pixels of the flat [pixelStart, pixelCount, ...] ranges from
   * the committed frame buffer, as one block in range order.
   */
  readPixelRanges: (pixelRanges: Uint32Array) => Promise<Float32Array>;
  /**
   * Adds per-range phase offsets to the committed frame buffer in place:
   * [pixelStart, pixelCount, offsetLeft, offsetRight, ...].
   */
  applyPhaseTurns: (turns: ArrayLike<number>) => void;
  /** Sets the data of the frame buffer object. */
  setFBOData: (data: Float32Array) => void;
  /**
   * Uploads only the texture rows covered by the flat [pixelStart, pixelCount, ...]
   * ranges from `data` (the full packed state). Equivalent to setFBOData when
   * everything outside the ranges already matches the FBO, but far cheaper.
   */
  patchFBOData: (data: Float32Array, pixelRanges: Uint32Array) => void;
  /** As patchFBOData, from values holding exactly the ranges' pixels in range order. */
  patchFBODataCompact: (values: Float32Array, pixelRanges: Uint32Array) => void;
  /** Returns the textures used for rendering. */
  getTextures: () => {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: Texture;
  } | null;
  /** The span the canvas textures lay out, or null before the renderer exists. */
  getCanvasView: () => CanvasView | null;
  /**
   * Why the brush cannot paint on a canvas holding a window of the file, in the
   * words the user reads. Null when the stroke can paint.
   */
  strokeRefusal: (state: State, aim?: { x: number; y: number }) => string | null;
  /** Restores the spectrogram to its original state. */
  restoreOriginal: () => Promise<void>;
  /** Clears the stroke preview. */
  clearPreview: () => void;
  /** Reloads all textures from the current spectrogramData (used after re-analysis). */
  reloadTextures: () => void;
  releaseAnalysisData: () => void;
  beginStroke: () => void;
  endStroke: () => void;
  /** Resolves once every dab of the stroke has landed. Call it before committing. */
  settleStroke: () => Promise<void>;
  /**
   * Keeps a stroke's paint, `values` over the file pixels of `ranges`, on the
   * canvas until the function returned is called, however the window moves.
   */
  holdPaint: (ranges: Uint32Array, values: Promise<Float32Array>) => () => void;
  /** Drops the canvas's cached copies of the blocks over the named file pixels. */
  forgetBlocks: (ranges: Uint32Array) => void;
  /** Gets the dirty region (UV range modified since last clear). Returns null if no modifications. */
  getDirtyRegion: () => { startX: number; endX: number; startY: number; endY: number } | null;
  /** Clears the dirty region tracking (call after synthesis). */
  clearDirtyRegion: () => void;
  /** Takes the dirty region and clears it, so only this commit synthesizes it. */
  consumeDirtyRegion: () => { startX: number; endX: number; startY: number; endY: number } | null;
  /** Packed-pixel ranges the current stroke's committed footprint covers, for the history delta. Null = full snapshot. */
  getDirtyPixelRanges: () => Uint32Array | null;
  /** The stroke's committed footprint in unpacked UV, or null when nothing was committed. */
  getCommittedFootprintUv: () => { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number } | null;
  /** Monotonic count of stroke starts, for dropping stale async commit work. */
  getStrokeGeneration: () => number;
  /** Widens the dirty region to cover pixels changed outside the painted rect. */
  expandDirtyRegion: (startX: number, endX: number, startY: number, endY: number) => void;
  /**
   * Renders a standalone still image of the committed spectrogram at export
   * resolution. Resolves null when the renderer isn't ready yet.
   */
  renderExportImage: (
    options: ImageExportOptions,
    posterInfo: PosterInfo,
    onProgress?: (fraction: number) => void,
  ) => Promise<HTMLCanvasElement | null>;
}

/** Borrowed spectral inputs for one file's display material. */
export interface FileDisplayData {
  spectrogramData: SpectrogramData;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
  canvasView: CanvasView | undefined;
  canvasMetadataTex: DataTexture;
}

/** Resolved presentation values for one file view. */
export interface FileViewDescriptor {
  displayMinDb: number;
  displayMaxDb: number;
  gridSizeBeats: number;
  gridSizeSemis: number;
  gridSwing: number;
  scaleTonic: string;
  scaleType: string;
  bpm: number;
  totalDuration: number;
  viewZoomPower: number;
  viewOffset: number;
  viewZoomPowerY: number;
  viewOffsetY: number;
  viewportWidth: number;
  viewportHeight: number;
}
