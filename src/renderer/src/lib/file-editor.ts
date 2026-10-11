import { createStepStateView } from "@/store";
import type { BrushStep } from "@renderer/parameters";
import { getOpenFileByPath, openFiles } from "@renderer/store/files";
import type { useTransientStore } from "@renderer/store/transient";
import type { State, OpenFile } from "@renderer/store/types";
import { Color, Vector2, type WebGLRenderer } from "three";
import { aimUvToBrushBlUv } from "./brush-anchor";
import { prepareVisibleRegion, type FileDisplayResidencyContext } from "./file-display-residency";
import type { FileEngine } from "./file-engine";
import { recordDab } from "./drive-probe";
import { getFileOnsets } from "./file-onsets";
import { brushUnionAt, type FileStrokeContext } from "./file-stroke-dispatch";
import { sourceNeedsOver } from "./source-window";
import {
  destToSourceBandUv,
  resolveBrushAnchor,
  resolveBrushFootprint,
  sourceBandUvSlope,
  swungGridCellWidthUv,
  unitsToUv,
} from "./utils";

function resolveStepSourceFile(state: State, step: BrushStep | undefined): OpenFile | undefined {
  const named = step?.sourceFile ?? null;
  if (named) return getOpenFileByPath(named.path);
  return state.activeFileId ? openFiles[state.activeFileId] : undefined;
}

function calculateSourceOffset(
  lockedOffset: { beats: number; pitch: number } | null | undefined,
  mode: string,
  mousePos: Vector2 | null,
  timeScale: number,
  bandScale: number,
): Vector2 {
  if (!mousePos) {
    return new Vector2(0, 0);
  }

  const scaledMouse = new Vector2(mousePos.x * timeScale, mousePos.y * bandScale);

  if (mode === "follow") {
    return new Vector2(0, 0);
  } else if (mode === "fixed") {
    return scaledMouse.clone().negate();
  } else if (mode === "anchored") {
    if (lockedOffset) {
      return new Vector2(lockedOffset.beats, lockedOffset.pitch);
    } else {
      return scaledMouse.clone().negate();
    }
  }

  return new Vector2(0, 0);
}

/** Prepares the top layer's brush, stroke and source rectangles. */
export function prepareFileEditor(
  engine: FileEngine,
  residencyContext: FileDisplayResidencyContext,
  state: State,
  transient: ReturnType<typeof useTransientStore.getState>,
  gl: WebGLRenderer,
  elapsedTime: number,
  invalidate: () => void,
  bindDisplay: () => void,
): void {
  const fileId = engine.fileId;
  const { spectrogramData, displayMaterial } = residencyContext;
  const { strokeRendererRef, canvasRef, applyStroke, strokePreview, displayMode } = engine;
  const strokeRenderer = strokeRendererRef.current;
  if (!strokeRenderer?.getIsInitialized()) return;
  const strokeContext: FileStrokeContext = {
    fileId,
    spectrogramData,
    strokeRendererRef,
    canvasRef,
    openFiles,
    getOpenFileByPath,
    createStepStateView,
    getFileOnsets,
    closeFile: (id) => state.closeFile(id),
    reachByState: engine.reachByState,
  };
  const { paint: dispatchStroke, span: dabSpan, layDab } = engine.strokeDispatch(strokeContext);
  const { cursorPosition, cursorVisible, hoveredFile: hoveredFileId } = transient;

  const file = openFiles[fileId];
  if (!file || !file.spectrogramData) return;

  const bpm = state.filepathsBpm[file.filePath] || 120;
  const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

  let cursorPos = new Vector2(-1, -1);

  if ((state.activeFileId === fileId || hoveredFileId === fileId) && cursorPosition) {
    const aim = unitsToUv(
      cursorPosition.beats,
      cursorPosition.pitch,
      bpm,
      totalDuration,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );
    cursorPos = new Vector2(aim.x, aim.y);
  }

  const brushSteps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const sourceStepIndex = brushSteps.findIndex((step) => resolveStepSourceFile(state, step)?.id === fileId);
  const sourceStepRaw = sourceStepIndex >= 0 ? brushSteps[sourceStepIndex] : undefined;
  const sourceFileData = resolveStepSourceFile(state, sourceStepRaw);
  const isSourceFile = sourceStepIndex >= 0;

  const union = brushUnionAt(strokeContext, state, cursorPos, bpm, totalDuration);
  const displayFullAxes = { fullTime: union.fullTime, fullPitch: union.fullPitch };
  const displayWrapsTime = union.wrapsTime;
  const displayWrapsPitch = union.wrapsPitch;
  const brushSizeUv = union.sizeUv;
  const brushOriginUv = union.hasSteps ? union.min : cursorPos;

  let sourceDisplayPos = new Vector2(-1, -1);
  // Follow and fixed sources sit relative to the cursor, so with no cursor on
  // a canvas they have nowhere to be drawn; an anchored one stays put.
  let sourceRectPlaced = false;
  if (isSourceFile) {
    const mode = String(sourceStepRaw?.sourcePositionMode ?? "follow");
    const sourcePositionUv =
      mode === "follow"
        ? new Vector2(0, 0)
        : new Vector2(
            (Number(sourceStepRaw?.sourceTimeOffset) || 0) / 100,
            (Number(sourceStepRaw?.sourcePitchOffset) || 0) / 100,
          );
    const shouldTrackCursor =
      (mode === "follow" || mode === "fixed" || (mode === "anchored" && state.isStroking)) &&
      cursorVisible &&
      cursorPosition &&
      state.activeFileId;

    if (shouldTrackCursor) {
      const activeFile = openFiles[state.activeFileId!];
      if (activeFile?.spectrogramData) {
        const activeBpm = state.filepathsBpm[activeFile.filePath] || 120;
        const activeDuration = activeFile.spectrogramData.numFrames / activeFile.spectrogramData.sampleRate;
        const aimDestUv = unitsToUv(
          cursorPosition!.beats,
          cursorPosition!.pitch,
          activeBpm,
          activeDuration,
          activeFile.spectrogramData.bandsPerOctave,
          activeFile.spectrogramData.numBands,
        );
        const { blX: destCursorX, blY: destCursorY } = aimUvToBrushBlUv(
          state,
          aimDestUv.x,
          aimDestUv.y,
          activeBpm,
          activeDuration,
          activeFile.spectrogramData.bandsPerOctave,
          activeFile.spectrogramData.numBands,
          sourceStepIndex,
        );
        const destCursorUv = new Vector2(destCursorX, destCursorY);

        const sourceStepFp = resolveBrushFootprint({
          brushSizeTime: Number(sourceStepRaw?.brushSizeTime ?? 0),
          brushSizePitch: Number(sourceStepRaw?.brushSizePitch ?? 0),
          gridSizeBeats: state.gridSizeBeats,
          gridSizeSemis: state.gridSizeSemis,
          bpm: activeBpm,
          totalDuration: activeDuration,
          bandsPerOctave: activeFile.spectrogramData.bandsPerOctave,
          numBands: activeFile.spectrogramData.numBands,
        });
        const destAnchorUv = resolveBrushAnchor(destCursorUv, sourceStepFp.fullTime, sourceStepFp.fullPitch);

        const tScale = (activeBpm * activeDuration) / (bpm * totalDuration);
        const bScale = sourceBandUvSlope(activeFile.spectrogramData, spectrogramData);

        const offset = calculateSourceOffset(sourceStepRaw?.lockedOffset, mode, destAnchorUv, tScale, bScale);
        sourceRectPlaced = true;
        sourceDisplayPos = new Vector2(
          destAnchorUv.x * tScale + offset.x + sourcePositionUv.x,
          destToSourceBandUv(destAnchorUv.y, activeFile.spectrogramData, spectrogramData) +
            offset.y +
            sourcePositionUv.y,
        );
      }
    } else {
      sourceDisplayPos = sourcePositionUv;
      sourceRectPlaced = mode === "anchored";
    }
  }

  const canvas = engine.canvasFor(gl);
  const span = dabSpan(state, cursorPos, canvas, union);
  const { hover, needs } = span;
  const original = needs.original;
  prepareVisibleRegion(residencyContext, canvas, cursorPos, hover.start, hover.end, original);

  if (applyStroke.current && cursorPos.x >= 0) {
    const preview = strokePreview.current;
    const sources = sourceNeedsOver(needs.sources, hover);
    for (const need of sources) canvas.aimSource(need, false);
    for (const need of needs.impulses) canvas.aimImpulse(need, false);
    canvas.dropSourcesExcept(sources);
    canvas.dropImpulsesExcept(needs.impulses);
    if (preview) {
      // A dab the canvas cannot show whole is previewed on the coarse canvas.
      const writes = span.extent.writes;
      const whole =
        canvas.holdsFrames(hover.start, hover.end, original) &&
        writes.every((write) => canvas.holdsFrames(write.start, write.end, original));
      const shown = whole && dispatchStroke(state, cursorPos, true, { span });
      const coarse = !whole && engine.paintCoarse(state, cursorPos, span, true, dispatchStroke);
      engine.coarseRef.current?.showPreview(coarse);
      displayMode.current = shown || coarse ? "preview" : "committed";
      if (shown) applyStroke.current = false;
    } else {
      engine.paintStrokeTrail(state, canvas, spectrogramData, bpm, layDab, dabSpan);
      engine.lastStrokeDab = cursorPosition;
      const dabState = state;
      const dabPos = cursorPos.clone();
      const record = recordDab(fileId, brushOriginUv.x, brushOriginUv.y, brushSizeUv.x, brushSizeUv.y);
      layDab(dabState, dabPos, canvas, span, {}, () => {
        if (record) record.paintedAt = Date.now();
      });
      displayMode.current = "committed";
      applyStroke.current = false;
    }
  }

  if (state.pickingFileParam !== null) {
    displayMode.current = "committed";
  }
  const coarse = engine.coarseRef.current;
  if (displayMode.current !== "preview") coarse?.showPreview(false);
  // The stroke's dabs stay on the coarse canvas until the store holds them.
  if (coarse?.holdsStroke && !canvas.isStroking && canvas.pendingWork === 0 && !canvas.hasUnstoredPaint)
    coarse.endStroke();
  const isPreview = displayMode.current === "preview";
  const previewDisplay = strokeRenderer.getPreviewDisplay();

  const hoveredFile = hoveredFileId ? openFiles[hoveredFileId] : null;

  bindDisplay();
  displayMaterial.uniforms.sourceSpectrogramTex.value = previewDisplay.committed;
  displayMaterial.uniforms.previewTex.value = previewDisplay.preview;
  displayMaterial.uniforms.previewBinRangesTex.value = previewDisplay.binRanges;
  const coarsePreview = coarse?.previewDisplay() ?? null;
  // The canvas's preview stays where it was last painted, so it gives way to one on the coarse canvas.
  displayMaterial.uniforms.previewActive.value = isPreview && previewDisplay.active && coarsePreview === null;
  const coarseStroke = coarse?.strokeDisplay() ?? null;
  displayMaterial.uniforms.coarseMetaTex.value = coarse?.metadata ?? null;
  displayMaterial.uniforms.coarseCommittedTex.value = coarsePreview?.committed ?? coarseStroke?.committed ?? null;
  displayMaterial.uniforms.coarsePreviewTex.value = coarsePreview?.preview ?? null;
  displayMaterial.uniforms.coarsePreviewBinRangesTex.value = coarsePreview?.binRanges ?? null;
  displayMaterial.uniforms.coarsePreviewActive.value = coarsePreview !== null;
  displayMaterial.uniforms.coarseStrokeBinRangesTex.value = coarseStroke?.binRanges ?? null;
  displayMaterial.uniforms.coarseStrokeActive.value = coarseStroke !== null;

  const displayBrushAnchor = resolveBrushAnchor(brushOriginUv, displayFullAxes.fullTime, displayFullAxes.fullPitch);
  displayMaterial.uniforms.brushBottomLeftUv.value = displayBrushAnchor;
  displayMaterial.uniforms.sourceSamplingBottomLeftUv.value = sourceDisplayPos;
  displayMaterial.uniforms.brushSizeUv.value = brushSizeUv;
  displayMaterial.uniforms.sourceBrushSizeUv.value = (() => {
    const targetFile = isSourceFile ? file : hoveredFile || file;
    if (!targetFile.spectrogramData) return new Vector2(0.1, 0.1);
    const targetBpm = state.filepathsBpm[targetFile.filePath] || 120;
    const targetDuration = targetFile.spectrogramData.numFrames / targetFile.spectrogramData.sampleRate;
    const slotSteps = state.brushes[state.activeBrushIndex]?.steps ?? [];

    let maxTimeUv = 0;
    let maxPitchUv = 0;
    for (let i = 0; i < slotSteps.length; i++) {
      const stepState = createStepStateView(state, i);
      const stepFp = resolveBrushFootprint({
        brushSizeTime: stepState.brushSizeTime,
        brushSizePitch: stepState.brushSizePitch,
        gridSizeBeats: stepState.gridSizeBeats,
        gridSizeSemis: stepState.gridSizeSemis,
        bpm: targetBpm,
        totalDuration: targetDuration,
        bandsPerOctave: targetFile.spectrogramData.bandsPerOctave,
        numBands: targetFile.spectrogramData.numBands,
      });

      let stepTimeUv = stepFp.sizeUv.x;
      if (sourceDisplayPos.x >= 0 && !stepFp.fullTime) {
        const cellTimeUv = swungGridCellWidthUv(
          sourceDisplayPos.x,
          {
            brushSizeTime: stepState.brushSizeTime,
            gridSizeBeats: stepState.gridSizeBeats,
            gridSwing: stepState.gridSwing,
            snapTime: stepState.snapTime,
            onsets: getFileOnsets(targetFile.id),
          },
          targetBpm,
          targetDuration,
        );
        if (cellTimeUv !== null) stepTimeUv = cellTimeUv;
      }
      maxTimeUv = Math.max(maxTimeUv, stepTimeUv);
      maxPitchUv = Math.max(maxPitchUv, stepFp.sizeUv.y);
    }
    return new Vector2(maxTimeUv || 0.1, maxPitchUv || 0.1);
  })();

  displayMaterial.uniforms.showTargetRectangle.value = Boolean(cursorVisible && hoveredFileId === fileId);
  displayMaterial.uniforms.showSourceRectangle.value = sourceRectPlaced;

  const isPicking = state.pickingFileParam !== null;
  displayMaterial.uniforms.targetRectPulse.value = isPicking
    ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(elapsedTime * 2.0 * Math.PI))
    : 1.0;
  (displayMaterial.uniforms.targetRectColor.value as Color).setRGB(
    isPicking ? 0.133 : 0.992,
    isPicking ? 0.545 : 0.494,
    isPicking ? 0.902 : 0.078,
  );
  if (isPicking && hoveredFileId === fileId) {
    invalidate();
  }
  displayMaterial.uniforms.wrapMode.value = (displayWrapsTime ? 1 : 0) + (displayWrapsPitch ? 2 : 0);

  if (sourceStepRaw?.sourceFile && sourceFileData?.spectrogramData) {
    const srcBpm = state.filepathsBpm[sourceFileData.filePath] || 120;
    const srcDur = sourceFileData.spectrogramData.numFrames / sourceFileData.spectrogramData.sampleRate;
    const tScale = (bpm * totalDuration) / (srcBpm * srcDur);
    const bScale = sourceBandUvSlope(spectrogramData, sourceFileData.spectrogramData);

    const sourceOffsetUv = calculateSourceOffset(
      sourceStepRaw?.lockedOffset,
      String(sourceStepRaw?.sourcePositionMode ?? "follow"),
      brushOriginUv,
      tScale,
      bScale,
    );

    displayMaterial.uniforms.sourceOffsetX.value = sourceOffsetUv.x;
    displayMaterial.uniforms.sourceOffsetY.value = sourceOffsetUv.y;
  }
}
