import { notifications } from "@mantine/notifications";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2 } from "three";
import type { State, OpenFile, SpectrogramData } from "../store/types";
import type {
  BrushUnionUv,
  DabSpan,
  StrokeBatchResult,
  StrokeDispatch,
  FileRendererHandle,
} from "./file-renderer-types";
import {
  canvasViewOf,
  canvasViewOfFrames,
  clipToView,
  fileRangesToView,
  fileUvToViewUv,
  viewCoversFile,
  viewRangesToFile,
  type BandSpan,
  type CanvasView,
} from "./canvas-view";
import { bandAtPixel } from "./band-layout";
import { bandMetadataTexture } from "./band-metadata-texture";
import { composePixelRangeValues, intersectPixelRanges, pixelRangeCount } from "./pixel-ranges";
import {
  sourceNeedsOver,
  sourceReadSpan,
  type ReadPart,
  type SourceRead,
  type SourceWindowTextures,
} from "./source-window";
import type { DabNeeds, PaintBeside, StrokePaint, WindowedCanvas } from "./windowed-canvas";
import type { SelfState } from "./self-window";
import { blockOfFrame, coarsestBinFrames, frameRangeOfBlock, gridQuantumFrames } from "./block-grid";
import { blockReadSpan, type DabExtent, type FrameSpan } from "./held-dabs";
import {
  firstEnabledStep,
  pieceReach,
  readBoxes,
  strokeReach,
  unionBox,
  type BrushBox,
  type ReachContext,
  type ReadBox,
} from "./effect-reach";
import { strokeRefusal as refusalFor } from "./whole-file-gate";
import { reachFixes, reachFixMessage } from "./reach-fix";
import { attractFieldNeeds, impulseNeeds, mergeNeedsByFile, type ImpulseNeed } from "./impulse-need";
import {
  GpuMemoryError,
  type ImpulseFileInfo,
  type InputPart,
  type SourceFileInfo,
  type StrokeRenderer,
} from "./stroke-renderer";
import { DEFAULT_ONSET_SENSITIVITY } from "./constants";
import { getOnsetTexture, type Onset } from "./onset-map";
import { countDiagStroke } from "./diag-sampler";
import { diag } from "./diag-log";
import { perfMark } from "./perf-probe";
import { penState } from "./pen-state";
import { footprintAimToBlUv } from "./brush-anchor";
import {
  bandIndexToPitchUv,
  pitchUvToBandIndex,
  resolveBrushAnchor,
  resolveBrushFootprint,
  swungGridCellWidthUv,
} from "./utils";

type FileStrokeFile = Pick<
  OpenFile,
  "id" | "filePath" | "displayName" | "spectrogramData" | "onsets" | "onsetsPending"
> & {
  rendererRef?: { current: Pick<FileRendererHandle, "getTextures" | "getCanvasView"> | null };
};

export interface FileStrokeContext {
  fileId: string;
  spectrogramData: SpectrogramData;
  strokeRendererRef: { current: StrokeRenderer | null };
  canvasRef: { current: WindowedCanvas | null };
  openFiles: Record<string, FileStrokeFile>;
  getOpenFileByPath: (path: string) => FileStrokeFile | undefined;
  createStepStateView: (state: State, index: number) => State;
  getFileOnsets: (fileId: string) => Onset[];
  closeFile: (fileId: string) => void;
  reachByState: WeakMap<State, StateReach>;
}

/**
 * Which state of the painted file a step takes when it reads it far from
 * the dab, as the renderer would read it off a canvas holding the whole file:
 * the original, the file as the stroke found it, or as the stroke has left
 * it so far.
 */
function selfStateOf(step: State, first: boolean): SelfState {
  if (step.sourceDataMode === "original" || step.sourceDataMode === "start") return "start";
  return first && !step.accumulate ? "start" : "live";
}

/** True when a step may read its file somewhere other than under the dab. */
function tracksSource(step: State): boolean {
  return step.sourcePositionMode !== "follow" || Number(step.sourceTimeOffset ?? 0) !== 0;
}

/**
 * What each step of a dab reads of a file its canvas does not hold: another
 * windowed file it names, or the active file for a first step naming none;
 * and this file, where a step reads it away from the dab. `reach` is what the
 * dab's effects read around what it reads, in its own frames.
 */
function sourceReadsFor(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  reach: { before: number; after: number } = { before: 0, after: 0 },
): SourceRead[] {
  const { fileId, spectrogramData, strokeRendererRef, canvasRef, openFiles, getOpenFileByPath, createStepStateView } =
    context;
  const strokeRenderer = strokeRendererRef.current;
  const canvas = canvasRef.current;
  const file = openFiles[fileId];
  if (!strokeRenderer || !canvas || !file || cursorPos.x < 0) return [];
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  const bpm = state.filepathsBpm[file.filePath] || 120;
  const activeFile = state.activeFileId ? openFiles[state.activeFileId] : undefined;
  const reads: SourceRead[] = [];
  let first = true;
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].enabled === false) continue;
    const isFirst = first;
    first = false;
    const step = createStepStateView(state, index);
    const sourcePath = steps[index].sourceFile?.path;
    const source = sourcePath ? getOpenFileByPath(sourcePath) : isFirst && activeFile ? activeFile : file;
    const sourceSpectrogram = source?.spectrogramData;
    if (!source || !sourceSpectrogram) continue;
    const self = source.id === fileId;
    if (self) {
      if (canvas.holdsWholeFile || !tracksSource(step)) continue;
    } else {
      const sourceView = source.rendererRef?.current?.getCanvasView();
      if (sourceView && viewCoversFile(sourceView, sourceSpectrogram.numFrames)) continue;
    }

    const read = strokeRenderer.sourceReadFrames(
      state,
      canvas.dabCursor(cursorPos),
      bpm,
      canvas.dabDuration(totalDuration),
      { filePath: source.filePath, spectrogramData: sourceSpectrogram },
      index,
    );
    const destLength = read.dest.end - read.dest.start;
    const scale = destLength > 0 ? Math.abs(read.end - read.start) / destLength : 1;
    const margin = 1 << Math.max(...sourceSpectrogram.synthesisMetadata.bandStepLog2s);
    reads.push({
      fileId: source.id,
      wantOriginal: step.sourceDataMode === "original",
      ...(self ? { self: { step: index, state: selfStateOf(step, isFirst) } } : {}),
      ...(isFirst ? { first: true } : {}),
      pad: { before: reach.before * scale + margin, after: reach.after * scale + margin },
      read: { start: read.start, end: read.end },
      dest: read.dest,
      numFrames: sourceSpectrogram.numFrames,
      destFrames: spectrogramData.numFrames,
    });
  }
  return reads;
}

/**
 * The dab's reach widened to cover the frames its reads of this file take,
 * when they fall past the dab, so a canvas holding both serves them without
 * a window of their own.
 */
function withSelfReads(extent: DabExtent, reads: readonly SourceRead[]): DabExtent {
  let { before, after } = extent;
  let piece = extent.piece;
  for (const read of reads) {
    if (!read.self) continue;
    const shift = read.read.start - read.dest.start;
    before = Math.max(before, extent.before - shift);
    after = Math.max(after, extent.after + shift);
    if (piece)
      piece = {
        before: Math.max(piece.before, piece.before - shift),
        after: Math.max(piece.after, piece.after + shift),
      };
  }
  return { ...extent, before, after, piece };
}

function wantsOriginal(context: FileStrokeContext, state: State): boolean {
  const { createStepStateView } = context;
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].enabled === false) continue;
    if (createStepStateView(state, index).sourceDataMode === "original") return true;
  }
  return false;
}

function responseFileFor(context: FileStrokeContext, path: string | null) {
  const { fileId, openFiles, getOpenFileByPath } = context;
  return (path ? getOpenFileByPath(path) : openFiles[fileId]) ?? null;
}

function responseIsWindowed(context: FileStrokeContext, id: string): boolean {
  const { openFiles } = context;
  const response = openFiles[id];
  const view = response?.rendererRef?.current?.getCanvasView();
  if (!view || !response?.spectrogramData) return true;
  return !viewCoversFile(view, response.spectrogramData.numFrames);
}

/**
 * The other files a dab's effects read, under the keys the effects look them
 * up by: convolve responses and Attract fields, the fields over `destSpan` of
 * this file, or all of each with no span.
 */
function impulseNeedsFor(
  context: FileStrokeContext,
  state: State,
  destSpan: { startFrame: number; endFrame: number } | null = null,
): ImpulseNeed[] {
  const resolve = (path: string | null) => {
    const response = responseFileFor(context, path);
    return response?.spectrogramData ? { id: response.id, spectrogramData: response.spectrogramData } : null;
  };
  return mergeNeedsByFile([
    ...impulseNeeds(state, resolve),
    ...attractFieldNeeds(state, resolve, destSpan, context.spectrogramData.numFrames),
  ]);
}

/** One step's brush at a dab: its bottom-left corner and size in file UV, and how it spans or wraps. */
type StepBrush = {
  anchor: Vector2;
  sizeUv: Vector2;
  fullTime: boolean;
  fullPitch: boolean;
  wrapsTime: boolean;
  wrapsPitch: boolean;
};

/** Each step's brush at a dab aimed at `cursorPos`. */
function stepBrushesAt(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  bpm: number,
  totalDuration: number,
): StepBrush[] {
  const { fileId, spectrogramData, createStepStateView, getFileOnsets } = context;
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  return steps.map((_, i) => {
    const stepState = createStepStateView(state, i);
    const stepFp = resolveBrushFootprint({
      brushSizeTime: stepState.brushSizeTime,
      brushSizePitch: stepState.brushSizePitch,
      gridSizeBeats: stepState.gridSizeBeats,
      gridSizeSemis: stepState.gridSizeSemis,
      bpm,
      totalDuration,
      bandsPerOctave: spectrogramData.bandsPerOctave,
      numBands: spectrogramData.numBands,
    });
    if (cursorPos.x >= 0 && !stepFp.fullTime) {
      const swungTimeUv = swungGridCellWidthUv(
        cursorPos.x,
        {
          brushSizeTime: stepState.brushSizeTime,
          gridSizeBeats: stepState.gridSizeBeats,
          gridSwing: stepState.gridSwing,
          snapTime: stepState.snapTime,
          onsets: getFileOnsets(fileId),
        },
        bpm,
        totalDuration,
      );
      if (swungTimeUv !== null) stepFp.sizeUv.x = swungTimeUv;
    }
    const { blX, blY } = footprintAimToBlUv(cursorPos.x, cursorPos.y, stepFp, {
      anchorMode: stepState.brushAnchorMode as number,
      brushSizeTime: stepState.brushSizeTime,
      gridSizeBeats: stepState.gridSizeBeats,
      snapTime: stepState.snapTime,
    });
    const stepWrap = stepState.brushWrapMode as number;
    return {
      anchor: resolveBrushAnchor(new Vector2(blX, blY), stepFp.fullTime, stepFp.fullPitch),
      sizeUv: stepFp.sizeUv,
      fullTime: stepFp.fullTime,
      fullPitch: stepFp.fullPitch,
      wrapsTime: stepWrap === 1 || stepWrap === 3,
      wrapsPitch: stepWrap === 2 || stepWrap === 3,
    };
  });
}

export function brushUnionAt(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  bpm: number,
  totalDuration: number,
): BrushUnionUv {
  const min = new Vector2(Infinity, Infinity);
  const max = new Vector2(-Infinity, -Infinity);
  let fullTime = false;
  let fullPitch = false;
  let wrapsTime = false;
  let wrapsPitch = false;
  const steps = stepBrushesAt(context, state, cursorPos, bpm, totalDuration);
  for (const step of steps) {
    min.x = Math.min(min.x, step.anchor.x);
    min.y = Math.min(min.y, step.anchor.y);
    max.x = Math.max(max.x, step.anchor.x + step.sizeUv.x);
    max.y = Math.max(max.y, step.anchor.y + step.sizeUv.y);
    fullTime ||= step.fullTime;
    fullPitch ||= step.fullPitch;
    wrapsTime ||= step.wrapsTime;
    wrapsPitch ||= step.wrapsPitch;
  }
  const hasSteps = steps.length > 0;
  const sizeUv = hasSteps ? new Vector2(max.x - min.x, max.y - min.y) : new Vector2(0, 0);
  return { min, max, sizeUv, fullTime, fullPitch, wrapsTime, wrapsPitch, hasSteps };
}

/**
 * How one dab is dispatched beyond its state and aim: the spectrogram it
 * samples when that is not an open file, the span `dabSpan` worked out for it,
 * the file frames it may write, or null for all of them.
 */
export type DispatchOptions = {
  source?: SourceFileInfo;
  span?: DabSpan;
  clip?: FrameSpan | null;
  /**
   * A renderer beside the canvas to paint on, the view it holds, what the
   * first step reads the painted file through when that is not the view, and
   * the frames the dab reads there, which the windows over other files hold.
   * `sketch` marks a picture that shows the dab without painting it, which
   * reads through the windows over other files only as large as they are.
   */
  beside?: {
    renderer: StrokeRenderer;
    view: CanvasView;
    input?: SourceFileInfo;
    /** The input a part at a time, for a first step whose read no one view holds; `input` is the first part's. */
    inputParts?: readonly InputPart[];
    reads: ReadPart;
    sketch?: boolean;
  };
};

export function dispatchStroke(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  preview: boolean,
  options: DispatchOptions = {},
): boolean {
  const { source: sourceOverride, span: preparedSpan, clip, beside } = options;
  const { fileId, strokeRendererRef, canvasRef, openFiles, getOpenFileByPath } = context;
  const strokeRenderer = beside?.renderer ?? strokeRendererRef.current;
  const file = openFiles[fileId];
  if (!strokeRenderer || !file?.spectrogramData) return false;

  const bpm = state.filepathsBpm[file.filePath] || 120;
  const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

  const canvas = beside ? null : canvasRef.current;
  // The windows over other files: a dab painted beside the canvas reads them too.
  const windows = canvasRef.current;
  // Only a dab that paints grows a window: its texture is allocated whole.
  const grows = !preview && !beside?.sketch;
  const span = preparedSpan ?? (canvasRef.current ? dabSpan(context, state, cursorPos, canvasRef.current) : null);
  if (canvas && span) {
    // A preview draws what the canvas holds of a dab wider than a window.
    const reads = clip ? readSpanOf(span.extent, clip) : wholeReadSpan(span.extent);
    const wide = !reads || !canvas.fitsWindow(reads.start, reads.end);
    if (!(preview && wide) && (!reads || !canvas.holdsFrames(reads.start, reads.end, span.needs.original)))
      return false;
  }
  const numFrames = file.spectrogramData.numFrames;
  const dabCursor = beside
    ? new Vector2(fileUvToViewUv(beside.view, numFrames, cursorPos.x), cursorPos.y)
    : canvas
      ? canvas.dabCursor(cursorPos)
      : cursorPos;
  const dabDuration = beside
    ? (beside.view.endFrame - beside.view.startFrame) / file.spectrogramData.sampleRate
    : canvas
      ? canvas.dabDuration(totalDuration)
      : totalDuration;

  if (!beside && strokeRefusal(context, state) !== null) return false;

  const reads = span?.needs.sources ?? sourceReadsFor(context, state, cursorPos);
  const sourceWindows = new Map<string, SourceWindowTextures>();
  for (const need of sourceNeedsOver(reads, beside?.reads ?? clip ?? null)) {
    const window = windows?.aimSource(need, grows);
    if (!window) return false;
    if (!need.self) sourceWindows.set(need.fileId, window);
  }
  // Steps that read this file far from the dab read it through its window.
  const selfSources = new Map<number, SourceFileInfo>();
  for (const read of reads) {
    if (!read.self || !windows || !file.spectrogramData) continue;
    const textures = windows.selfTextures(read.self.state);
    if (!textures) return false;
    selfSources.set(read.self.step, {
      id: `${fileId}:self`,
      filePath: file.filePath,
      displayName: file.displayName,
      spectrogramData: file.spectrogramData,
      textures,
      view: textures.view,
      onsetTexture: getOnsetTexture(
        fileId,
        file.onsets,
        totalDuration,
        state.filepathsOnsetSensitivity[file.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
      ),
    });
  }

  const impulses = new Map<string, ImpulseFileInfo>();
  for (const entry of span?.impulseBindings ?? impulseNeedsFor(context, state)) {
    const response = openFiles[entry.need.fileId];
    const spectrogram = response?.spectrogramData;
    if (!spectrogram) return false;
    if (responseIsWindowed(context, entry.need.fileId)) {
      const window = windows?.aimImpulse(entry.need, grows);
      if (!window) return false;
      impulses.set(entry.key, {
        spectrogramData: spectrogram,
        textures: { packed: window.packed, metadata: window.metadata },
        view: window.view,
      });
      continue;
    }
    const textures = response.rendererRef?.current?.getTextures();
    if (!textures) return false;
    impulses.set(entry.key, {
      spectrogramData: spectrogram,
      textures: { packed: textures.packed, metadata: textures.metadata },
    });
  }

  const toSourceInfo = (openFile: FileStrokeFile | undefined): SourceFileInfo | undefined => {
    if (!openFile?.spectrogramData) return undefined;
    const window = sourceWindows.get(openFile.id);
    // A dab painted beside the canvas reads this file off the renderer it paints on.
    const own = beside && openFile.id === fileId ? beside.renderer : openFile.rendererRef?.current;
    const textures = window ?? own?.getTextures();
    if (!textures) return undefined;
    const ownView = beside && openFile.id === fileId ? beside.view : openFile.rendererRef?.current?.getCanvasView();
    const span = ownView && !viewCoversFile(ownView, openFile.spectrogramData.numFrames) ? ownView : undefined;
    return {
      id: openFile.id,
      filePath: openFile.filePath,
      displayName: openFile.displayName,
      spectrogramData: openFile.spectrogramData,
      textures,
      view: window ? window.view : span,
      onsetTexture: getOnsetTexture(
        openFile.id,
        openFile.onsets,
        openFile.spectrogramData.numFrames / openFile.spectrogramData.sampleRate,
        state.filepathsOnsetSensitivity[openFile.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
      ),
    };
  };

  const sourceFileInfo =
    sourceOverride ??
    beside?.input ??
    toSourceInfo(state.activeFileId ? openFiles[state.activeFileId] : undefined) ??
    toSourceInfo(openFiles[fileId]);
  if (!sourceFileInfo) return false;

  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const resolved = new Map<string, SourceFileInfo | undefined>();
  const stepSources = steps.map((step, index) => {
    const self = selfSources.get(index);
    if (self) return self;
    const path = step.sourceFile?.path;
    if (path === undefined) return undefined;
    if (sourceOverride) return sourceOverride;
    if (beside?.input && index === firstEnabledStep(state) && getOpenFileByPath(path)?.id === fileId)
      return beside.input;
    if (!resolved.has(path)) resolved.set(path, toSourceInfo(getOpenFileByPath(path)));
    return resolved.get(path);
  });

  const destOnsetTexture = getOnsetTexture(
    fileId,
    file.onsets,
    totalDuration,
    state.filepathsOnsetSensitivity[file.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
  );

  const paintTiming = (globalThis as { __paintTiming?: boolean }).__paintTiming === true;
  const paintT0 = paintTiming ? performance.now() : 0;
  countDiagStroke(preview);
  try {
    perfMark("renderStroke", () =>
      strokeRenderer.renderStroke(
        {
          cursorPos: dabCursor,
          preview,
          bpm,
          totalDuration: dabDuration,
          viewZoomPower: state.filesZoom[fileId],
          viewOffset: state.filesOffset[fileId],
          viewZoomPowerY: state.filesZoomY[fileId] ?? 0,
          viewOffsetY: state.filesOffsetY[fileId] ?? 0,
          pressure: penState.pressure,
          tiltX: penState.tiltX,
          tiltY: penState.tiltY,
          destOnsetTexture,
          impulses,
          stepSources,
          selection: state.filesSelection[fileId] ?? null,
          clip: beside && clip ? clipToView(beside.view, clip) : (canvas?.clipToCanvas(clip ?? null) ?? null),
          inputParts: beside?.inputParts,
        },
        state,
        sourceFileInfo,
      ),
    );
  } catch (error) {
    if (!(error instanceof GpuMemoryError)) throw error;
    diag.error("gl", "stroke render failed", { error });
    notifications.show({
      title: "Not enough graphics memory",
      message: "The file was closed because the graphics device could not allocate its buffers.",
      color: "red",
    });
    context.closeFile(fileId);
    return false;
  }
  if (paintTiming) {
    strokeRenderer.finishGpu();
    console.log(`[paint] stroke ${(performance.now() - paintT0).toFixed(2)}ms`);
  }
  return true;
}

function reachContext(context: FileStrokeContext, state: State): ReachContext | null {
  const { fileId, canvasRef, openFiles } = context;
  const canvas = canvasRef.current;
  const file = openFiles[fileId];
  if (!canvas || canvas.holdsWholeFile || !file?.spectrogramData) return null;
  const spectrogram = file.spectrogramData;
  return {
    bpm: state.filepathsBpm[file.filePath] || 120,
    fileSeconds: spectrogram.numFrames / spectrogram.sampleRate,
    canvasSeconds: canvas.windowSeconds(),
    blockSeconds: canvas.grid.blockFrames / spectrogram.sampleRate,
    binSeconds: coarsestBinFrames(canvas.grid) / spectrogram.sampleRate,
    bandsPerOctave: spectrogram.bandsPerOctave,
    numBands: spectrogram.numBands,
    responseSpan: (path) => {
      const other = responseFileFor(context, path)?.spectrogramData;
      if (!other) return null;
      const stride = 1 << Math.max(...other.synthesisMetadata.bandStepLog2s);
      return { seconds: other.numFrames / other.sampleRate, binSeconds: stride / other.sampleRate };
    },
  };
}

/**
 * What a state's brush reads, in frames of the file: past the dab, and
 * around each frame it writes (null when only the whole dab can serve it,
 * with the effects that make it so).
 */
export type StateReach = {
  refusal: string | null;
  frames: { before: number; after: number };
  piece: { before: number; after: number } | null;
};

function reachOf(context: FileStrokeContext, state: State): StateReach {
  const { spectrogramData, canvasRef, reachByState } = context;
  const known = reachByState.get(state);
  if (known) return known;
  const ctx = reachContext(context, state);
  const refusal = refusalFor(state, ctx);
  const { numFrames, sampleRate } = spectrogramData;
  const toFrames = (reach: { before: number; after: number }) => ({
    before: Math.min(reach.before * sampleRate, numFrames),
    after: Math.min(reach.after * sampleRate, numFrames),
  });
  let frames = { before: 0, after: 0 };
  let piece: StateReach["piece"] = { before: 0, after: 0 };
  if (ctx) {
    frames = toFrames(strokeReach(state, ctx));
    const around = pieceReach(state, ctx);
    piece = around ? toFrames(around) : null;
  }
  const entry = { refusal, frames, piece };
  // A reach calculated before the canvas exists must not be cached.
  if (canvasRef.current) reachByState.set(state, entry);
  return entry;
}

/** The refusal a brush gets while `name`, a file it reads, still waits for its onsets. */
export function onsetsPendingRefusal(name: string): string {
  return `${name} is still finding its onsets. Paint again in a moment.`;
}

/** The painted file, or a file a step reads, while it still waits for its onsets; null when none does. */
function fileAwaitingOnsets(context: FileStrokeContext, state: State): FileStrokeFile | null {
  const painted = context.openFiles[context.fileId];
  if (painted?.onsetsPending) return painted;
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  for (const step of steps) {
    const path = step.sourceFile?.path;
    const read = path ? context.getOpenFileByPath(path) : undefined;
    if (read?.onsetsPending) return read;
  }
  return null;
}

/** True while the painted file, or a file a step reads, still waits for its onsets. */
function onsetsPendingFor(context: FileStrokeContext, state: State): boolean {
  return fileAwaitingOnsets(context, state) !== null;
}

/** True when a dab of `state` aimed at `aim` can paint, on the canvas or beside it. */
export function brushPaintsAt(context: FileStrokeContext, state: State, aim: { x: number; y: number }): boolean {
  const canvas = context.canvasRef.current;
  return !canvas || dabPaints(context, state, new Vector2(aim.x, aim.y), canvas);
}

function dabPaints(context: FileStrokeContext, state: State, cursor: Vector2, canvas: WindowedCanvas): boolean {
  const span = dabSpan(context, state, cursor, canvas);
  if (!reachOf(context, state).refusal && canvas.servable(span.extent, span.needs)) return true;
  return besideFor(context, state, cursor, span, canvas) !== null;
}

/**
 * Why the brush cannot paint, or null when it can. Aimed at a spot on a
 * canvas, a brush that reads too much there is told which settings would let
 * it paint.
 */
export function strokeRefusal(context: FileStrokeContext, state: State, aim?: { x: number; y: number }): string | null {
  const waiting = fileAwaitingOnsets(context, state);
  if (waiting) return onsetsPendingRefusal(waiting.displayName);
  const reach = reachOf(context, state);
  const canvas = context.canvasRef.current;
  if (!canvas || !aim) return reach.refusal;
  const cursor = new Vector2(aim.x, aim.y);
  if (dabPaints(context, state, cursor, canvas)) return null;
  return reachFixMessage(reachFixes(state, (moved) => !dabPaints(context, moved, cursor, canvas)));
}

/** The frames a dab writing `writes` reads, `around` either side. */
function readSpanOfDab(
  writes: readonly FrameSpan[],
  around: { before: number; after: number },
  numFrames: number,
): { startFrame: number; endFrame: number } | null {
  if (writes.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const write of writes) {
    start = Math.min(start, write.start);
    end = Math.max(end, write.end);
  }
  return { startFrame: Math.max(0, start - around.before), endFrame: Math.min(numFrames, end + around.after) };
}

/** What a dab reads while it writes the part of itself inside `clip`. */
function readSpanOf(extent: DabExtent, clip: FrameSpan): FrameSpan {
  const before = Math.max(extent.before, extent.piece?.before ?? 0);
  const after = Math.max(extent.after, extent.piece?.after ?? 0);
  let start = clip.end;
  let end = clip.start;
  for (const write of extent.writes) {
    if (write.end <= clip.start || write.start >= clip.end) continue;
    start = Math.min(start, Math.max(clip.start, write.start));
    end = Math.max(end, Math.min(clip.end, write.end));
  }
  if (end <= start) return { start: clip.start, end: clip.start };
  return { start: Math.max(0, start - before), end: end + after };
}

/** What a dab that writes one span reads; null for one that wraps past the end of the file. */
function wholeReadSpan(extent: DabExtent): FrameSpan | null {
  if (extent.writes.length !== 1) return null;
  const [write] = extent.writes;
  return { start: Math.max(0, write.start - extent.before), end: write.end + extent.after };
}

/**
 * The file frames a dab writes: its union's time span, cut in two where a
 * wrapping brush runs past either end of the file.
 */
function dabWrites(union: BrushUnionUv, cursorX: number, numFrames: number): FrameSpan[] {
  const start = (union.hasSteps ? union.min.x : cursorX) * numFrames;
  const end = (union.hasSteps ? union.max.x : cursorX) * numFrames;
  if (!union.wrapsTime || (start >= 0 && end <= numFrames)) {
    return [{ start: Math.max(0, start), end: Math.min(numFrames, Math.max(end, start)) }];
  }
  if (start < 0)
    return [
      { start: start + numFrames, end: numFrames },
      { start: 0, end },
    ];
  return [
    { start, end: numFrames },
    { start: 0, end: end - numFrames },
  ];
}

export function dabSpan(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  canvas: WindowedCanvas,
  resolvedUnion?: BrushUnionUv,
): DabSpan {
  const { fileId, spectrogramData, openFiles } = context;
  const file = openFiles[fileId];
  const bpm = state.filepathsBpm[file.filePath] || 120;
  const { numFrames, sampleRate } = spectrogramData;
  const totalDuration = numFrames / sampleRate;
  const none = { before: 0, after: 0 };
  const reach: StateReach = canvas.holdsWholeFile
    ? { refusal: null, frames: none, piece: none }
    : reachOf(context, state);
  const union = resolvedUnion ?? brushUnionAt(context, state, cursorPos, bpm, totalDuration);
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const readsLive = steps.some(
    (step, index) => step.enabled !== false && context.createStepStateView(state, index).accumulate,
  );
  // A pixel at either end of what the dab writes interpolates over the next
  // bin of its band, which in the coarsest band lies a whole bin past it.
  const seam = canvas.holdsWholeFile ? 0 : coarsestBinFrames(canvas.grid);
  // A dab that reads the canvas as it leaves it would read, across a cut,
  // what its own earlier piece painted, so it is painted whole.
  let extent: DabExtent = {
    writes: dabWrites(union, cursorPos.x, numFrames),
    before: reach.frames.before + seam,
    after: reach.frames.after + seam,
    readsLive,
    piece:
      readsLive && !canvas.holdsWholeFile
        ? null
        : reach.piece && { before: reach.piece.before + seam, after: reach.piece.after + seam },
  };
  const around = extent.piece
    ? { before: Math.max(extent.before, extent.piece.before), after: Math.max(extent.after, extent.piece.after) }
    : { before: extent.before, after: extent.after };
  let sources = sourceReadsFor(context, state, cursorPos, around);
  const impulseBindings = impulseNeedsFor(context, state, readSpanOfDab(extent.writes, around, numFrames));
  const needs: DabNeeds = {
    sources,
    impulses: impulseBindings.map((entry) => entry.need).filter((need) => responseIsWindowed(context, need.fileId)),
    original: wantsOriginal(context, state),
  };
  // A read of this file near enough for the canvas to hold alongside the dab
  // is read off the canvas; one further away goes through a window of its own.
  if (sources.some((read) => read.self)) {
    const near = withSelfReads(extent, sources);
    const others = sources.filter((read) => !read.self);
    if (canvas.servable(near, { ...needs, sources: others }) && selfReadsInFile(sources)) {
      extent = near;
      sources = others;
      needs.sources = others;
    }
  }
  // A brush wrapping in time reads past an end of the file at the other end,
  // which no window holds beside it, so such a dab is painted beside the
  // canvas, over the whole file.
  if (!canvas.holdsWholeFile && union.wrapsTime && readsPastEnds(extent, numFrames))
    extent = { ...extent, before: numFrames, after: numFrames, piece: null };
  const whole = wholeReadSpan(extent);
  const cursorBlock = blockOfFrame(canvas.grid, Math.min(numFrames - 1, Math.max(0, cursorPos.x * numFrames)));
  const hover =
    whole && canvas.fitsWindow(whole.start, whole.end) ? whole : blockReadSpan(canvas.grid, extent, cursorBlock);
  return { extent, hover, needs, impulseBindings };
}

/** True when a dab reads past either end of a file `numFrames` long. */
function readsPastEnds(extent: DabExtent, numFrames: number): boolean {
  const before = Math.max(extent.before, extent.piece?.before ?? 0);
  const after = Math.max(extent.after, extent.piece?.after ?? 0);
  return extent.writes.some((write) => write.start - before < 0 || write.end + after > numFrames);
}

/** True when every read of this file stays inside the file, where the canvas can hold it. */
function selfReadsInFile(reads: readonly SourceRead[]): boolean {
  return reads.every(
    (read) =>
      !read.self ||
      (Math.min(read.read.start, read.read.end) >= 0 && Math.max(read.read.start, read.read.end) <= read.numFrames),
  );
}

/** The bands [first, last] a pitch UV span covers, one band either side for the reads between bands. */
function bandsOfPitch(minY: number, maxY: number, numBands: number): BandSpan {
  const a = pitchUvToBandIndex(Math.min(1, Math.max(0, maxY)), numBands);
  const b = pitchUvToBandIndex(Math.min(1, Math.max(0, minY)), numBands);
  return {
    first: Math.max(0, Math.floor(Math.min(a, b)) - 1),
    last: Math.min(numBands - 1, Math.ceil(Math.max(a, b)) + 1),
  };
}

// The most tiles one dab is cut into beside the canvas before it is refused.
const MAX_BESIDE_TILES = 4096;

// Coarsest-band bins a part of a tile's input holds before and after its own
// reads: one a sample interpolates over, and the four a tonality check looks
// back over from where the onset transport moves the read.
const PART_BINS_BEFORE = 6;
const PART_BINS_AFTER = 2;
// The transform algorithm that reads under the pixel it writes as well.
const SNAPPY_ALGORITHM = 2;

/** The bands a region of the file covers any of. */
function bandsOfBox(box: ReadBox, numBands: number): BandSpan {
  return {
    first: Math.max(0, Math.floor(pitchUvToBandIndex(box.high, numBands) + 1e-9)),
    last: Math.min(numBands - 1, Math.ceil(pitchUvToBandIndex(box.low, numBands) - 1e-9) - 1),
  };
}

/**
 * One piece of a dab painted beside the canvas: the view it paints on, the
 * view its first step reads its input through when that is apart, the bands
 * and frames it keeps, the frames and bands it reads, and where it reads
 * other files, which windows over them are placed by.
 */
type BesideTile = {
  view: CanvasView;
  input: CanvasView | null;
  bands: BandSpan;
  frames: FrameSpan;
  reads: FrameSpan;
  readBands: BandSpan;
  others: ReadPart;
  /** The frames and bands the first step reads apart, when it does. */
  inputBox: { frames: FrameSpan; bands: BandSpan } | null;
  /**
   * For a first step that sums copies along time: the view of what it reads
   * besides those copies, and the frames and bands each copy reads.
   */
  copies: { own: CanvasView; taps: { frames: FrameSpan; bands: BandSpan }[] } | null;
  /** The input read a part at a time, when one view of it holds more than a window. */
  parts?: InputPartPlan[];
};

/**
 * One part of a tile's input: the view it is read through, and which reads it
 * serves: the file frames and bands of its `core`, unbounded where it takes
 * every read past the input's edge, or the copies of its `taps`.
 */
type InputPartPlan = { view: CanvasView; core?: InputPart["core"]; taps?: InputPart["taps"] };

/**
 * A step's brush as the region it covers, past the file's ends where it runs
 * past them, as the shaders pivot it; all of the file along an axis it wraps
 * round.
 */
function brushBox(brush: StepBrush, fileSeconds: number): BrushBox {
  const endX = brush.anchor.x + brush.sizeUv.x;
  const endY = brush.anchor.y + brush.sizeUv.y;
  const roundTime = brush.wrapsTime && (brush.anchor.x < 0 || endX > 1);
  const roundPitch = brush.wrapsPitch && (brush.anchor.y < 0 || endY > 1);
  return {
    start: roundTime ? 0 : brush.anchor.x * fileSeconds,
    end: roundTime ? fileSeconds : endX * fileSeconds,
    low: roundPitch ? 0 : brush.anchor.y,
    high: roundPitch ? 1 : endY,
    wrapsTime: brush.wrapsTime,
    wrapsPitch: brush.wrapsPitch,
  };
}

/**
 * How a dab is cut into tiles beside the canvas: the frames and bands it
 * writes, the tile over any part of them, and the ways a tile halves.
 */
type BesideTiling = {
  renderer: StrokeRenderer;
  start: number;
  end: number;
  union: BrushUnionUv;
  whole: boolean;
  written: BandSpan;
  tileOf: (bands: BandSpan, frames: FrameSpan) => BesideTile;
  halves: (tile: BesideTile) => [BesideTile, BesideTile][];
  partsOf: (tile: BesideTile, budget: number, most: number) => InputPartPlan[] | null;
  copyGroupsOf: (tile: BesideTile, budget: number, most: number) => InputPartPlan[] | null;
};

function besideTiling(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  span: DabSpan,
  canvas: WindowedCanvas,
): BesideTiling | null {
  const renderer = context.strokeRendererRef.current;
  const file = context.openFiles[context.fileId];
  const ctx = reachContext(context, state);
  if (!renderer || !file || !ctx) return null;
  const { numBands, numFrames, sampleRate } = context.spectrogramData;
  const { grid } = canvas;
  let start = numFrames;
  let end = 0;
  for (const write of span.extent.writes) {
    start = Math.min(start, write.start);
    end = Math.max(end, write.end);
  }
  if (end <= start) return null;
  const union = brushUnionAt(context, state, cursorPos, ctx.bpm, ctx.fileSeconds);
  const whole = union.fullPitch || union.wrapsPitch;
  const written: BandSpan = whole ? { first: 0, last: numBands - 1 } : bandsOfPitch(union.min.y, union.max.y, numBands);
  const brushes = stepBrushesAt(context, state, cursorPos, ctx.bpm, ctx.fileSeconds).map((brush) =>
    brushBox(brush, ctx.fileSeconds),
  );
  // A step reading this file near the dab reads it off the canvas, moved.
  const moves = span.needs.sources.some((read) => read.self)
    ? []
    : sourceReadsFor(context, state, cursorPos)
        .filter((read) => read.self)
        .map((read) => (read.read.start - read.dest.start) / sampleRate);
  const seam = coarsestBinFrames(grid);

  // The first step reads the painted file off the canvas unless it reads
  // another file or a window of this one far away. Its warped read then goes
  // through a view of its own, unless a step also reads the original.
  const firstSource = state.brushes[state.activeBrushIndex]?.steps[firstEnabledStep(state)]?.sourceFile?.path;
  const firstReadsHere =
    !span.needs.sources.some((read) => read.self) &&
    (firstSource === undefined
      ? (state.activeFileId || context.fileId) === context.fileId
      : context.getOpenFileByPath(firstSource)?.id === context.fileId);
  const inputApart = firstReadsHere && !span.needs.original;
  const framesOfBox = (box: ReadBox): FrameSpan => {
    let readStart = box.start;
    let readEnd = box.end;
    for (const move of moves) {
      readStart = Math.min(readStart, box.start + move);
      readEnd = Math.max(readEnd, box.end + move);
    }
    const first = Math.max(0, Math.floor(readStart * sampleRate) - seam);
    return { start: first, end: Math.max(first + 1, Math.min(numFrames, Math.ceil(readEnd * sampleRate) + seam)) };
  };
  const viewOfBox = (box: ReadBox): CanvasView => {
    const frames = framesOfBox(box);
    return canvasViewOfFrames(grid, frames.start, frames.end, bandsOfBox(box, numBands));
  };
  const tileOf = (bands: BandSpan, frames: FrameSpan): BesideTile => {
    const { own, input, taps } = readBoxes(
      state,
      ctx,
      {
        start: frames.start / sampleRate,
        end: frames.end / sampleRate,
        low: bandIndexToPitchUv(bands.last + 1, numBands),
        high: bandIndexToPitchUv(bands.first, numBands),
      },
      brushes,
    );
    // What the brush reads with its copies along time on the tile's own view.
    const whole = taps ? taps.reduce(unionBox, own) : own;
    const read = input ? unionBox(own, input) : whole;
    const reads = framesOfBox(read);
    const readBands = bandsOfBox(read, numBands);
    // The first step reads its input where the warp puts it; other files it
    // reads there are read only there, not over the span to the dab.
    const others: ReadPart = input ? { first: framesOfBox(input), rest: framesOfBox(own) } : reads;
    if (!input || inputApart) {
      const inputBox = input && { frames: framesOfBox(input), bands: bandsOfBox(input, numBands) };
      const copies =
        taps && inputApart
          ? {
              own: viewOfBox(own),
              taps: taps.map((box) => ({ frames: framesOfBox(box), bands: bandsOfBox(box, numBands) })),
            }
          : null;
      return {
        view: viewOfBox(whole),
        input: input && viewOfBox(input),
        bands,
        frames,
        reads,
        readBands,
        others,
        inputBox,
        copies,
      };
    }
    return {
      view: viewOfBox(firstReadsHere ? unionBox(own, input) : own),
      input: null,
      bands,
      frames,
      reads,
      readBands,
      others,
      inputBox: null,
      copies: null,
    };
  };
  const framesOf = (from: number, to: number): FrameSpan => ({
    start: Math.max(start, frameRangeOfBlock(grid, from).start),
    end: Math.min(end, frameRangeOfBlock(grid, to).end),
  });
  const quantum = gridQuantumFrames(grid);
  const halves = (tile: BesideTile): [BesideTile, BesideTile][] => {
    const out: [BesideTile, BesideTile][] = [];
    const from = blockOfFrame(grid, tile.frames.start);
    const to = blockOfFrame(grid, tile.frames.end - 1);
    const cut = Math.round((tile.frames.start + tile.frames.end) / 2 / quantum) * quantum;
    if (to > from) {
      const mid = Math.floor((from + to) / 2);
      out.push([tileOf(tile.bands, framesOf(from, mid)), tileOf(tile.bands, framesOf(mid + 1, to))]);
    } else if (cut > tile.frames.start && cut < tile.frames.end) {
      out.push([
        tileOf(tile.bands, { start: tile.frames.start, end: cut }),
        tileOf(tile.bands, { start: cut, end: tile.frames.end }),
      ]);
    }
    const { first, last } = tile.bands;
    if (last > first) {
      const mid = Math.floor((first + last) / 2);
      out.push([tileOf({ first, last: mid }, tile.frames), tileOf({ first: mid + 1, last }, tile.frames)]);
    }
    return out;
  };
  // A part reads around each of its own reads: the bins a sample interpolates
  // over, and the bins a tonality check looks back over, in the coarsest band.
  const partBefore = PART_BINS_BEFORE * seam;
  const partAfter = PART_BINS_AFTER * seam;
  const firstStep = firstEnabledStep(state);
  const firstBrush = brushes[firstStep];
  // One read point a pixel: Snappy also reads under the pixel it writes, and a
  // wrapped read folds back across the whole axis.
  const partable =
    Number(context.createStepStateView(state, firstStep).algorithm) !== SNAPPY_ALGORITHM &&
    !(firstBrush?.wrapsTime || firstBrush?.wrapsPitch);
  // The view a part reads its reads of `frames` and `bands` through.
  const viewOfCore = (frames: FrameSpan, bands: BandSpan): CanvasView =>
    canvasViewOfFrames(grid, Math.max(0, frames.start - partBefore), Math.min(numFrames, frames.end + partAfter), {
      first: Math.max(0, bands.first - 1),
      last: Math.min(numBands - 1, bands.last + 1),
    });
  const partsOf = (tile: BesideTile, budget: number, most: number): InputPartPlan[] | null => {
    const box = tile.inputBox;
    if (!partable || !box) return null;
    const parts: { frames: FrameSpan; bands: BandSpan; view: CanvasView }[] = [];
    const pending = [{ ...box, view: viewOfCore(box.frames, box.bands) }];
    for (let part = pending.pop(); part; part = pending.pop()) {
      if (part.view.texels <= budget) {
        parts.push(part);
        continue;
      }
      if (parts.length + pending.length + 2 > most) return null;
      const { frames, bands } = part;
      const cut = Math.round((frames.start + frames.end) / 2 / quantum) * quantum;
      const mid = Math.floor((bands.first + bands.last) / 2);
      const splits: [FrameSpan, BandSpan, FrameSpan, BandSpan][] = [];
      if (cut > frames.start && cut < frames.end)
        splits.push([{ start: frames.start, end: cut }, bands, { start: cut, end: frames.end }, bands]);
      if (bands.last > bands.first)
        splits.push([frames, { first: bands.first, last: mid }, frames, { first: mid + 1, last: bands.last }]);
      const halved = splits
        .map(([fa, ba, fb, bb]) => [
          { frames: fa, bands: ba, view: viewOfCore(fa, ba) },
          { frames: fb, bands: bb, view: viewOfCore(fb, bb) },
        ])
        .filter(([a, b]) => Math.max(a.view.texels, b.view.texels) < part.view.texels)
        .sort(([a, b], [c, d]) => Math.max(a.view.texels, b.view.texels) - Math.max(c.view.texels, d.view.texels))[0];
      if (!halved) return null;
      pending.push(...halved);
    }
    // The parts at the input's edges take every read past it.
    return parts.map(({ frames, bands, view }) => ({
      view,
      core: {
        start: frames.start === box.frames.start ? -Infinity : frames.start,
        end: frames.end === box.frames.end ? Infinity : frames.end,
        first: bands.first === box.bands.first ? -Infinity : bands.first,
        last: bands.last === box.bands.last ? Infinity : bands.last,
      },
    }));
  };
  // Copies are taken in order, as many to a group as one view of them fits.
  const copyGroupsOf = (tile: BesideTile, budget: number, most: number): InputPartPlan[] | null => {
    const taps = tile.copies?.taps;
    if (!partable || !taps) return null;
    const groups: InputPartPlan[] = [];
    for (let first = 0; first < taps.length; ) {
      let last = first;
      let frames = taps[first].frames;
      let bands = taps[first].bands;
      let view = viewOfCore(frames, bands);
      if (view.texels > budget || groups.length >= most) return null;
      for (let next = first + 1; next < taps.length; next++) {
        const wider = {
          start: Math.min(frames.start, taps[next].frames.start),
          end: Math.max(frames.end, taps[next].frames.end),
        };
        const across = {
          first: Math.min(bands.first, taps[next].bands.first),
          last: Math.max(bands.last, taps[next].bands.last),
        };
        const merged = viewOfCore(wider, across);
        if (merged.texels > budget) break;
        [last, frames, bands, view] = [next, wider, across, merged];
      }
      groups.push({ view, taps: { first, last } });
      first = last + 1;
    }
    return groups;
  };
  return { renderer, start, end, union, whole, written, tileOf, halves, partsOf, copyGroupsOf };
}

/**
 * The region of the file a dab aimed at `aim` reads: beside the canvas, the
 * bands and frames of the one tile that would paint all of it; on the canvas,
 * the frames around what it writes, over every band; and the frames of this
 * file it reads through windows of their own, a response or a far read.
 * Null when the dab writes nothing.
 */
export function dabReadRegion(
  context: FileStrokeContext,
  state: State,
  aim: { x: number; y: number },
): { beside: { bands: BandSpan; frames: FrameSpan }; canvas: FrameSpan; apart: FrameSpan[] } | null {
  const canvas = context.canvasRef.current;
  if (!canvas) return null;
  const cursor = new Vector2(aim.x, aim.y);
  const span = dabSpan(context, state, cursor, canvas);
  const tiling = besideTiling(context, state, cursor, span, canvas);
  if (!tiling) return null;
  const root = tiling.tileOf(tiling.written, { start: tiling.start, end: tiling.end });
  const { extent } = span;
  const before = Math.max(extent.before, extent.piece?.before ?? 0);
  const after = Math.max(extent.after, extent.piece?.after ?? 0);
  const apart = [
    ...span.impulseBindings.map((entry) => entry.need),
    ...span.needs.sources
      .filter((read) => read.self)
      .map((read) => ({ fileId: read.fileId, ...sourceReadSpan(read.read, read.numFrames, read.pad) })),
  ]
    .filter((need) => need.fileId === context.fileId)
    .map((need) => ({ start: need.startFrame, end: need.endFrame }));
  return {
    beside: { bands: root.readBands, frames: root.reads },
    canvas: {
      start: Math.max(0, tiling.start - before),
      end: Math.min(context.spectrogramData.numFrames, tiling.end + after),
    },
    apart,
  };
}

/**
 * How to paint a dab the canvas window cannot hold: beside the canvas, in
 * tiles of bands over spans of frames. Each tile is read through a view of the
 * region its effects read to paint it, and a tile whose view holds more than
 * a window is halved, across bands or in time, whichever reads less. Every tile
 * reads the file as it was before the dab, so the tiles never read each
 * other's paint, and a dab that reads the canvas as it paints is cut as any
 * other. Null when a tile that cannot shrink its read still reads more than a
 * view holds.
 */
function besideFor(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  span: DabSpan,
  canvas: WindowedCanvas,
  options: DispatchOptions = {},
): PaintBeside | null {
  const tiling = besideTiling(context, state, cursorPos, span, canvas);
  if (!tiling) return null;
  const { renderer, start, end, union, whole, written, tileOf, halves, partsOf, copyGroupsOf } = tiling;

  const budget = canvas.texelBudget;
  const cost = (tile: BesideTile): number => Math.max(tile.view.texels, tile.input?.texels ?? 0);
  let partCount = 0;
  // A tile whose own view fits reads an input too wide for one view a part at
  // a time, and one whose copies along time no one view holds reads them a
  // group at a time.
  const fits = (tile: BesideTile): boolean => {
    if (!canvas.othersFit(span.needs, tile.others)) return false;
    if (tile.view.texels <= budget) {
      if ((tile.input?.texels ?? 0) <= budget) return true;
      const parts = partsOf(tile, budget, MAX_BESIDE_TILES - partCount);
      if (!parts) return false;
      tile.parts = parts;
      partCount += parts.length;
      return true;
    }
    const own = tile.copies?.own;
    if (!own || own.texels > budget) return false;
    const groups = copyGroupsOf(tile, budget, MAX_BESIDE_TILES - partCount);
    if (!groups) return false;
    tile.view = own;
    tile.parts = groups;
    partCount += groups.length;
    return true;
  };
  const larger = ([a, b]: [BesideTile, BesideTile]): number => Math.max(cost(a), cost(b));
  const tiles: BesideTile[] = [];
  const pending = [tileOf(written, { start, end })];
  for (let tile = pending.pop(); tile; tile = pending.pop()) {
    if (fits(tile)) {
      tiles.push(tile);
      continue;
    }
    // A split must not read more; smaller tiles may read less further down.
    const split = halves(tile)
      .filter((pair) => larger(pair) <= cost(tile))
      .sort((a, b) => larger(a) - larger(b))[0];
    if (!split || tiles.length + pending.length >= MAX_BESIDE_TILES) return null;
    pending.push(...split);
  }
  const compute = async (tileDone: () => boolean): Promise<StrokePaint | null> => {
    const parts: StrokePaint[] = [];
    const timing: BesideTiming = { readMs: 0, setupMs: 0, paintMs: 0, readbackMs: 0 };
    const started = performance.now();
    for (const tile of tiles) {
      const part = await paintTileBeside(context, state, cursorPos, span, canvas, renderer, tile, options, timing);
      if (!part || !tileDone()) return null;
      parts.push(part);
    }
    const joined = joinPaint(parts);
    diag.info("canvas", "beside dab", {
      tiles: tiles.length,
      parts: partCount,
      texels: tiles.reduce((sum, tile) => sum + tile.view.texels, 0),
      ...timing,
      totalMs: performance.now() - started,
    });
    return joined;
  };
  const pitch = whole ? { min: 0, max: 1 } : { min: Math.max(0, union.min.y), max: Math.min(1, union.max.y) };
  return { compute, tiles: tiles.length, pitch };
}

/** Milliseconds a dab painted beside the canvas spent in each phase, over all its tiles. */
type BesideTiming = { readMs: number; setupMs: number; paintMs: number; readbackMs: number };

/**
 * Paints the dab on a renderer beside the canvas over the tile's view,
 * loaded with the file as the stroke found it and the stroke's paint so far,
 * and returns what it painted on the tile's bands and frames.
 */
async function paintTileBeside(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  span: DabSpan,
  canvas: WindowedCanvas,
  renderer: StrokeRenderer,
  tile: BesideTile,
  options: DispatchOptions,
  timing: BesideTiming,
): Promise<StrokePaint | null> {
  const { view, bands, frames } = tile;
  let at = performance.now();
  const lap = (phase: keyof BesideTiming): void => {
    const now = performance.now();
    timing[phase] += now - at;
    at = now;
  };
  const fileRanges = heldRanges(view.ranges);
  const [start, paint, original] = await Promise.all([
    canvas.readStart(fileRanges),
    canvas.readStrokePaint(fileRanges),
    span.needs.original ? canvas.readOriginal(fileRanges) : Promise.resolve(null),
  ]);
  if (!start || (span.needs.original && !original)) return null;
  if (!(await canvas.holdOthers(span.needs, tile.others))) return null;
  const parts = tile.parts ? await readParts(context, state, canvas, tile.parts) : null;
  if (tile.parts && !parts) return null;
  const input = parts ? parts.first : tile.input ? await inputSource(context, state, canvas, tile.input) : null;
  if (tile.input && !input) return null;
  lap("readMs");
  const layout = { numBands: context.spectrogramData.numBands, metadata: context.spectrogramData.metadata };
  const beside = renderer.beside(view);
  const originalTexture = original ? viewTexture(view, original) : null;
  try {
    beside.initialize();
    beside.setFBOData(viewTexels(view, start));
    beside.holdStrokeScratch();
    const painted = pixelRangeCount(paint.ranges) > 0 ? fileRangesToView(view, layout, paint.ranges) : null;
    if (painted) {
      beside.patchCanvasCompact(paint.values, painted);
      beside.patchStrokeMasks(painted, paint.masks);
    }
    if (originalTexture) beside.setOriginalTexture(originalTexture);
    beside.beginStroke();
    lap("setupMs");
    const painting = {
      ...options,
      span,
      clip: frames,
      beside: { renderer: beside, view, input: input?.source, inputParts: parts?.parts, reads: tile.others },
    };
    if (!dispatchStroke(context, state, cursorPos, false, painting)) return null;
    lap("paintMs");
    const dirty = beside.getDirtyPixelRanges();
    const onBands = dirty ? viewRangesToFile(view, rangesOnBands(view, dirty, bands)) : new Uint32Array(0);
    const keptFile = intersectPixelRanges(onBands, frameSpanPixels(canvas, frames));
    const kept = pixelRangeCount(keptFile) > 0 ? fileRangesToView(view, layout, keptFile) : null;
    if (!kept) return { ranges: new Uint32Array(0), values: new Float32Array(0), masks: [] };
    const [values, masks] = await Promise.all([beside.readPixelRanges(kept), beside.readStrokeMaskRanges(kept)]);
    lap("readbackMs");
    return { ranges: keptFile, values, masks };
  } finally {
    beside.dispose();
    originalTexture?.dispose();
    input?.dispose();
  }
}

/**
 * A tile's input parts, read now and laid into textures one at a time as the
 * renderer draws them: the first part's source, which the dab's uniforms are
 * laid out from, and every part. Null when a read fails.
 */
async function readParts(
  context: FileStrokeContext,
  state: State,
  canvas: WindowedCanvas,
  plans: readonly InputPartPlan[],
): Promise<{ first: { source: SourceFileInfo; dispose: () => void }; parts: InputPart[] } | null> {
  const values: Float32Array[] = [];
  for (const read of await Promise.all(plans.map((plan) => inputValues(state, canvas, plan.view, context)))) {
    if (!read) return null;
    values.push(read);
  }
  const first = inputOver(context, state, plans[0].view, values[0]);
  if (!first) return null;
  const parts = plans.map(
    (plan, index): InputPart => ({
      core: plan.core,
      taps: plan.taps,
      source: () => {
        if (index === 0) return { source: first.source, dispose: () => {} };
        const made = inputOver(context, state, plan.view, values[index]);
        if (!made) throw new Error("the painted file closed while its input was read in parts");
        return made;
      },
    }),
  );
  return { first, parts };
}

/**
 * The painted file over `view` as the first step of the brush reads it: with
 * the stroke's paint so far for an accumulating step that reads it as it
 * stands, and as the stroke found it otherwise.
 */
async function inputSource(
  context: FileStrokeContext,
  state: State,
  canvas: WindowedCanvas,
  view: CanvasView,
): Promise<{ source: SourceFileInfo; dispose: () => void } | null> {
  const values = await inputValues(state, canvas, view, context);
  return values ? inputOver(context, state, view, values) : null;
}

/** The values `inputSource` lays over `view`, compact over its held bands. */
async function inputValues(
  state: State,
  canvas: WindowedCanvas,
  view: CanvasView,
  context: FileStrokeContext,
): Promise<Float32Array | null> {
  const ranges = heldRanges(view.ranges);
  const first = context.createStepStateView(state, firstEnabledStep(state));
  const live = first.accumulate && first.sourceDataMode !== "start";
  const [start, paint] = await Promise.all([
    canvas.readStart(ranges),
    live ? canvas.readStrokePaint(ranges) : Promise.resolve(null),
  ]);
  if (!start) return null;
  return paint && pixelRangeCount(paint.ranges) > 0
    ? composePixelRangeValues(ranges, [paint, { ranges, values: start }])
    : start;
}

/** The painted file's `values` over `view` as a source a step reads. */
function inputOver(
  context: FileStrokeContext,
  state: State,
  view: CanvasView,
  values: Float32Array,
): { source: SourceFileInfo; dispose: () => void } | null {
  const file = context.openFiles[context.fileId];
  if (!file) return null;
  const packed = viewTexture(view, values);
  const { spectrogramData } = context;
  const metadata = bandMetadataTexture(view.layout, spectrogramData.sampleRate);
  const source: SourceFileInfo = {
    id: `${context.fileId}:input`,
    filePath: file.filePath,
    displayName: file.displayName,
    spectrogramData,
    textures: { packed: { texture: packed, dispose: () => packed.dispose() }, metadata },
    view,
    onsetTexture: getOnsetTexture(
      context.fileId,
      file.onsets,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      state.filepathsOnsetSensitivity[file.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
    ),
  };
  return {
    source,
    dispose: () => {
      packed.dispose();
      metadata.dispose();
    },
  };
}

/** Every band's file pixels over the blocks a frame span covers, cut to its frames. */
function frameSpanPixels(canvas: WindowedCanvas, frames: FrameSpan): Uint32Array {
  const view = canvasViewOf(
    canvas.grid,
    blockOfFrame(canvas.grid, frames.start),
    blockOfFrame(canvas.grid, frames.end - 1),
  );
  const out: number[] = [];
  const { metadata, numBands } = view.layout;
  for (let band = 0; band < numBands; band++) {
    const step = 2 ** metadata[band * 4 + 2];
    const k0 = view.bandK0[band];
    const count = view.ranges[band * 2 + 1];
    const from = Math.max(k0, Math.ceil(frames.start / step));
    const to = Math.min(k0 + count, Math.ceil(frames.end / step));
    if (to > from) out.push(view.ranges[band * 2] + (from - k0), to - from);
  }
  return Uint32Array.from(out);
}

/** A view's file ranges without the bands it holds no bins of. */
function heldRanges(ranges: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) if (ranges[i + 1] > 0) out.push(ranges[i], ranges[i + 1]);
  return Uint32Array.from(out);
}

/** The view's own pixel ranges that lie on the bands of `bands`. */
function rangesOnBands(view: CanvasView, ranges: Uint32Array, bands: BandSpan): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const band = bandAtPixel(view.layout, ranges[i]);
    if (band >= bands.first && band <= bands.last) out.push(ranges[i], ranges[i + 1]);
  }
  return Uint32Array.from(out);
}

/** Values compact over a view's held bands, padded to the view's texture. */
function viewTexels(view: CanvasView, values: Float32Array): Float32Array {
  const texels = new Float32Array(view.textureWidth * view.textureHeight * 4);
  texels.set(values);
  return texels;
}

/** Values compact over a view's held bands as a texture laid out as the view is. */
function viewTexture(view: CanvasView, values: Float32Array): DataTexture {
  const texture = new DataTexture(
    viewTexels(view, values),
    view.textureWidth,
    view.textureHeight,
    RGBAFormat,
    FloatType,
  );
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Paint from pieces over different bands as one. */
function joinPaint(parts: readonly StrokePaint[]): StrokePaint {
  const ranges = Uint32Array.from(parts.flatMap((part) => Array.from(part.ranges)));
  const values = new Float32Array(parts.reduce((sum, part) => sum + part.values.length, 0));
  let at = 0;
  for (const part of parts) {
    values.set(part.values, at);
    at += part.values.length;
  }
  const steps = Math.max(0, ...parts.map((part) => part.masks.length));
  const masks: (Float32Array | null)[] = [];
  for (let step = 0; step < steps; step++) {
    if (parts.every((part) => !part.masks[step])) {
      masks.push(null);
      continue;
    }
    const weights = new Float32Array(values.length >> 2);
    let offset = 0;
    for (const part of parts) {
      const mask = part.masks[step];
      if (mask) weights.set(mask, offset);
      offset += part.values.length >> 2;
    }
    masks.push(weights);
  }
  return { ranges, values, masks };
}

/**
 * Paints one dab through the canvas: on it, a block at a time as it holds
 * them, when a window can serve what the dab reads, and beside it otherwise —
 * the choice strokeRefusal makes for an aimed dab. False when neither can.
 * `painted` is called each time a piece lands.
 */
export function paintDab(
  context: FileStrokeContext,
  canvas: WindowedCanvas,
  state: State,
  aim: Vector2,
  span: DabSpan,
  options: DispatchOptions = {},
  painted?: () => void,
): boolean {
  if (onsetsPendingFor(context, state)) return false;
  if (!reachOf(context, state).refusal && canvas.servable(span.extent, span.needs)) {
    return canvas.paintWhenHeld(span.extent, span.needs, (clip) => {
      const done = dispatchStroke(context, state, aim, false, { ...options, span, clip });
      if (done) painted?.();
      return done;
    });
  }
  const beside = besideFor(context, state, aim, span, canvas, options);
  if (!beside) return false;
  canvas.paintBeside(span.extent, beside);
  return true;
}

export function prepareStrokeBatch(
  context: FileStrokeContext,
  canvas: WindowedCanvas,
  strokes: StrokeDispatch[],
  ahead?: StrokeDispatch[],
): StrokeBatchResult {
  if (ahead && ahead.length > 0) {
    const first = ahead[0];
    const last = ahead[ahead.length - 1];
    const from = dabSpan(context, first.state, new Vector2(first.aimX, first.aimY), canvas).hover;
    const to = dabSpan(context, last.state, new Vector2(last.aimX, last.aimY), canvas).hover;
    canvas.prefetch(Math.min(from.start, to.start), Math.max(from.end, to.end));
  }
  let painted = 0;
  let refused: StrokeDispatch | null = null;
  for (const stroke of strokes) {
    const aim = new Vector2(stroke.aimX, stroke.aimY);
    const span = dabSpan(context, stroke.state, aim, canvas);
    if (paintDab(context, canvas, stroke.state, aim, span)) painted++;
    else refused ??= stroke;
  }
  return { painted, refused };
}
