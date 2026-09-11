import { createStepStateView, useStore } from "@/store";
import { useFrame, useThree } from "@react-three/fiber";
import { AimRest } from "@renderer/lib/canvas-window";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import { deriveSideData, getHistoryManager } from "@renderer/lib/history-manager";
import { LONE_LAYER_TINT } from "@renderer/lib/layer-tint";
import { perfAdd, perfEnabled, perfSyncEnabled } from "@renderer/lib/perf-probe";
import type { BrushStep } from "@renderer/parameters";
import { getOpenFileByPath, logFileFootprint, openFiles } from "@renderer/store/files";
import { useTransientStore } from "@renderer/store/transient";
import { State, type OpenFile } from "@renderer/store/types";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  Camera,
  Color,
  DataTexture,
  Mesh,
  NormalBlending,
  RawShaderMaterial,
  Vector2,
  WebGLRenderer,
} from "three";
import { shallow } from "zustand/shallow";
import { aimUvToBrushBlUv } from "../lib/brush-anchor";
import {
  bindFileSpectralInputs,
  bindFileTopOverlays,
  createFileDisplayMaterial,
  disposeFileDisplayMaterial,
} from "../lib/file-display-material";
import {
  applyDisplayPyramidUniforms,
  disposeDisplayResidency,
  prepareVisibleRegion,
  visibleFrameRange,
  type FileDisplayResidencyContext,
} from "../lib/file-display-residency";
import { FileEngine } from "../lib/file-engine";
import { getFileOnsets } from "../lib/file-onsets";
import type {
  BrushUnionUv,
  FileRendererHandle,
  FileRendererProps,
  FileViewDescriptor,
} from "../lib/file-renderer-types";
import { brushUnionAt as resolveBrushUnionAt, type FileStrokeContext } from "../lib/file-stroke-dispatch";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { captureMaterialToCanvas } from "../lib/snapshot-capture";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import {
  destToSourceBandUv,
  resolveBrushAnchor,
  resolveBrushFootprint,
  sourceBandUvSlope,
  swungGridCellWidthUv,
  unitsToUv,
} from "../lib/utils";

/** The file a step samples from: the one it names, or the file being painted. */
function resolveStepSourceFile(state: State, step: BrushStep | undefined): OpenFile | undefined {
  const named = step?.sourceFile ?? null;
  if (named) return getOpenFileByPath(named.path);
  return state.activeFileId ? openFiles[state.activeFileId] : undefined;
}

/**
 * The `FileRenderer` component is responsible for rendering the spectrogram of an audio file
 * and handling real-time brush interactions for editing the spectrogram data.
 * It uses `react-three-fiber` for rendering and manages textures and frame buffer objects (FBOs)
 * for processing and displaying the spectrogram.
 */
export const FileRenderer = memo(
  forwardRef<FileRendererHandle, FileRendererProps>((props, ref) => {
    const { spectrogramData } = openFiles[props.fileId];
    if (!spectrogramData) return null;
    return <FileRendererInner key={props.fileId} {...props} ref={ref} />;
  }),
);

const FileRendererInner = memo(
  forwardRef<FileRendererHandle, FileRendererProps>((props, ref) => {
    const {
      fileId,
      viewFileId = fileId,
      isLive,
      parked,
      snapshotCanvasRef,
      onLiveFrame,
      tint,
      overlaid = false,
      behind = false,
    } = props;
    const spectrogramData = openFiles[fileId].spectrogramData!;

    // Don't subscribe to these during render - access them via refs or useFrame instead
    const glRef = useRef<WebGLRenderer>(null!);
    const cameraRef = useRef<Camera>(null!);
    const invalidateRef = useRef<() => void>(null!);
    const engineRef = useRef<FileEngine | null>(null);
    if (!engineRef.current)
      engineRef.current = new FileEngine(
        fileId,
        {
          getHistoryManager,
          deriveSideData,
          serializeFileTask,
          openFiles,
          logFileFootprint,
          getState: useStore.getState,
          getTransientState: useTransientStore.getState,
        },
        parked,
      );
    const engine = engineRef.current;
    const { strokeRendererRef, canvasRef, displayMode, applyStroke, strokePreview } = engine;

    // Populate invalidateRef from the R3F store, which is available on mount
    // before the first useFrame runs.
    const invalidate = useThree((s) => s.invalidate);
    useEffect(() => {
      invalidateRef.current = invalidate;
    }, [invalidate]);

    // Mirror the live flag into a ref for the frame loop and subscriptions.
    // Going live needs a frame so the view repaints under the snapshot overlay.
    const isLiveRef = useRef(isLive);
    useEffect(() => {
      isLiveRef.current = isLive;
      if (isLive) invalidateRef.current?.();
    }, [isLive]);

    // Set when display-affecting state changes after a snapshot capture has
    // read the state, so an in-flight capture re-schedules itself on finish.
    const snapshotStaleRef = useRef(false);
    const snapshotTimerRef = useRef<number | null>(null);
    // Latest-closure indirection: subscriptions and timers are created once
    // but must call the capture with current textures and spectrogram data.
    const captureSnapshotRef = useRef<(behind?: RawShaderMaterial[]) => Promise<boolean>>(async () => false);

    const snapshotRefreshRef = useRef(props.onSnapshotRefresh);
    snapshotRefreshRef.current = props.onSnapshotRefresh;

    const scheduleSnapshotRefresh = useCallback(() => {
      if (isLiveRef.current) return;
      if (snapshotTimerRef.current !== null) return;
      snapshotTimerRef.current = window.setTimeout(() => {
        snapshotTimerRef.current = null;
        if (!isLiveRef.current) {
          if (snapshotRefreshRef.current) snapshotRefreshRef.current();
          else void captureSnapshotRef.current();
        }
      }, 150);
    }, []);

    useEffect(() => {
      return () => {
        if (snapshotTimerRef.current !== null) {
          window.clearTimeout(snapshotTimerRef.current);
          snapshotTimerRef.current = null;
        }
      };
    }, []);

    const modulatorScaleLut = useModulatorScaleLut(fileId);

    // Load image textures for all modulators
    const modulator1Texture = useModulatorTexture(0);
    const modulator2Texture = useModulatorTexture(1);
    const modulator3Texture = useModulatorTexture(2);

    // Modulator textures load asynchronously and change when the user picks a
    // different image, so the values captured at StrokeRenderer construction go
    // stale. Re-sync them onto the live renderer whenever they change.
    useEffect(() => {
      strokeRendererRef.current?.updateModulatorTextures(modulator1Texture, modulator2Texture, modulator3Texture);
      invalidateRef.current?.();
    }, [strokeRendererRef, modulator1Texture, modulator2Texture, modulator3Texture]);

    // Textures for spectrogram data. The pristine packed texture is both the
    // FBO seed and the shaders' originalSpectrogramTex; the current state lives
    // in the StrokeRenderer's FBOs.
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<DataTexture | null>(null);

    // Interaction state
    const clearingPreview = useRef(false);
    const aimRest = useRef(new AimRest());
    const aimRestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Whether the display material has been populated at least once for the
    // current StrokeRenderer. Reset whenever the StrokeRenderer is recreated.
    const hasDrawnDisplayRef = useRef(false);

    const clearPreview = useCallback(() => {
      displayMode.current = "committed";
      if (strokePreview.current) applyStroke.current = false;
      clearingPreview.current = true;
      invalidateRef.current();
    }, [displayMode, strokePreview, applyStroke]);

    // Subscriptions to global state - consolidated into fewer subscriptions for efficiency
    useEffect(() => {
      // A live view's uniforms read many store keys per frame (brush footprint,
      // step params, source offsets), so any store update invalidates it.
      const unsubInvalidate = useStore.subscribe(() => {
        invalidateRef.current?.();
      });

      // A static view won't repaint from the frame loop, so its snapshot must
      // be refreshed when display state changes.
      const unsubDisplay = useStore.subscribe(
        (state) => {
          const file = openFiles[fileId];
          return {
            bpm: file && state.filepathsBpm[file.filePath],
            zoom: state.filesZoom[viewFileId],
            offset: state.filesOffset[viewFileId],
            zoomY: state.filesZoomY[viewFileId],
            offsetY: state.filesOffsetY[viewFileId],
            gridBeats: state.gridSizeBeats,
            gridSemis: state.gridSizeSemis,
            gridSwing: state.gridSwing,
            minDb: state.displayMinDb,
            maxDb: state.displayMaxDb,
            scaleTonic: state.scaleTonic,
            scaleType: state.scaleType,
            pickingFileParam: state.pickingFileParam,
            // The brush preview rectangle can be an onset span wide, so it
            // moves with the file's sensitivity.
            onsetSensitivity: file && state.filepathsOnsetSensitivity[file.filePath],
          };
        },
        () => {
          snapshotStaleRef.current = true;
          scheduleSnapshotRefresh();
        },
        { equalityFn: shallow },
      );

      // Transient cursor/hover state lives in its own store; re-render on changes.
      const unsubTransient = useTransientStore.subscribe(
        (state) => ({
          cursorPosition: state.cursorPosition,
          cursorVisible: state.cursorVisible,
          hoveredFile: state.hoveredFile,
        }),
        () => {
          invalidateRef.current?.();
        },
      );

      // Keep activeFileId separate due to special logic
      const unsubActiveFileId = useStore.subscribe(
        (state) => state.activeFileId,
        (activeId) => {
          if (activeId !== fileId) {
            // Became inactive: clear any preview
            clearPreview();
          } else {
            // Became active: if cursor is visible, trigger a preview render
            // We need to wait for the state update to propagate
            const { cursorVisible, cursorPosition } = useTransientStore.getState();
            const currentFile = openFiles[fileId];
            if (cursorVisible && cursorPosition && currentFile?.spectrogramData) {
              // Simulate renderStroke; the frame loop resolves the position
              // from the cursor.
              strokePreview.current = true;
              displayMode.current = "preview";
              applyStroke.current = true;
              invalidateRef.current?.();
            } else {
              invalidateRef.current?.();
            }
          }
        },
      );

      return () => {
        unsubInvalidate();
        unsubDisplay();
        unsubTransient();
        unsubActiveFileId();
        disposeDisplayResidency(aimRestTimer);
      };
    }, [fileId, viewFileId, scheduleSnapshotRefresh, applyStroke, displayMode, strokePreview, clearPreview]);

    // Materials and scene objects for rendering
    const displayMaterial = useMemo(() => {
      const state = useStore.getState();
      return createFileDisplayMaterial(state);
    }, []);

    useEffect(() => () => disposeFileDisplayMaterial(displayMaterial), [displayMaterial]);

    const mesh = useRef<Mesh>(null!);

    // A layer behind another adds into the picture already there and draws no
    // chrome, so a stack carries one grid and one brush rectangle however many
    // layers it holds. The frame loop only runs on demand, so a renderer that
    // mounts onto a file already analysed has to ask for the frame itself.
    useEffect(() => {
      const { left, right } = tint ?? LONE_LAYER_TINT;
      (displayMaterial.uniforms.leftTint.value as Color).setRGB(left[0], left[1], left[2]);
      (displayMaterial.uniforms.rightTint.value as Color).setRGB(right[0], right[1], right[2]);
      displayMaterial.uniforms.drawOverlays.value = !behind;
      displayMaterial.blending = overlaid ? AdditiveBlending : NormalBlending;
      displayMaterial.depthWrite = !overlaid;
      displayMaterial.needsUpdate = true;
      invalidateRef.current?.();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    }, [displayMaterial, tint, overlaid, behind, scheduleSnapshotRefresh]);

    // Ring tiles being read out of the store, keyed by level and tile.
    const ringRequestsRef = useRef<Set<string>>(new Set());
    // When the display last began waiting for a finer picture, or null while it has one.
    const loadingSinceRef = useRef<number | null>(null);
    // The zoom and offset the loading grace was last measured against.
    const loadingViewRef = useRef({ zoom: 0, offset: 0 });
    const residencyContext: FileDisplayResidencyContext = {
      viewFileId,
      spectrogramData,
      displayMaterial,
      glRef,
      strokeRendererRef,
      canvasRef,
      invalidateRef,
      ringRequestsRef,
      loadingSinceRef,
      loadingViewRef,
      aimRest,
      aimRestTimer,
      getState: useStore.getState,
      currentTaps: (runs) => getHistoryManager(fileId).currentTaps(runs),
    };

    useEffect(() => () => engine.dispose(), [engine, spectrogramData.texels]);

    useEffect(
      () => engine.prepare(parked),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [engine, spectrogramData, spectrogramData.texels, spectrogramData.numBands, fileId],
    );

    // Request a frame once the textures are actually ready. With frameloop="demand"
    // the initial mount frame runs before setState has populated the textures, so
    // without this the view stays black until the user interacts.
    useEffect(() => {
      if (originalPackedDataTex && inverseMapTex && metadataTex) {
        invalidateRef.current?.();
      }
    }, [originalPackedDataTex, inverseMapTex, metadataTex]);

    /**
     * Calculate clone-stamp offset from the cursor, scaled to source UV space.
     * Base position is in sourceTimeOffset/sourcePitchOffset params (handled in shader with modulation).
     */
    const calculateSourceOffset = useCallback(
      (
        lockedOffset: { beats: number; pitch: number } | null | undefined,
        mode: string,
        mousePos: Vector2 | null,
        timeScale: number,
        bandScale: number,
      ): Vector2 => {
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
      },
      [],
    );

    const placeholderTexture = usePlaceholderTexture();

    const applyStaticDisplayUniforms = (state: State, viewportWidth: number, viewportHeight: number): void => {
      const file = openFiles[fileId];
      if (!file?.spectrogramData || !inverseMapTex || !metadataTex) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      const viewZoomPower = state.filesZoom[viewFileId];
      const viewOffset = state.filesOffset[viewFileId];
      const viewZoomPowerY = state.filesZoomY[viewFileId] ?? 0;
      const viewOffsetY = state.filesOffsetY[viewFileId] ?? 0;

      const data = engine.borrowDisplaySource();
      if (!data) return;
      const view: FileViewDescriptor = {
        displayMinDb: state.displayMinDb,
        displayMaxDb: state.displayMaxDb,
        gridSizeBeats: state.gridSizeBeats,
        gridSizeSemis: state.gridSizeSemis,
        gridSwing: state.gridSwing,
        scaleTonic: state.scaleTonic,
        scaleType: state.scaleType,
        bpm,
        totalDuration,
        viewZoomPower,
        viewOffset,
        viewZoomPowerY,
        viewOffsetY,
        viewportWidth,
        viewportHeight,
      };
      bindFileSpectralInputs(displayMaterial, data, view);

      applyDisplayPyramidUniforms(residencyContext, viewZoomPower, viewOffset, viewportWidth);

      bindFileTopOverlays(displayMaterial, data, view);
    };

    /**
     * Renders the committed spectrogram into the snapshot canvas at the
     * view's current on-screen size, with all cursor/preview overlays off.
     * Used when the view goes static so the DOM canvas can replace the live
     * WebGL view, and re-run (throttled) when display state changes while
     * static.
     */
    const captureSnapshot = async (behindMaterials: RawShaderMaterial[] = []): Promise<boolean> => {
      const gl = glRef.current;
      const strokeRenderer = strokeRendererRef.current;
      const canvas = snapshotCanvasRef.current;
      if (!gl || !canvas || !strokeRenderer || !strokeRenderer.getIsInitialized()) return false;

      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 2 || height < 2) return false;

      snapshotStaleRef.current = false;
      const state = useStore.getState();
      applyStaticDisplayUniforms(state, gl.domElement.width, gl.domElement.height);
      displayMaterial.uniforms.sourceSpectrogramTex.value = strokeRenderer.getDisplayTexture();
      displayMaterial.uniforms.previewActive.value = false;
      displayMaterial.uniforms.showTargetRectangle.value = false;
      displayMaterial.uniforms.showSourceRectangle.value = false;

      const ok = await captureMaterialToCanvas(gl, [...behindMaterials, displayMaterial], canvas, width, height);
      // Display state that changed while the capture was in flight isn't in
      // the pixels we just painted; go around again.
      if (snapshotStaleRef.current) scheduleSnapshotRefresh();
      return ok;
    };
    captureSnapshotRef.current = captureSnapshot;

    const { canvasFor } = engine;
    useEffect(
      () => (parked ? engine.park() : engine.resume()),
      [
        engine,
        parked,
        fileId,
        spectrogramData,
        spectrogramData.texels,
        spectrogramData.numBands,
        scheduleSnapshotRefresh,
      ],
    );

    const strokeContext: FileStrokeContext = {
      fileId,
      viewFileId,
      spectrogramData,
      strokeRendererRef,
      canvasRef,
      openFiles,
      getOpenFileByPath,
      createStepStateView,
      getFileOnsets,
      closeFile: (id) => useStore.getState().closeFile(id),
      reachByState: new WeakMap(),
    };

    const brushUnionAt = (state: State, cursorPos: Vector2, bpm: number, totalDuration: number): BrushUnionUv =>
      resolveBrushUnionAt(strokeContext, state, cursorPos, bpm, totalDuration);

    const { paint: dispatchStroke, span: dabSpan } = engine.strokeDispatch(strokeContext);
    engine.updateContext({
      spectrogramData,
      glRef,
      invalidateRef,
      hasDrawnDisplayRef,
      modulatorScaleLut,
      modulator1Texture,
      modulator2Texture,
      modulator3Texture,
      placeholderTexture,
      setOriginalPackedDataTex,
      setInverseMapTex,
      setMetadataTex,
      scheduleSnapshotRefresh,
      strokeContext,
    });
    useEffect(
      () =>
        engine.subscribeVisualChange(() => {
          snapshotStaleRef.current = true;
          scheduleSnapshotRefresh();
        }),
      [engine, scheduleSnapshotRefresh],
    );

    /**
     * The main render loop, called on every frame.
     * This handles initialization, brush stroke application, and updating the display material.
     */
    useFrame(({ gl, camera, clock, invalidate }) => {
      // Capture refs for use outside of useFrame
      glRef.current = gl;
      cameraRef.current = camera;

      if (parked) return;

      if (!spectrogramData || !inverseMapTex || !metadataTex || !originalPackedDataTex) return;

      const frameT0 = perfEnabled() ? performance.now() : 0;
      const state = useStore.getState();
      const { cursorPosition, cursorVisible, hoveredFile: hoveredFileId } = useTransientStore.getState();

      const file = openFiles[fileId];
      if (!file || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      // The user's aim point. Brush size and anchor mode are per-step, so each
      // step turns this into its own bottom-left origin.
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

      // Each step names the file it samples; a step with none reads the file
      // being painted, which makes that file the implicit source. This file is
      // a source when any step points at it, and the first such step draws the
      // sampling rectangle.
      const brushSteps = state.brushes[state.activeBrushIndex]?.steps ?? [];
      const sourceStepIndex = brushSteps.findIndex((step) => resolveStepSourceFile(state, step)?.id === fileId);
      const sourceStepRaw = sourceStepIndex >= 0 ? brushSteps[sourceStepIndex] : undefined;
      const sourceFileData = resolveStepSourceFile(state, sourceStepRaw);
      const isSourceFile = sourceStepIndex >= 0;

      const strokeRenderer = engine.initialise(() => visibleFrameRange(residencyContext, state));
      if (!strokeRenderer) return;

      // After the display has been drawn once, a static view skips the frame
      // loop entirely — its DOM snapshot canvas is covering the region, and
      // display-state changes refresh that snapshot instead.
      if (
        !isLiveRef.current &&
        !clearingPreview.current &&
        strokeRenderer.getIsInitialized() &&
        hasDrawnDisplayRef.current
      ) {
        return;
      }

      clearingPreview.current = false;

      // The rectangle the brush paints inside: the union of the steps' own
      // rectangles, since size and anchor mode are per-step. Wrapping is a
      // union too — the rectangle tiles on an axis any step wraps.
      const union = brushUnionAt(state, cursorPos, bpm, totalDuration);
      const displayFullAxes = { fullTime: union.fullTime, fullPitch: union.fullPitch };
      const displayWrapsTime = union.wrapsTime;
      const displayWrapsPitch = union.wrapsPitch;
      const brushSizeUv = union.sizeUv;
      const brushOriginUv = union.hasSteps ? union.min : cursorPos;

      // For source file: compute the sampling position in this file's UV space.
      let sourceDisplayPos = new Vector2(-1, -1);
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

            // Resolve the sampling step's footprint in the active file's space so that the
            // source display rectangle honours Full-axis anchoring (brush anchors to 0).
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
            sourceDisplayPos = new Vector2(
              destAnchorUv.x * tScale + offset.x + sourcePositionUv.x,
              destToSourceBandUv(destAnchorUv.y, activeFile.spectrogramData, spectrogramData) +
                offset.y +
                sourcePositionUv.y,
            );
          }
        } else {
          // At rest: show at the source position
          sourceDisplayPos = sourcePositionUv;
        }
      }

      const canvas = canvasFor(gl);
      const span = dabSpan(state, cursorPos, canvas, union);
      const { startFrame: dabStart, endFrame: dabEnd, needs } = span;
      const original = needs.original;
      prepareVisibleRegion(residencyContext, canvas, state, cursorPos, dabStart, dabEnd, original);

      // Render brush stroke if requested
      if (applyStroke.current && cursorPos.x >= 0) {
        const preview = strokePreview.current;
        for (const need of needs.sources) canvas.aimSource(need);
        for (const need of needs.impulses) canvas.aimImpulse(need);
        canvas.dropSourcesExcept(needs.sources);
        canvas.dropImpulsesExcept(needs.impulses);
        if (preview) {
          // A preview shows what a dab would do. One the canvas cannot take
          // shows the committed picture and stays asked for, so the brush keeps
          // following the pointer and the preview appears once the window
          // holds the frames.
          // A preview the renderer refuses, for a brush the window cannot
          // serve or a source window still on its way, shows the committed
          // picture and stays asked for as well.
          if (
            !canvas.holdsFrames(dabStart, dabEnd, original) ||
            !dispatchStroke(state, cursorPos, true, undefined, span)
          ) {
            displayMode.current = "committed";
          } else {
            displayMode.current = "preview";
            applyStroke.current = false;
          }
        } else {
          // A dab blends out of the canvas, so one landing on a block the
          // canvas has no content for would paint silence and commit it. The
          // dab waits for its block, and for the source window it reads
          // through, and then paints where it was asked to.
          // A dab the renderer refuses is dropped: the frame still draws the
          // committed picture where the view is now.
          const dabState = state;
          const dabPos = cursorPos.clone();
          canvas.paintWhenHeld(dabStart, dabEnd, needs, () => dispatchStroke(dabState, dabPos, false, undefined, span));
          displayMode.current = "committed";
          applyStroke.current = false;
        }
      }

      // Update display material uniforms (once per frame at the end)
      // While picking a source, never show the stroke preview — just the committed spectrogram + rectangle.
      if (state.pickingFileParam !== null) {
        displayMode.current = "committed";
      }
      const isPreview = displayMode.current === "preview";
      const previewDisplay = strokeRenderer.getPreviewDisplay();

      const hoveredFile = hoveredFileId ? openFiles[hoveredFileId] : null;

      applyStaticDisplayUniforms(state, gl.domElement.width, gl.domElement.height);
      displayMaterial.uniforms.sourceSpectrogramTex.value = previewDisplay.committed;
      displayMaterial.uniforms.previewTex.value = previewDisplay.preview;
      displayMaterial.uniforms.previewBinRangesTex.value = previewDisplay.binRanges;
      displayMaterial.uniforms.previewActive.value = isPreview && previewDisplay.active;

      // In Full mode, the displayed brush rectangle anchors to 0 on that axis so it
      // spans the full file extent regardless of cursor position.
      const displayBrushAnchor = resolveBrushAnchor(brushOriginUv, displayFullAxes.fullTime, displayFullAxes.fullPitch);
      displayMaterial.uniforms.brushBottomLeftUv.value = displayBrushAnchor;
      displayMaterial.uniforms.sourceSamplingBottomLeftUv.value = sourceDisplayPos;
      displayMaterial.uniforms.brushSizeUv.value = brushSizeUv;
      displayMaterial.uniforms.sourceBrushSizeUv.value = (() => {
        // When this file is the source, always compute brush size in this file's coordinate space
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
          // Match the painted footprint, as the target rectangle does: a snapped
          // Grid-mode time brush fills the cell it lands in, which on the onset
          // grid is the span between two hits and so differs from cell to cell.
          // Measured where this rectangle sits, in this file's own timeline and
          // against its own onsets.
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
      displayMaterial.uniforms.showSourceRectangle.value = isSourceFile;

      const isPicking = state.pickingFileParam !== null;
      displayMaterial.uniforms.targetRectPulse.value = isPicking
        ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.0 * Math.PI))
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

      // Update source offset uniforms (for display preview)
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

      hasDrawnDisplayRef.current = true;
      onLiveFrame?.();

      // Flag-gated: optionally force a GPU sync so the recorded frame time
      // reflects real per-frame cost (CPU dispatch + GPU work) for this file's
      // render. The finish() is behind __perf.sync() so the default cadence
      // measurement is not perturbed by serializing the GPU.
      if (perfEnabled()) {
        if (perfSyncEnabled()) gl.getContext().finish();
        perfAdd("fileFrame(active)", performance.now() - frameT0);
      }
    });

    /**
     * Exposes component methods to the parent through a ref.
     */
    useImperativeHandle(ref, () => ({
      renderStroke: (preview: boolean) => {
        // While picking a source file, don't render the brush preview — just the rectangle.
        if (preview && useStore.getState().pickingFileParam !== null) {
          displayMode.current = "committed";
          invalidateRef.current?.();
          return;
        }
        strokePreview.current = preview;
        if (preview) {
          displayMode.current = "preview";
        }
        applyStroke.current = true;
        invalidateRef.current?.();
      },
      ...engine.fileOperations(),
      clearPreview,
      applyStroke: () => {
        applyStroke.current = true;
        invalidateRef.current?.();
      },
      captureSnapshot,
      getDisplayMaterial: () => {
        const gl = glRef.current;
        const renderer = strokeRendererRef.current;
        if (!gl || !renderer?.getIsInitialized()) return null;
        applyStaticDisplayUniforms(useStore.getState(), gl.domElement.width, gl.domElement.height);
        displayMaterial.uniforms.sourceSpectrogramTex.value = renderer.getDisplayTexture();
        displayMaterial.uniforms.previewActive.value = false;
        displayMaterial.uniforms.showTargetRectangle.value = false;
        displayMaterial.uniforms.showSourceRectangle.value = false;
        return displayMaterial;
      },
      refreshSnapshot: scheduleSnapshotRefresh,
    }));

    // The component renders a mesh with a plane geometry and the custom `displayMaterial`.
    return (
      <mesh ref={mesh} renderOrder={behind ? 0 : 1}>
        <planeGeometry args={[2, 2]} />
        <primitive object={displayMaterial} attach="material" />
      </mesh>
    );
  }),
);

FileRenderer.displayName = "FileRenderer";
FileRendererInner.displayName = "FileRendererInner";
