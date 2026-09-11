import {
  applyDisplayPyramidUniforms,
  prepareVisibleRegion,
  visibleFrameRange,
  disposeDisplayResidency,
  type FileDisplayResidencyContext,
} from "../lib/file-display-residency";
import {
  brushUnionAt as resolveBrushUnionAt,
  dispatchStroke as dispatchFileStroke,
  strokeRefusal as fileStrokeRefusal,
  dabSpan as fileDabSpan,
  prepareStrokeBatch,
  type FileStrokeContext,
} from "../lib/file-stroke-dispatch";
import {
  createFileDisplayMaterial,
  disposeFileDisplayMaterial,
  bindFileSpectralInputs,
  bindFileTopOverlays,
} from "../lib/file-display-material";
import type {
  BrushUnionUv,
  DabSpan,
  FileDisplayData,
  FileViewDescriptor,
  FileRendererHandle,
  FileRendererProps,
  RegionStroke,
  StrokeDispatch,
} from "../lib/file-renderer-types";
import { createStepStateView, useStore } from "@/store";
import { notifications } from "@mantine/notifications";
import { useTransientStore } from "@renderer/store/transient";
import type { CanvasView } from "@renderer/lib/canvas-view";
import { blockGrid } from "@renderer/lib/block-grid";
import { AimRest, needsCanvasWindow } from "@renderer/lib/canvas-window";
import { canvasWindowBlocks } from "@renderer/lib/gpu-budget";
import { ExportSourceWindow, exportBlockGrid } from "@renderer/lib/export-window";
import { WindowedCanvas, type UvRegion } from "@renderer/lib/windowed-canvas";
import { perfAdd, perfEnabled, perfSyncEnabled } from "@renderer/lib/perf-probe";
import { useFrame, useThree } from "@react-three/fiber";
import { getOpenFileByPath, logFileFootprint, openFiles } from "@renderer/store/files";
import type { BrushStep } from "@renderer/parameters";
import { State, type OpenFile, type SpectrogramData } from "@renderer/store/types";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  Camera,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  NormalBlending,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Texture,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { LONE_LAYER_TINT } from "@renderer/lib/layer-tint";
import { effects } from "../effects";
import { deriveSideData, getHistoryManager } from "@renderer/lib/history-manager";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import { metadataTextureRows } from "../lib/band-layout";
import { DEFAULT_ONSET_SENSITIVITY, packedFold, padToFold } from "../lib/constants";
import { getFileOnsets } from "../lib/file-onsets";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { getOnsetTexture, packOnsetState } from "../lib/onset-map";
import { renderExportImage as renderExportImageToCanvas, type ImageExportOptions } from "../lib/image-export";
import type { PosterInfo } from "../lib/image-export-poster";
import { captureMaterialToCanvas } from "../lib/snapshot-capture";
import { SourceFileInfo, StrokeRenderer, StrokeTextures } from "../lib/stroke-renderer";
import { shallow } from "zustand/shallow";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { aimUvToBrushBlUv } from "../lib/brush-anchor";
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
    const strokeRendererRef = useRef<StrokeRenderer | null>(null);
    // Tracks whether we've already seeded / rehydrated the history tree for
    // this file in the current component lifetime. Separate from the
    // StrokeRenderer's isInitialized flag because reloadTextures recreates the
    // StrokeRenderer but must not re-run history rehydration (which would
    // call reloadTextures again → infinite loop).
    const historyHookedRef = useRef(false);

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
    }, [modulator1Texture, modulator2Texture, modulator3Texture]);

    // Textures for spectrogram data. The pristine packed texture is both the
    // FBO seed and the shaders' originalSpectrogramTex; the current state lives
    // in the StrokeRenderer's FBOs.
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<DataTexture | null>(null);

    // Interaction state
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);
    const clearingPreview = useRef(false);
    const aimRest = useRef(new AimRest());
    const aimRestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Whether the display material has been populated at least once for the
    // current StrokeRenderer. Reset whenever the StrokeRenderer is recreated.
    const hasDrawnDisplayRef = useRef(false);

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
    }, [fileId, viewFileId, scheduleSnapshotRefresh]);

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

    // Stroke params for render loop
    const strokePreview = useRef(false);

    // The canvas as the rest of the app sees it: file coordinates, whatever
    // span the canvas itself holds. lib/windowed-canvas.ts owns the block
    // window, the window over the original, and the carried paint.
    const canvasRef = useRef<WindowedCanvas | null>(null);
    // The effects that drop the renderer run before the canvas helpers are
    // declared, so they reach the disposer through a ref.
    const disposeCanvasRef = useRef<(() => void) | null>(null);
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

    // Cleanup StrokeRenderer on unmount or when textures change
    useEffect(() => {
      return () => {
        if (strokeRendererRef.current) {
          strokeRendererRef.current.dispose();
          strokeRendererRef.current = null;
        }
        disposeCanvasRef.current?.();
      };
    }, [spectrogramData.texels]);

    // The packed and inverse-map values the next texture build seeds from.
    // Captured from the spectrogram once, so releasing the spectrogram's
    // arrays later does not retrigger the texture effect with nothing to
    // build from.
    // A remounted canvas takes its committed state after the pristine texture seeds it.
    const currentSeedRef = useRef<Float32Array | null>(null);
    const packedSeedRef = useRef<Float32Array | null>(null);
    if (spectrogramData.packedData) packedSeedRef.current = spectrogramData.packedData;
    const inverseSeedRef = useRef<Float32Array | null>(null);
    if (spectrogramData.inverseMap) inverseSeedRef.current = spectrogramData.inverseMap;

    /**
     * Creates DataTextures from spectrogram data.
     * Used both on initial load and when reloading textures.
     */
    const createTextures = useCallback(() => {
      const { metadata, texels, numBands } = spectrogramData;
      // A canvas holding a window of the file takes its content, its original
      // and its inverse map from the block store and the view, so nothing
      // samples the file-sized pair. At ten minutes they are the largest thing
      // this file puts on the graphics device, so they are never built.
      const grid = blockGrid({ numBands, metadata }, spectrogramData.numFrames, spectrogramData.sampleRate);
      const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));
      const fold = packedFold(texels);
      const texWidth = windowed ? 1 : fold.width;
      const texHeight = windowed ? 1 : fold.height;
      const packedSeed = packedSeedRef.current;
      let packedData = windowed ? new Float32Array(4) : packedSeed && padToFold(packedSeed, texels, 4);
      if (!packedData || packedData.length !== texWidth * texHeight * 4) {
        // The seed was already released; the canvas rebuilds from history.
        console.warn("history: the packed seed was already released; the canvas needs a full restore");
        getHistoryManager(fileId).markFboOutOfSync();
        packedData = new Float32Array(texWidth * texHeight * 4);
      }
      const inverseSeed = inverseSeedRef.current;
      let inverseMap = windowed ? new Float32Array(2) : inverseSeed && padToFold(inverseSeed, texels, 2);
      if (!inverseMap || inverseMap.length !== texWidth * texHeight * 2) {
        console.warn("history: the inverse-map seed was already released");
        inverseMap = new Float32Array(texWidth * texHeight * 2);
      }

      const packed = new DataTexture(packedData, texWidth, texHeight, RGBAFormat, FloatType);
      packed.internalFormat = "RGBA32F";
      packed.minFilter = NearestFilter;
      packed.magFilter = NearestFilter;
      packed.wrapS = ClampToEdgeWrapping;
      packed.wrapT = ClampToEdgeWrapping;
      packed.generateMipmaps = false;
      packed.needsUpdate = true;

      const inverse = new DataTexture(inverseMap, texWidth, texHeight, RGFormat, FloatType);
      inverse.internalFormat = "RG32F";
      inverse.minFilter = NearestFilter;
      inverse.magFilter = NearestFilter;
      inverse.wrapS = ClampToEdgeWrapping;
      inverse.wrapT = ClampToEdgeWrapping;
      inverse.generateMipmaps = false;
      inverse.needsUpdate = true;

      const meta = new DataTexture(metadataTextureRows({ numBands, metadata }), numBands, 1, RGBAFormat, FloatType);
      meta.internalFormat = "RGBA32F";
      meta.minFilter = NearestFilter;
      meta.magFilter = NearestFilter;
      meta.wrapS = ClampToEdgeWrapping;
      meta.wrapT = ClampToEdgeWrapping;
      meta.generateMipmaps = false;
      meta.needsUpdate = true;

      return { packed, inverse, meta };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      // The spectrogram object stands in for its fields: every real change
      // swaps the object, and listing `inverseMap` here would pin the released
      // array in this hook's dependency record until the next render.
      spectrogramData,
      spectrogramData.texels,
      spectrogramData.numBands,
    ]);

    /** The textures on the GPU now, so cleanup frees what is actually current. */
    const liveTexturesRef = useRef<{ packed: DataTexture; inverse: DataTexture; meta: DataTexture } | null>(null);

    const disposeLiveTextures = useCallback(() => {
      const live = liveTexturesRef.current;
      if (!live) return;
      live.packed.dispose();
      live.inverse.dispose();
      live.meta.dispose();
      liveTexturesRef.current = null;
    }, []);

    const installTextures = useCallback((next: { packed: DataTexture; inverse: DataTexture; meta: DataTexture }) => {
      liveTexturesRef.current = next;
      setOriginalPackedDataTex(next.packed);
      setInverseMapTex(next.inverse);
      setMetadataTex(next.meta);
    }, []);

    const prepareHistorySeeds = useCallback(
      async (cancelled: () => boolean): Promise<boolean> => {
        const history = getHistoryManager(fileId);
        await history.initialize();
        const manifest = history.getManifest();
        if (!manifest || cancelled()) return false;
        const current =
          (await history.currentBlockState()) ?? (await history.reconstruct(manifest.currentId)).packedData;
        const original = await history.rootRanges(new Uint32Array([0, spectrogramData.texels]));
        const anchor = history.nearestFullAnchor(manifest.currentId);
        const side = anchor ? await deriveSideData(anchor) : null;
        if (cancelled()) return false;
        currentSeedRef.current = current;
        packedSeedRef.current = original ?? current;
        inverseSeedRef.current = side?.inverseMap ?? null;
        return true;
      },
      [fileId, spectrogramData.texels],
    );

    // Effect to create and manage spectrogram textures
    useEffect(() => {
      if (parked) return;
      let cancelled = false;
      const prepare = async () => {
        const { numBands, metadata, numFrames, sampleRate } = spectrogramData;
        const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
        if (!packedSeedRef.current && !needsCanvasWindow(grid, canvasWindowBlocks(grid))) {
          const prepared = await serializeFileTask(fileId, () => prepareHistorySeeds(() => cancelled));
          if (!prepared) return;
        }
        if (!cancelled) installTextures(createTextures());
      };
      void prepare().catch((error: unknown) => console.error("Preparing renderer textures failed:", error));

      // Reset StrokeRenderer when textures change
      if (strokeRendererRef.current) {
        strokeRendererRef.current.dispose();
        strokeRendererRef.current = null;
      }
      disposeCanvasRef.current?.();

      return () => {
        cancelled = true;
        // Whatever is live now, not what this run created: reloadTextures
        // replaces them outside the effect, and those must be freed too.
        disposeLiveTextures();
        setOriginalPackedDataTex(null);
        setInverseMapTex(null);
        setMetadataTex(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createTextures, installTextures, disposeLiveTextures, prepareHistorySeeds]);

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

      const data: FileDisplayData = {
        spectrogramData,
        inverseMapTex,
        metadataTex,
        canvasView: strokeRendererRef.current?.committedSource().view,
        canvasMetadataTex: strokeRendererRef.current?.getTextures().metadata ?? metadataTex,
      };
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

    /**
     * Renders the committed spectrogram as a still image for export. Reads the
     * same FBO the view samples, so what is painted is what gets exported. A
     * canvas holding a window reads the file a span at a time from the block
     * store instead, so the image covers all of it.
     */
    const renderExportImage = async (
      options: ImageExportOptions,
      posterInfo: PosterInfo,
      onProgress?: (fraction: number) => void,
    ): Promise<HTMLCanvasElement | null> => {
      const gl = glRef.current;
      const strokeRenderer = strokeRendererRef.current;
      if (!gl || !strokeRenderer || !strokeRenderer.getIsInitialized()) return null;
      const exportGrid = exportBlockGrid(spectrogramData);
      const windowed = canvasRef.current && !canvasRef.current.wholeFile;
      const window = windowed
        ? new ExportSourceWindow(gl, exportGrid, {
            windowBlocks: canvasWindowBlocks(exportGrid),
            read: (ranges) => getHistoryManager(fileId).currentRanges(ranges),
            readBlock: (index) => getHistoryManager(fileId).currentBlock(index),
          })
        : null;
      try {
        return await renderExportImageToCanvas(
          gl,
          {
            texture: window ? null : strokeRenderer.getDisplayTexture(),
            metadataTexture: window ? null : strokeRenderer.getTextures().metadata,
            spectrogramData,
            window,
          },
          options,
          posterInfo,
          onProgress,
        );
      } finally {
        window?.dispose();
      }
    };

    /** The canvas, built on first use once there is a graphics device. */
    const canvasFor = (gl: WebGLRenderer): WindowedCanvas => {
      if (!canvasRef.current) {
        canvasRef.current = new WindowedCanvas({
          gl,
          spectrogram: spectrogramData,
          renderer: () => strokeRendererRef.current,
          readCurrent: (ranges) => getHistoryManager(fileId).currentRanges(ranges),
          readCurrentTaps: (runs) => getHistoryManager(fileId).currentTaps(runs),
          readRoot: (ranges) => getHistoryManager(fileId).rootRanges(ranges),
          readCurrentBlock: (index) => getHistoryManager(fileId).currentBlock(index),
          readRootBlock: (index) => getHistoryManager(fileId).rootBlock(index),
          onChanged: () => {
            snapshotStaleRef.current = true;
            scheduleSnapshotRefresh();
            invalidateRef.current?.();
          },
          sourceBlocks: (sourceId) => {
            const source = openFiles[sourceId];
            const spectrogram = source?.spectrogramData;
            if (!spectrogram) return null;
            return {
              spectrogram,
              readCurrent: (ranges) => getHistoryManager(sourceId).currentRanges(ranges),
              readRoot: (ranges) => getHistoryManager(sourceId).rootRanges(ranges),
              readCurrentBlock: (index) => getHistoryManager(sourceId).currentBlock(index),
              readRootBlock: (index) => getHistoryManager(sourceId).rootBlock(index),
              revision: () => getHistoryManager(sourceId).revision,
            };
          },
        });
      }
      return canvasRef.current;
    };

    const disposeCanvas = (): void => {
      canvasRef.current?.dispose();
      canvasRef.current = null;
    };
    disposeCanvasRef.current = disposeCanvas;

    const isParkedRef = useRef(parked);

    useEffect(() => {
      if (parked) {
        isParkedRef.current = true;
        let cancelled = false;
        void serializeFileTask(fileId, async () => {
          if (cancelled) return;
          const historyManager = getHistoryManager(fileId);
          if (historyManager.isCurrentAudioCached()) {
            const file = openFiles[fileId];
            if (file) file.audioBuffer = undefined;
          }
          disposeLiveTextures();
          if (strokeRendererRef.current) {
            strokeRendererRef.current.dispose();
            strokeRendererRef.current = null;
          }
          disposeCanvas();
          setOriginalPackedDataTex(null);
          setInverseMapTex(null);
          setMetadataTex(null);
          if (openFiles[fileId]) {
            openFiles[fileId].parked = true;
          }
        });
        return () => {
          cancelled = true;
        };
      } else {
        if (!isParkedRef.current) return;
        isParkedRef.current = false;
        let cancelled = false;
        void serializeFileTask(fileId, async () => {
          const file = openFiles[fileId];
          if (cancelled || !file?.parked) return;
          file.parked = false;
          const historyManager = getHistoryManager(fileId);
          const specData = file.spectrogramData ?? spectrogramData;
          if (!specData) return;

          const { metadata, numBands, numFrames, sampleRate } = specData;
          const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
          const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));

          if (windowed) {
            packedSeedRef.current = null;
            inverseSeedRef.current = null;
          } else {
            if (!(await prepareHistorySeeds(() => cancelled))) return;
          }

          installTextures(createTextures());

          hasDrawnDisplayRef.current = false;
          invalidateRef.current?.();
          snapshotStaleRef.current = true;
          scheduleSnapshotRefresh();

          if (historyHookedRef.current && !file.audioBuffer) await historyManager.restoreCurrentAudio();
        });
        return () => {
          cancelled = true;
        };
      }
    }, [
      parked,
      fileId,
      spectrogramData,
      createTextures,
      installTextures,
      disposeLiveTextures,
      prepareHistorySeeds,
      scheduleSnapshotRefresh,
    ]);

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

    const dispatchStroke = (
      state: State,
      cursorPos: Vector2,
      preview: boolean,
      sourceOverride?: SourceFileInfo,
      preparedSpan?: DabSpan,
    ): boolean => dispatchFileStroke(strokeContext, state, cursorPos, preview, sourceOverride, preparedSpan);

    const strokeRefusal = (state: State, aim?: { x: number; y: number }): string | null =>
      fileStrokeRefusal(strokeContext, state, aim);

    const dabSpan = (state: State, cursorPos: Vector2, canvas: WindowedCanvas, resolvedUnion?: BrushUnionUv): DabSpan =>
      fileDabSpan(strokeContext, state, cursorPos, canvas, resolvedUnion);

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

      // Create StrokeRenderer if not exists
      if (!strokeRendererRef.current) {
        const textures: StrokeTextures = {
          originalPackedDataTex,
          inverseMapTex,
          metadataTex,
          placeholderTexture,
          modulatorScaleLut,
          modulator1Texture,
          modulator2Texture,
          modulator3Texture,
        };
        // The GPU can refuse the allocations even after analysis fit the
        // budget; closing the file keeps the context alive.
        try {
          const visible = visibleFrameRange(residencyContext, state);
          const view = canvasFor(gl).firstView(visible.start, visible.end);
          strokeRendererRef.current = new StrokeRenderer(gl, spectrogramData, textures, fileId, effects, view);
        } catch (error) {
          console.error("Creating the stroke renderer failed:", error);
          notifications.show({
            title: "Not enough graphics memory",
            message: "The file was closed because the graphics device could not allocate its buffers.",
            color: "red",
          });
          useStore.getState().closeFile(fileId);
          return;
        }
        logFileFootprint(fileId, "textures allocated");
        hasDrawnDisplayRef.current = false;
      }

      const strokeRenderer = strokeRendererRef.current;

      // Initialize StrokeRenderer if not done yet
      if (!strokeRenderer.getIsInitialized()) {
        canvasFor(gl).initialize(packedSeedRef.current, spectrogramData.coarseStrip ?? null);
        if (currentSeedRef.current) {
          strokeRenderer.setFBOData(currentSeedRef.current);
          currentSeedRef.current = null;
        }
        if (historyHookedRef.current) {
          releaseAnalysisData();
        }
      }

      // Hook up the history manager exactly once per component lifetime.
      // Decoupled from StrokeRenderer.isInitialized because reloadTextures()
      // recreates the StrokeRenderer but must not re-run history rehydration.
      //
      // Two flows:
      // - Existing tree: a reopen or the texture preparation supplies the
      //   current coefficients and side data. The FBO holds the current node;
      //   restore its audio only when the file has no buffer.
      // - New file: the in-memory spectrogramData is the initial state, so
      //   seed history with it as the root snapshot, then synthesise + cache
      //   the initial audio.
      if (!historyHookedRef.current) {
        historyHookedRef.current = true;

        (async () => {
          const historyManager = getHistoryManager(fileId);
          const packed = spectrogramData.packedData;
          // Queued against stroke commits: painting within the first moments of
          // opening would otherwise append a child while the root is still being
          // written, and the root's currentPacked would then overwrite the
          // stroke's — leaving the next delta encoded against the wrong base.
          const nodeId = await serializeFileTask(fileId, async () => {
            const hadExisting = await historyManager.initialize();
            if (hadExisting) return null;
            // A windowed file has no run of its own: the analysis wrote its
            // state straight into the store the root snapshot points at.
            const id = await historyManager.addRootSnapshot({
              data: packed ?? null,
              kind: "root",
              label: "Opened",
              spectrogram: spectrogramData,
            });
            // Onsets the analysis found are stored with the state rather than
            // found again the next time the file is opened. A windowed file's
            // are found by its first synthesis and stored once that lands.
            const opened = openFiles[fileId];
            if (id && opened?.onsets && (opened.onsetReference?.odfMax ?? 0) > 0) {
              void historyManager
                .setNodeOnsets(id, packOnsetState({ onsets: opened.onsets, reference: opened.onsetReference }))
                .catch((error) => console.error("Storing onsets for history node failed:", error));
            }
            return id;
          });
          // A windowed file fills its canvas and draws its picture out of the
          // store, which could not answer until the root snapshot named its seed.
          if (!packed) void canvasRef.current?.storeReady();
          // The GPU and the store hold the state now, so the analysed array
          // is released; the local copy still feeds this first synthesis.
          releaseAnalysisData();
          if (nodeId === null) {
            if (!openFiles[fileId]?.audioBuffer) await historyManager.restoreCurrentAudio();
            return;
          }
          const gateBefore = openFiles[fileId]?.onsetReference?.odfMax ?? 0;
          await state.synthesizeFile(fileId, undefined, packed);
          const updated = openFiles[fileId];
          if (nodeId && updated?.audioBuffer) {
            historyManager.setStateAudio(nodeId, updated.audioBuffer, updated.audioPeak ?? 1);
          }
          if (nodeId && gateBefore <= 0 && updated?.onsets && (updated.onsetReference?.odfMax ?? 0) > 0) {
            void historyManager
              .setNodeOnsets(nodeId, packOnsetState({ onsets: updated.onsets, reference: updated.onsetReference }))
              .catch((error) => console.error("Storing onsets for history node failed:", error));
          }
        })();
      }

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

    const regionToFileUv = (region: UvRegion | null): UvRegion | null =>
      canvasRef.current ? canvasRef.current.regionToFileUv(region) : region;

    /** Display bookkeeping every whole-state move shares. */
    const afterStateMove = (): void => {
      applyStroke.current = false;
      displayMode.current = "committed";
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    /**
     * Reads the whole packed state from the FBO, or null when the canvas
     * view does not hold the whole file (the block store serves it then).
     */
    const getFBOData = async (): Promise<Float32Array | null> => {
      if (!canvasRef.current) throw new Error("StrokeRenderer not initialized");
      return await canvasRef.current.getFBOData();
    };

    const readPixelRanges = async (pixelRanges: Uint32Array): Promise<Float32Array> => {
      if (!canvasRef.current) throw new Error("StrokeRenderer not initialized");
      return await canvasRef.current.readPixelRanges(pixelRanges);
    };

    /**
     * Sets the FBO data from an external source (e.g., for undo/redo).
     */
    const setFBOData = (data: Float32Array) => {
      if (canvasRef.current?.setFBOData(data)) afterStateMove();
    };

    const applyPhaseTurns = (turns: ArrayLike<number>) => {
      if (canvasRef.current?.applyPhaseTurns(turns)) afterStateMove();
    };

    const patchFBOData = (data: Float32Array, pixelRanges: Uint32Array) => {
      if (canvasRef.current?.patchFBOData(data, pixelRanges)) afterStateMove();
    };

    const patchFBODataCompact = (values: Float32Array, pixelRanges: Uint32Array) => {
      if (canvasRef.current?.patchFBODataCompact(values, pixelRanges)) afterStateMove();
    };

    /**
     * Returns the current set of textures.
     */
    const getTextures = (): {
      packed: WebGLRenderTarget;
      inverse: DataTexture;
      metadata: DataTexture;
      original: Texture;
    } | null => {
      if (!strokeRendererRef.current || !inverseMapTex || !metadataTex || !originalPackedDataTex) return null;
      return strokeRendererRef.current.getTextures();
    };

    /** The span those textures lay out. */
    const getCanvasView = (): CanvasView | null => strokeRendererRef.current?.committedSource().view ?? null;

    const restoreOriginal = (): Promise<void> => getHistoryManager(fileId).restoreOriginal();

    /**
     * Reloads all textures from the current spectrogramData.
     * Used when the file is re-analyzed with different parameters.
     */
    const reloadTextures = () => {
      disposeLiveTextures();

      // Dispose and reset StrokeRenderer
      if (strokeRendererRef.current) {
        strokeRendererRef.current.dispose();
        strokeRendererRef.current = null;
      }
      disposeCanvas();

      installTextures(createTextures());

      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    /**
     * Frees the analysed packed array and the inverse map once the GPU holds
     * them: both textures are uploaded now, their CPU-side copies emptied,
     * and the spectrogram's references dropped. From here the FBO and the
     * block store carry the state, and the inverse map rebuilds from the
     * band layout when a derived file or a reopen needs it.
     */
    const releaseAnalysisData = () => {
      const live = liveTexturesRef.current;
      const gl = glRef.current;
      if (!live || !gl) return;
      gl.initTexture(live.packed);
      live.packed.image.data = new Float32Array(0);
      packedSeedRef.current = null;
      spectrogramData.packedData = undefined;
      spectrogramData.coarseStrip = undefined;
      gl.initTexture(live.inverse);
      live.inverse.image.data = new Float32Array(0);
      inverseSeedRef.current = null;
      spectrogramData.inverseMap = undefined;
    };

    const discardStrokePreview = async (): Promise<boolean> => {
      const canvas = canvasRef.current;
      const restored = canvas ? await canvas.discardStroke() : (strokeRendererRef.current?.restoreRollback() ?? false);
      if (restored) {
        displayMode.current = "committed";
        invalidateRef.current?.();
        scheduleSnapshotRefresh();
      }
      return restored;
    };

    const beginStroke = () => {
      // Painting by hand supersedes a pattern preview rather than stacking on it.
      void discardStrokePreview();
      canvasRef.current?.beginStroke();
    };

    const endStroke = () => {
      canvasRef.current?.endStroke();
      invalidateRef.current?.();
    };

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
      renderRegionStroke: (stroke: RegionStroke, preview: boolean) => {
        const painted = dispatchStroke(stroke.state, new Vector2(stroke.aimX, stroke.aimY), preview, stroke.source);
        if (!painted) return false;
        displayMode.current = preview ? "preview" : "committed";
        invalidateRef.current?.();
        scheduleSnapshotRefresh();
        return true;
      },
      createRegionSource: (id: string, spec: SpectrogramData, onsets?: Float32Array, onsetSensitivity?: number) => {
        const strokeRenderer = strokeRendererRef.current;
        if (!strokeRenderer?.getIsInitialized()) return null;
        // The Sharp warp re-anchors phase at the source's onsets, so a
        // detached source carries its own map like an open file does.
        const duration = spec.numFrames / spec.sampleRate;
        return {
          id,
          filePath: id,
          displayName: id,
          spectrogramData: spec,
          textures: strokeRenderer.createDetachedTextures(spec),
          onsetTexture: getOnsetTexture(id, onsets, duration, onsetSensitivity ?? DEFAULT_ONSET_SENSITIVITY),
        };
      },
      disposeRegionSource: (source: SourceFileInfo) => {
        source.textures.packed.dispose();
        source.textures.inverse?.dispose();
        source.textures.metadata.dispose();
        source.textures.original?.dispose();
      },
      renderStrokeBatch: (strokes: StrokeDispatch[], ahead?: StrokeDispatch[]) => {
        const strokeRenderer = strokeRendererRef.current;
        const canvas = canvasRef.current;
        if (!strokeRenderer?.getIsInitialized() || !canvas) return 0;
        const painted = prepareStrokeBatch(strokeContext, canvas, strokes, ahead);
        if (painted > 0) displayMode.current = "committed";
        invalidateRef.current?.();
        scheduleSnapshotRefresh();
        return painted;
      },
      beginStrokePreview: () => {
        const strokeRenderer = strokeRendererRef.current;
        if (!strokeRenderer?.getIsInitialized()) return;
        strokeRenderer.captureRollback();
        canvasRef.current?.beginStroke();
      },
      discardStrokePreview,
      maxStrokeSeconds: () => {
        const canvas = canvasRef.current;
        if (!canvas || canvas.wholeFile) return null;
        // Half the window, so an effect's reach either side of the stroke fits too.
        return canvas.windowSeconds() / 2;
      },
      keepStrokePreview: () => strokeRendererRef.current?.releaseRollback(),
      getFBOData,
      readPixelRanges,
      applyPhaseTurns,
      setFBOData,
      patchFBOData,
      patchFBODataCompact,
      getTextures,
      getCanvasView,
      strokeRefusal,
      restoreOriginal,
      clearPreview,
      reloadTextures,
      releaseAnalysisData,
      beginStroke,
      endStroke,
      holdPaint: (ranges, values) => canvasRef.current?.holdPaint(ranges, values) ?? (() => {}),
      forgetBlocks: (ranges) => canvasRef.current?.forgetBlocks(ranges),
      settleStroke: async () => {
        const canvas = canvasRef.current;
        if (applyStroke.current && !strokePreview.current && canvas && strokeRendererRef.current?.getIsInitialized()) {
          applyStroke.current = false;
          const state = useStore.getState();
          const { cursorPosition, hoveredFile } = useTransientStore.getState();
          const file = openFiles[fileId];
          const spec = file?.spectrogramData;
          if (spec && cursorPosition && (state.activeFileId === fileId || hoveredFile === fileId)) {
            const aim = unitsToUv(
              cursorPosition.beats,
              cursorPosition.pitch,
              state.filepathsBpm[file.filePath] || 120,
              spec.numFrames / spec.sampleRate,
              spec.bandsPerOctave,
              spec.numBands,
            );
            if (aim.x >= 0) {
              const span = dabSpan(state, aim, canvas);
              canvas.paintWhenHeld(span.startFrame, span.endFrame, span.needs, () =>
                dispatchStroke(state, aim, false, undefined, span),
              );
              displayMode.current = "committed";
            }
          }
        }
        await canvas?.settle();
      },
      applyStroke: () => {
        // The frame loop resolves the position from the cursor.
        applyStroke.current = true;
        invalidateRef.current?.();
      },
      getDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.getDirtyRegion() ?? null),
      clearDirtyRegion: () => strokeRendererRef.current?.clearDirtyRegion(),
      consumeDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.consumeDirtyRegion() ?? null),
      getDirtyPixelRanges: () => canvasRef.current?.dirtyPixelRanges() ?? null,
      getCommittedFootprintUv: () => canvasRef.current?.committedFootprintUv() ?? null,
      getStrokeGeneration: () => strokeRendererRef.current?.getStrokeGeneration() ?? 0,
      expandDirtyRegion: (startX: number, endX: number, startY: number, endY: number) =>
        canvasRef.current?.expandDirtyRegion(startX, endX, startY, endY),
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
      renderExportImage,
    }));

    /**
     * Clears the stroke preview from the display.
     */
    const clearPreview = () => {
      displayMode.current = "committed";
      if (strokePreview.current) applyStroke.current = false;
      clearingPreview.current = true;
      invalidateRef.current();
    };

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
