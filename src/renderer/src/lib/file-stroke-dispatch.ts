import { notifications } from "@mantine/notifications";
import { Vector2 } from "three";
import type { State, OpenFile, SpectrogramData } from "../store/types";
import type { BrushUnionUv, DabSpan, StrokeDispatch, FileRendererHandle } from "./file-renderer-types";
import { viewCoversFile } from "./canvas-view";
import { sourceReadSpan, type SourceWindowTextures } from "./source-window";
import type { WindowedCanvas, SourceNeed } from "./windowed-canvas";
import { blockOfFrame } from "./block-grid";
import { blockReadSpan, type DabExtent, type FrameSpan } from "./held-dabs";
import { strokeReach, type ReachContext } from "./effect-reach";
import { strokeRefusal as refusalFor, overReachRefusal } from "./whole-file-gate";
import { impulseNeeds, type ImpulseNeed } from "./impulse-need";
import { GpuMemoryError, type ImpulseFileInfo, type SourceFileInfo, type StrokeRenderer } from "./stroke-renderer";
import { DEFAULT_ONSET_SENSITIVITY } from "./constants";
import { getOnsetTexture, type Onset } from "./onset-map";
import { countDiagStroke } from "./diag-sampler";
import { diag } from "./diag-log";
import { perfMark } from "./perf-probe";
import { penState } from "./pen-state";
import { footprintAimToBlUv } from "./brush-anchor";
import { resolveBrushAnchor, resolveBrushFootprint, swungGridCellWidthUv } from "./utils";

type FileStrokeFile = Pick<OpenFile, "id" | "filePath" | "displayName" | "spectrogramData" | "onsets"> & {
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
  reachByState: WeakMap<State, { refusal: string | null; frames: { before: number; after: number } }>;
}

function sourceNeedsFor(context: FileStrokeContext, state: State, cursorPos: Vector2): SourceNeed[] {
  const { fileId, spectrogramData, strokeRendererRef, canvasRef, openFiles, getOpenFileByPath, createStepStateView } =
    context;
  const strokeRenderer = strokeRendererRef.current;
  const canvas = canvasRef.current;
  const file = openFiles[fileId];
  if (!strokeRenderer || !canvas || !file || cursorPos.x < 0) return [];
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  const bpm = state.filepathsBpm[file.filePath] || 120;
  const needs = new Map<string, SourceNeed>();
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].enabled === false) continue;
    const sourcePath = steps[index].sourceFile?.path;
    if (!sourcePath) continue;
    const source = getOpenFileByPath(sourcePath);
    const sourceSpectrogram = source?.spectrogramData;
    if (!source || !sourceSpectrogram || source.id === fileId) continue;
    const sourceView = source.rendererRef?.current?.getCanvasView();
    if (sourceView && viewCoversFile(sourceView, sourceSpectrogram.numFrames)) continue;

    const read = strokeRenderer.sourceReadFrames(
      state,
      canvas.dabCursor(cursorPos),
      bpm,
      canvas.dabDuration(totalDuration),
      { filePath: source.filePath, spectrogramData: sourceSpectrogram },
      index,
    );
    const span = sourceReadSpan(read, sourceSpectrogram.numFrames);
    const wantOriginal = createStepStateView(state, index).sourceDataMode === "original";
    const held = needs.get(source.id);
    needs.set(
      source.id,
      held
        ? {
            fileId: source.id,
            startFrame: Math.min(held.startFrame, span.startFrame),
            endFrame: Math.max(held.endFrame, span.endFrame),
            wantOriginal: held.wantOriginal || wantOriginal,
          }
        : { fileId: source.id, ...span, wantOriginal },
    );
  }
  return [...needs.values()];
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

function impulseNeedsFor(context: FileStrokeContext, state: State): ImpulseNeed[] {
  return impulseNeeds(state, (path) => {
    const response = responseFileFor(context, path);
    return response?.spectrogramData ? { id: response.id, spectrogramData: response.spectrogramData } : null;
  });
}

export function brushUnionAt(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  bpm: number,
  totalDuration: number,
): BrushUnionUv {
  const { fileId, spectrogramData, createStepStateView, getFileOnsets } = context;
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const min = new Vector2(Infinity, Infinity);
  const max = new Vector2(-Infinity, -Infinity);
  let fullTime = false;
  let fullPitch = false;
  let wrapsTime = false;
  let wrapsPitch = false;
  for (let i = 0; i < steps.length; i++) {
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
    const stepAnchor = resolveBrushAnchor(new Vector2(blX, blY), stepFp.fullTime, stepFp.fullPitch);
    min.x = Math.min(min.x, stepAnchor.x);
    min.y = Math.min(min.y, stepAnchor.y);
    max.x = Math.max(max.x, stepAnchor.x + stepFp.sizeUv.x);
    max.y = Math.max(max.y, stepAnchor.y + stepFp.sizeUv.y);
    if (stepFp.fullTime) fullTime = true;
    if (stepFp.fullPitch) fullPitch = true;
    const stepWrap = stepState.brushWrapMode as number;
    if (stepWrap === 1 || stepWrap === 3) wrapsTime = true;
    if (stepWrap === 2 || stepWrap === 3) wrapsPitch = true;
  }
  const hasSteps = steps.length > 0;
  const sizeUv = hasSteps ? new Vector2(max.x - min.x, max.y - min.y) : new Vector2(0, 0);
  return { min, max, sizeUv, fullTime, fullPitch, wrapsTime, wrapsPitch, hasSteps };
}

export function dispatchStroke(
  context: FileStrokeContext,
  state: State,
  cursorPos: Vector2,
  preview: boolean,
  sourceOverride?: SourceFileInfo,
  preparedSpan?: DabSpan,
  clip?: FrameSpan | null,
): boolean {
  const { fileId, strokeRendererRef, canvasRef, openFiles, getOpenFileByPath } = context;
  const strokeRenderer = strokeRendererRef.current;
  const file = openFiles[fileId];
  if (!strokeRenderer || !file?.spectrogramData) return false;

  const bpm = state.filepathsBpm[file.filePath] || 120;
  const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

  const canvas = canvasRef.current;
  const span = preparedSpan ?? (canvas ? dabSpan(context, state, cursorPos, canvas) : null);
  if (canvas && span) {
    // A preview draws what the canvas holds of a dab wider than a window.
    const reads = clip ? readSpanOf(span.extent, clip) : wholeReadSpan(span.extent);
    const wide = !reads || !canvas.fitsWindow(reads.start, reads.end);
    if (!(preview && wide) && (!reads || !canvas.holdsFrames(reads.start, reads.end, span.needs.original)))
      return false;
  }
  const dabCursor = canvas ? canvas.dabCursor(cursorPos) : cursorPos;
  const dabDuration = canvas ? canvas.dabDuration(totalDuration) : totalDuration;

  if (strokeRefusal(context, state) !== null) return false;

  const sourceWindows = new Map<string, SourceWindowTextures>();
  for (const need of span?.needs.sources ?? sourceNeedsFor(context, state, cursorPos)) {
    const window = canvas?.aimSource(need);
    if (!window) return false;
    sourceWindows.set(need.fileId, window);
  }

  const impulses = new Map<string, ImpulseFileInfo>();
  for (const entry of span?.impulseBindings ?? impulseNeedsFor(context, state)) {
    const response = openFiles[entry.need.fileId];
    const spectrogram = response?.spectrogramData;
    if (!spectrogram) return false;
    if (responseIsWindowed(context, entry.need.fileId)) {
      const window = canvas?.aimImpulse(entry.need);
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
    const textures = window ?? openFile.rendererRef?.current?.getTextures();
    if (!textures) return undefined;
    const ownView = openFile.rendererRef?.current?.getCanvasView();
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
    toSourceInfo(state.activeFileId ? openFiles[state.activeFileId] : undefined) ??
    toSourceInfo(openFiles[fileId]);
  if (!sourceFileInfo) return false;

  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const resolved = new Map<string, SourceFileInfo | undefined>();
  const stepSources = steps.map((step) => {
    const path = step.sourceFile?.path;
    if (path === undefined) return undefined;
    if (sourceOverride) return sourceOverride;
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
          clip: canvas ? canvas.clipToCanvas(clip ?? null) : null,
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

function reachOf(
  context: FileStrokeContext,
  state: State,
): { refusal: string | null; frames: { before: number; after: number } } {
  const { spectrogramData, canvasRef, reachByState } = context;
  const known = reachByState.get(state);
  if (known) return known;
  const ctx = reachContext(context, state);
  const refusal = refusalFor(state, ctx);
  let frames = { before: 0, after: 0 };
  if (ctx) {
    const reach = strokeReach(state, ctx);
    const { numFrames, sampleRate } = spectrogramData;
    frames = {
      before: Math.min(reach.before * sampleRate, numFrames),
      after: Math.min(reach.after * sampleRate, numFrames),
    };
  }
  const entry = { refusal, frames };
  // A reach calculated before the canvas exists must not be cached.
  if (canvasRef.current) reachByState.set(state, entry);
  return entry;
}

export function strokeRefusal(context: FileStrokeContext, state: State, aim?: { x: number; y: number }): string | null {
  const { canvasRef } = context;
  const refusal = reachOf(context, state).refusal;
  const canvas = canvasRef.current;
  if (refusal || !canvas || !aim) return refusal;
  const span = dabSpan(context, state, new Vector2(aim.x, aim.y), canvas);
  return canvas.servable(span.extent) ? null : overReachRefusal(["The brush"]);
}

/** What a dab reads while it writes `clip`. */
function readSpanOf(extent: DabExtent, clip: FrameSpan): FrameSpan {
  return { start: Math.max(0, clip.start - extent.before), end: clip.end + extent.after };
}

/** What a dab that writes one span reads; null for one that wraps past the end of the file. */
function wholeReadSpan(extent: DabExtent): FrameSpan | null {
  if (extent.writes.length !== 1) return null;
  return readSpanOf(extent, extent.writes[0]);
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

function reachFrames(context: FileStrokeContext, state: State): { before: number; after: number } {
  return reachOf(context, state).frames;
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
  const reach = canvas.holdsWholeFile ? { before: 0, after: 0 } : reachFrames(context, state);
  const union = resolvedUnion ?? brushUnionAt(context, state, cursorPos, bpm, totalDuration);
  const impulseBindings = impulseNeedsFor(context, state);
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const readsLive = steps.some(
    (step, index) => step.enabled !== false && context.createStepStateView(state, index).accumulate,
  );
  const extent: DabExtent = {
    writes: dabWrites(union, cursorPos.x, numFrames),
    before: reach.before,
    after: reach.after,
    readsLive,
  };
  const whole = wholeReadSpan(extent);
  const cursorBlock = blockOfFrame(canvas.grid, Math.min(numFrames - 1, Math.max(0, cursorPos.x * numFrames)));
  const hover =
    whole && canvas.fitsWindow(whole.start, whole.end) ? whole : blockReadSpan(canvas.grid, extent, cursorBlock);
  return {
    extent,
    hover,
    needs: {
      sources: sourceNeedsFor(context, state, cursorPos),
      impulses: impulseBindings.map((entry) => entry.need).filter((need) => responseIsWindowed(context, need.fileId)),
      original: wantsOriginal(context, state),
    },
    impulseBindings,
  };
}

export function prepareStrokeBatch(
  context: FileStrokeContext,
  canvas: WindowedCanvas,
  strokes: StrokeDispatch[],
  ahead?: StrokeDispatch[],
): number {
  if (ahead && ahead.length > 0) {
    const first = ahead[0];
    const last = ahead[ahead.length - 1];
    const from = dabSpan(context, first.state, new Vector2(first.aimX, first.aimY), canvas).hover;
    const to = dabSpan(context, last.state, new Vector2(last.aimX, last.aimY), canvas).hover;
    canvas.prefetch(Math.min(from.start, to.start), Math.max(from.end, to.end));
  }
  let painted = 0;
  for (const stroke of strokes) {
    if (strokeRefusal(context, stroke.state) !== null) continue;
    const aim = new Vector2(stroke.aimX, stroke.aimY);
    const span = dabSpan(context, stroke.state, aim, canvas);
    const dabState = stroke.state;
    if (
      canvas.paintWhenHeld(span.extent, span.needs, (clip) =>
        dispatchStroke(context, dabState, aim, false, undefined, span, clip),
      )
    ) {
      painted++;
    }
  }
  return painted;
}
