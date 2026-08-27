import { createStepStateView, useStore } from "@/store";
import { notifications } from "@mantine/notifications";
import { useTransientStore } from "@renderer/store/transient";
import { diag } from "@renderer/lib/diag-log";
import {
  clipRangesToView,
  composeViewContent,
  fileUvToViewUv,
  viewCoversFile,
  viewRangesToFile,
  viewUvToFileUv,
  type CanvasView,
} from "@renderer/lib/canvas-view";
import { blockGrid, blocksForPixelRanges } from "@renderer/lib/block-grid";
import { CANVAS_WINDOW_BLOCKS, CanvasWindow, needsCanvasWindow } from "@renderer/lib/canvas-window";
import { gatherPixelRanges } from "@renderer/lib/pixel-ranges";
import { countDiagStroke } from "@renderer/lib/diag-sampler";
import { perfAdd, perfEnabled, perfMark, perfSyncEnabled } from "@renderer/lib/perf-probe";
import { useFrame, useThree } from "@react-three/fiber";
import { createDefaultUniforms } from "@renderer/effects/base-effect";
import { getOpenFileByPath, logFileFootprint, openFiles } from "@renderer/store/files";
import { State } from "@renderer/store/types";
import {
  forwardRef,
  memo,
  RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Camera,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Texture,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { effects } from "../effects";
import { getHistoryManager } from "@renderer/lib/history-manager";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { DEFAULT_ONSET_SENSITIVITY } from "../lib/constants";
import { displayLevelChoice } from "../lib/display-pyramid";
import type { DisplayTileRing } from "../lib/display-tiles-textures";
import { getFileOnsets } from "../lib/file-onsets";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { getOnsetTexture, packOnsetState } from "../lib/onset-map";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "../lib/scale-snap";
import { FULL_SCALE_DB_OFFSET } from "../lib/constants";
import { renderExportImage as renderExportImageToCanvas, type ImageExportOptions } from "../lib/image-export";
import type { PosterInfo } from "../lib/image-export-poster";
import { captureMaterialToCanvas } from "../lib/snapshot-capture";
import { GpuMemoryError, SourceFileInfo, StrokeRenderer, StrokeTextures } from "../lib/stroke-renderer";
import { shallow } from "zustand/shallow";
import { penState } from "../lib/pen-state";
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

/**
 * Props for the FileRenderer component.
 * @param fileId - The open file to render.
 * @param isLive - Whether this file's view is live-rendered. When false the
 *   frame loop skips the file entirely (its DOM snapshot covers the view) and
 *   display-state changes refresh the snapshot instead.
 * @param snapshotCanvasRef - The 2D canvas that snapshot captures paint into.
 * @param onLiveFrame - Called after each fully drawn live frame.
 */
interface FileRendererProps {
  fileId: string;
  isLive: boolean;
  snapshotCanvasRef: RefObject<HTMLCanvasElement | null>;
  onLiveFrame?: () => void;
}

/** One stroke of a batch: where its brush origin sits, and the state to paint it with. */
export interface StrokeDispatch {
  /** Brush bottom-left in pitch UV — y up from the file's lowest band, as unitsToUv gives it. */
  blX: number;
  blY: number;
  state: State;
}

/**
 * Handle for the FileRenderer component, exposing methods to parent components.
 */
export interface FileRendererHandle {
  /** Renders a brush stroke at the current cursor position. */
  renderStroke: (preview: boolean) => void;
  /**
   * Paints a batch of strokes into the FBO immediately, each from its own state
   * snapshot, as part of the stroke already opened with beginStroke(). Returns
   * how many were painted.
   */
  renderStrokeBatch: (strokes: StrokeDispatch[]) => number;
  /**
   * Saves the spectrogram (or restores an already-saved one) so the strokes
   * painted next can be taken back without touching history.
   */
  beginStrokePreview: () => void;
  /** Puts back the pixels from before the preview. Returns false if none were saved. */
  discardStrokePreview: () => boolean;
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
    original: DataTexture;
  } | null;
  /** The span the canvas textures lay out, or null before the renderer exists. */
  getCanvasView: () => CanvasView | null;
  /** Restores the spectrogram to its original state. */
  restoreOriginal: () => void;
  /** Clears the stroke preview. */
  clearPreview: () => void;
  /** Reloads all textures from the current spectrogramData (used after re-analysis). */
  reloadTextures: () => void;
  releaseAnalysisData: () => void;
  applyStroke: () => void;
  beginStroke: () => void;
  endStroke: () => void;
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
   * Renders the committed spectrogram (no cursor/preview overlays) into the
   * snapshot canvas at its current on-screen size. Resolves false when the
   * renderer isn't ready yet or the view has no usable size.
   */
  captureSnapshot: () => Promise<boolean>;
  /** Schedules a throttled snapshot re-capture (no-op while the view is live). */
  refreshSnapshot: () => void;
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
    return <FileRendererInner {...props} ref={ref} />;
  }),
);

const FileRendererInner = memo(
  forwardRef<FileRendererHandle, FileRendererProps>(({ fileId, isLive, snapshotCanvasRef, onLiveFrame }, ref) => {
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
    const captureSnapshotRef = useRef<() => Promise<boolean>>(async () => false);

    const scheduleSnapshotRefresh = useCallback(() => {
      if (isLiveRef.current) return;
      if (snapshotTimerRef.current !== null) return;
      snapshotTimerRef.current = window.setTimeout(() => {
        snapshotTimerRef.current = null;
        if (!isLiveRef.current) void captureSnapshotRef.current();
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
            zoom: state.filesZoom[fileId],
            offset: state.filesOffset[fileId],
            zoomY: state.filesZoomY[fileId],
            offsetY: state.filesOffsetY[fileId],
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
      };
    }, [fileId, scheduleSnapshotRefresh]);

    // Materials and scene objects for rendering
    const displayMaterial = useMemo(() => {
      const state = useStore.getState();
      return new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
          minDb: { value: state.displayMinDb },
          maxDb: { value: state.displayMaxDb },
          bpm: { value: 120.0 },
          gridSize: { value: 0.25 },
          gridWidthUv: { value: 0.0 },
          gridHeightUv: { value: 0.0 },
          barWidthUv: { value: 0.0 },
          swingOffsetUv: { value: 0.0 },
          octaveHeightUv: { value: 0.0 },
          showHorizontalGrid: { value: true },
          showVerticalGrid: { value: true },
          scaleGridEnabled: { value: false },
          scaleOffsets: { value: new Float32Array(12) },
          pitchOffsetSemisFromC0: { value: 0.0 },
          showTargetRectangle: { value: false },
          showSourceRectangle: { value: false },
          targetRectPulse: { value: 1.0 },
          // Mantine orange[6] #fd7e14 by default; swapped to blue[6] while picking a source.
          targetRectColor: { value: new Color(0.992, 0.494, 0.078) },
          sourceSamplingBottomLeftUv: { value: new Vector2(-1, -1) },
          viewZoomPower: { value: 0.0 },
          viewOffset: { value: 0.0 },
          viewZoomPowerY: { value: 0.0 },
          viewOffsetY: { value: 0.0 },
          wrapMode: { value: 0 },
          fullScaleDbOffset: { value: FULL_SCALE_DB_OFFSET },
          previewTex: { value: null as Texture | null },
          previewBinRangesTex: { value: null as Texture | null },
          previewActive: { value: false },
          canvasMetadataTex: { value: null as Texture | null },
          canvasFrameCount: { value: 0 },
          canvasStartFrame: { value: 0 },
          displayFineTex: { value: null as Texture | null },
          displayFineMetaTex: { value: null as Texture | null },
          displayCoarseTex: { value: null as Texture | null },
          displayCoarseMetaTex: { value: null as Texture | null },
          displayLevelBlend: { value: 0.0 },
          displayPyramidActive: { value: false },
          displayTileTex: { value: null as Texture | null },
          displayTileMetaTex: { value: null as Texture | null },
          displayTileFirst: { value: 0.0 },
          displayTileCount: { value: 0.0 },
          displayTileSlots: { value: 1.0 },
          displayTileTexels: { value: 0.0 },
          displayTileBlend: { value: 0.0 },
          displayTileLevel: { value: 0.0 },
        },
        vertexShader: passThroughVert,
        fragmentShader: displayFrag,
        glslVersion: GLSL3,
      });
    }, []);

    const mesh = useRef<Mesh>(null!);

    // Stroke params for render loop
    const strokePreview = useRef(false);

    // The canvas window this file paints through, the view it is moving to,
    // and whether a stroke is in progress (a window that moves mid-stroke has
    // to carry the stroke's scratch with it).
    const canvasWindowRef = useRef<CanvasWindow | null>(null);
    const windowRequestRef = useRef<CanvasView | null>(null);
    const strokeActiveRef = useRef(false);
    // The effects that drop the renderer run before the window helpers are
    // declared, so they reach the disposer through a ref.
    const disposeCanvasWindowRef = useRef<(() => void) | null>(null);
    // Ring tiles being read out of the store, keyed by level and tile.
    const ringRequestsRef = useRef<Set<string>>(new Set());

    // Cleanup StrokeRenderer on unmount or when textures change
    useEffect(() => {
      return () => {
        if (strokeRendererRef.current) {
          strokeRendererRef.current.dispose();
          strokeRendererRef.current = null;
        }
        disposeCanvasWindowRef.current?.();
      };
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    // The packed and inverse-map values the next texture build seeds from.
    // Captured from the spectrogram once, so releasing the spectrogram's
    // arrays later does not retrigger the texture effect with nothing to
    // build from.
    const packedSeedRef = useRef<Float32Array | null>(null);
    if (spectrogramData.packedData) packedSeedRef.current = spectrogramData.packedData;
    const inverseSeedRef = useRef<Float32Array | null>(null);
    if (spectrogramData.inverseMap) inverseSeedRef.current = spectrogramData.inverseMap;

    /**
     * Creates DataTextures from spectrogram data.
     * Used both on initial load and when reloading textures.
     */
    const createTextures = useCallback(() => {
      const { metadata, textureWidth, textureHeight, numBands } = spectrogramData;
      let packedData = packedSeedRef.current;
      if (!packedData || packedData.length !== textureWidth * textureHeight * 4) {
        // The seed was already released; the canvas rebuilds from history.
        console.warn("history: the packed seed was already released; the canvas needs a full restore");
        getHistoryManager(fileId).markFboOutOfSync();
        packedData = new Float32Array(textureWidth * textureHeight * 4);
      }
      let inverseMap = inverseSeedRef.current;
      if (!inverseMap || inverseMap.length !== textureWidth * textureHeight * 2) {
        console.warn("history: the inverse-map seed was already released");
        inverseMap = new Float32Array(textureWidth * textureHeight * 2);
      }

      const packed = new DataTexture(packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
      packed.internalFormat = "RGBA32F";
      packed.minFilter = NearestFilter;
      packed.magFilter = NearestFilter;
      packed.wrapS = ClampToEdgeWrapping;
      packed.wrapT = ClampToEdgeWrapping;
      packed.generateMipmaps = false;
      packed.needsUpdate = true;

      const inverse = new DataTexture(inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
      inverse.internalFormat = "RG32F";
      inverse.minFilter = NearestFilter;
      inverse.magFilter = NearestFilter;
      inverse.wrapS = ClampToEdgeWrapping;
      inverse.wrapT = ClampToEdgeWrapping;
      inverse.generateMipmaps = false;
      inverse.needsUpdate = true;

      const meta = new DataTexture(metadata, numBands, 1, RGBAFormat, FloatType);
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
      spectrogramData.textureWidth,
      spectrogramData.textureHeight,
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

    // Effect to create and manage spectrogram textures
    useEffect(() => {
      installTextures(createTextures());

      // Reset StrokeRenderer when textures change
      if (strokeRendererRef.current) {
        strokeRendererRef.current.dispose();
        strokeRendererRef.current = null;
      }
      disposeCanvasWindowRef.current?.();

      return () => {
        // Whatever is live now, not what this run created: reloadTextures
        // replaces them outside the effect, and those must be freed too.
        disposeLiveTextures();
        setOriginalPackedDataTex(null);
        setInverseMapTex(null);
        setMetadataTex(null);
      };
    }, [createTextures, installTextures, disposeLiveTextures]);

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

    /**
     * Updates every display uniform that doesn't depend on the cursor,
     * preview, or picking state: texture metadata, dB range, view zoom/offset,
     * and the grid overlay. Shared by the live frame loop and snapshot capture
     * so a captured snapshot matches what the live view would draw.
     */
    /**
     * Holds the tiles the view needs and binds them. The ring stays empty
     * wherever the pyramid already has bins as fine as the screen asks for.
     */
    const applyDisplayTileUniforms = (
      pyramidStepLog2: number,
      framesPerPixel: number,
      viewZoomPower: number,
      viewOffset: number,
      viewportWidth: number,
    ): void => {
      const uniforms = displayMaterial.uniforms;
      const gl = glRef.current;
      const strokeRenderer = strokeRendererRef.current;
      const tiles = strokeRenderer?.getDisplayTiles();
      if (!gl || !strokeRenderer || !tiles) {
        uniforms.displayTileCount.value = 0;
        return;
      }
      const zoom = Math.pow(2, viewZoomPower);
      const span = spectrogramData.numFrames / zoom;
      const startFrame = zoom > 1 ? viewOffset * (spectrogramData.numFrames - span) : 0;
      const ringView = {
        framesPerPixel,
        startFrame,
        endFrame: startFrame + span,
        viewportPixels: Math.max(1, viewportWidth),
      };
      if (canvasCoversFile()) {
        tiles.update(gl, strokeRenderer.committedSource(), ringView, pyramidStepLog2);
      } else {
        requestRingTiles(tiles, tiles.aim(ringView, pyramidStepLog2));
      }

      const ring = tiles.uniforms();
      uniforms.displayTileTex.value = tiles.texture();
      uniforms.displayTileMetaTex.value = tiles.metadataTexture();
      uniforms.displayTileFirst.value = ring.firstTile;
      uniforms.displayTileCount.value = ring.tileCount;
      uniforms.displayTileSlots.value = Math.max(1, ring.slotCount);
      uniforms.displayTileTexels.value = ring.tileTexels;
      uniforms.displayTileBlend.value = ring.blend;
      uniforms.displayTileLevel.value = ring.level;
    };

    /**
     * Reads the tiles the ring is missing out of the block store and cuts
     * them in as they land. A tile whose level has moved on, or whose slot
     * the bound window took back, is dropped: the next aim asks again.
     */
    const requestRingTiles = (tiles: DisplayTileRing, missing: number[]): void => {
      if (missing.length === 0) return;
      const level = tiles.gridLevel();
      for (const tile of missing) {
        const key = `${level}:${tile}`;
        if (ringRequestsRef.current.has(key)) continue;
        ringRequestsRef.current.add(key);
        const ranges = tiles.tileSourcePixelRanges(tile);
        void getHistoryManager(fileId)
          .currentRanges(ranges)
          .then((values) => {
            ringRequestsRef.current.delete(key);
            const gl = glRef.current;
            const live = strokeRendererRef.current?.getDisplayTiles();
            if (!values || !gl || live !== tiles) return;
            if (tiles.gridLevel() !== level || !tiles.canCutTile(tile)) return;
            tiles.cutTileFromPacked(gl, tile, values);
            invalidateRef.current();
          })
          .catch(() => ringRequestsRef.current.delete(key));
      }
    };

    /**
     * Binds the two pyramid levels whose bins best match the screen, with the
     * weight of the coarser one, and the tile ring that covers what the
     * pyramid is too coarse for. The canvas takes over when neither has bins.
     */
    const applyDisplayPyramidUniforms = (viewZoomPower: number, viewOffset: number, viewportWidth: number): void => {
      const uniforms = displayMaterial.uniforms;
      const pyramid = strokeRendererRef.current?.getDisplayPyramid();
      if (!pyramid || !pyramid.texture(0)) {
        uniforms.displayPyramidActive.value = false;
        uniforms.displayTileCount.value = 0;
        return;
      }
      const framesPerPixel = spectrogramData.numFrames / (Math.pow(2, viewZoomPower) * Math.max(1, viewportWidth));
      const finestStepLog2 = pyramid.levels[0].stepLog2;
      applyDisplayTileUniforms(finestStepLog2, framesPerPixel, viewZoomPower, viewOffset, viewportWidth);

      if (2 ** finestStepLog2 > Math.max(framesPerPixel, 1)) {
        uniforms.displayPyramidActive.value = false;
        return;
      }
      const choice = displayLevelChoice(pyramid.levels, framesPerPixel);
      uniforms.displayFineTex.value = pyramid.texture(choice.fine);
      uniforms.displayFineMetaTex.value = pyramid.metadataTexture(choice.fine);
      uniforms.displayCoarseTex.value = pyramid.texture(choice.coarse);
      uniforms.displayCoarseMetaTex.value = pyramid.metadataTexture(choice.coarse);
      uniforms.displayLevelBlend.value = choice.blend;
      uniforms.displayPyramidActive.value = true;
    };

    const applyStaticDisplayUniforms = (state: State, viewportWidth: number, viewportHeight: number): void => {
      const file = openFiles[fileId];
      if (!file?.spectrogramData || !inverseMapTex || !metadataTex) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      const viewZoomPower = state.filesZoom[fileId];
      const viewOffset = state.filesOffset[fileId];
      const viewZoomPowerY = state.filesZoomY[fileId] ?? 0;
      const viewOffsetY = state.filesOffsetY[fileId] ?? 0;

      const uniforms = displayMaterial.uniforms;
      uniforms.sourceInverseMapTex.value = inverseMapTex;
      uniforms.sourceMetadataTex.value = metadataTex;
      const canvasView = strokeRendererRef.current?.committedSource().view;
      uniforms.canvasMetadataTex.value = strokeRendererRef.current?.getTextures().metadata ?? metadataTex;
      uniforms.canvasFrameCount.value = canvasView
        ? canvasView.endFrame - canvasView.startFrame
        : spectrogramData.numFrames;
      uniforms.canvasStartFrame.value = canvasView?.startFrame ?? 0;
      uniforms.sourceMinFreq.value = spectrogramData.minFreq;
      uniforms.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
      uniforms.sourceFrameCount.value = spectrogramData.numFrames;
      uniforms.sourceBandCount.value = spectrogramData.numBands;
      uniforms.sourceChannelCount.value = spectrogramData.numChannels;
      uniforms.sourceSampleRate.value = spectrogramData.sampleRate;
      uniforms.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
      uniforms.gridSize.value = state.gridSizeBeats;
      uniforms.bpm.value = bpm;
      uniforms.minDb.value = state.displayMinDb;
      uniforms.maxDb.value = state.displayMaxDb;
      uniforms.viewZoomPower.value = viewZoomPower;
      uniforms.viewOffset.value = viewOffset;
      uniforms.viewZoomPowerY.value = viewZoomPowerY;
      uniforms.viewOffsetY.value = viewOffsetY;

      applyDisplayPyramidUniforms(viewZoomPower, viewOffset, viewportWidth);

      // Calculate and update grid values
      const gridSizeBeats = state.gridSizeBeats;
      const gridSizeSemis = state.gridSizeSemis;

      // Horizontal grid (time/beats)
      const beatDurationSeconds = 60.0 / bpm;
      const gridIntervalSeconds = beatDurationSeconds * gridSizeBeats;
      const gridWidthUv = gridSizeBeats > 0 ? gridIntervalSeconds / totalDuration : 0;
      const barWidthUv = gridSizeBeats > 0 ? (beatDurationSeconds * 4.0) / totalDuration : 0;

      // Vertical grid (frequency/semitones). When gridSizeSemis is 0, the pitch grid is in
      // "Scale" mode and the chromatic grid is suppressed in favor of the scale grid.
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
      const gridHeightUv = gridSizeSemis > 0 ? gridIntervalBands / spectrogramData.numBands : 0;
      const octaveHeightUv = gridSizeSemis > 0 ? (12 * bandsPerSemitone) / spectrogramData.numBands : 0;

      // Determine if grid lines should be shown based on spacing (min 10 pixels apart).
      // Multiply by the view zoom factor so zooming in can reveal lines that were too
      // dense at 1x.
      const MIN_GRID_SPACING_PX = 10;
      const zoomX = Math.pow(2, viewZoomPower);
      const zoomY = Math.pow(2, viewZoomPowerY);
      const gridWidthPx = gridWidthUv * viewportWidth * zoomX;
      const gridHeightPx = gridHeightUv * viewportHeight * zoomY;

      uniforms.gridWidthUv.value = gridWidthUv;
      uniforms.gridHeightUv.value = gridHeightUv;
      uniforms.barWidthUv.value = barWidthUv;
      uniforms.swingOffsetUv.value = gridWidthUv * (state.gridSwing / 100) * 0.5;
      uniforms.octaveHeightUv.value = octaveHeightUv;
      uniforms.showHorizontalGrid.value = gridWidthPx >= MIN_GRID_SPACING_PX && gridSizeBeats > 0;
      uniforms.showVerticalGrid.value = gridHeightPx >= MIN_GRID_SPACING_PX && gridSizeSemis > 0;

      // Scale grid: draw a line at every in-scale semitone when scale snap is on. Hide when too dense.
      const semitoneHeightPx =
        (spectrogramData.bandsPerOctave / 12 / spectrogramData.numBands) * viewportHeight * zoomY;
      uniforms.scaleGridEnabled.value = gridSizeSemis <= 0 && semitoneHeightPx >= MIN_GRID_SPACING_PX;
      uniforms.scaleOffsets.value = buildScaleOffsets(state.scaleTonic, state.scaleType);
      uniforms.pitchOffsetSemisFromC0.value = minFreqSemisAboveC0(spectrogramData.minFreq);
    };

    /**
     * Renders the committed spectrogram into the snapshot canvas at the
     * view's current on-screen size, with all cursor/preview overlays off.
     * Used when the view goes static so the DOM canvas can replace the live
     * WebGL view, and re-run (throttled) when display state changes while
     * static.
     */
    const captureSnapshot = async (): Promise<boolean> => {
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

      const ok = await captureMaterialToCanvas(gl, displayMaterial, canvas, width, height);
      // Display state that changed while the capture was in flight isn't in
      // the pixels we just painted; go around again.
      if (snapshotStaleRef.current) scheduleSnapshotRefresh();
      return ok;
    };
    captureSnapshotRef.current = captureSnapshot;

    /**
     * Renders the committed spectrogram as a still image for export. Reads the
     * same FBO the view samples, so what is painted is what gets exported.
     */
    const renderExportImage = async (
      options: ImageExportOptions,
      posterInfo: PosterInfo,
      onProgress?: (fraction: number) => void,
    ): Promise<HTMLCanvasElement | null> => {
      const gl = glRef.current;
      const strokeRenderer = strokeRendererRef.current;
      if (!gl || !strokeRenderer || !strokeRenderer.getIsInitialized()) return null;
      return renderExportImageToCanvas(
        gl,
        {
          texture: strokeRenderer.getDisplayTexture(),
          metadataTexture: strokeRenderer.getTextures().metadata,
          spectrogramData,
        },
        options,
        posterInfo,
        onProgress,
      );
    };

    /** The frames the file's view shows at its current zoom and offset. */
    const visibleFrameRange = (state: State): { start: number; end: number } => {
      const { numFrames } = spectrogramData;
      const zoom = Math.pow(2, state.filesZoom[fileId] ?? 0);
      const span = numFrames / zoom;
      const start = zoom > 1 ? (state.filesOffset[fileId] ?? 0) * (numFrames - span) : 0;
      return { start, end: start + span };
    };

    /**
     * The block window the canvas paints through, built on first use for a
     * file with more blocks than the window holds. With CANVAS_WINDOW_BLOCKS
     * at Infinity the canvas holds the whole file and no window is made.
     */
    const canvasWindowFor = (gl: WebGLRenderer): CanvasWindow | null => {
      if (canvasWindowRef.current) return canvasWindowRef.current;
      const grid = blockGrid(
        { numBands: spectrogramData.numBands, metadata: spectrogramData.metadata },
        spectrogramData.numFrames,
        spectrogramData.sampleRate,
      );
      if (!needsCanvasWindow(grid, CANVAS_WINDOW_BLOCKS)) return null;
      canvasWindowRef.current = new CanvasWindow(gl, grid, {
        windowBlocks: CANVAS_WINDOW_BLOCKS,
        read: (ranges) => getHistoryManager(fileId).currentRanges(ranges),
      });
      return canvasWindowRef.current;
    };

    const disposeCanvasWindow = (): void => {
      canvasWindowRef.current?.dispose();
      canvasWindowRef.current = null;
      windowRequestRef.current = null;
    };
    disposeCanvasWindowRef.current = disposeCanvasWindow;

    /**
     * Points the canvas window at the frames [startFrame, endFrame). Blocks
     * the window lacks are read in the background and the canvas takes them
     * when they land, so a brush ahead of the reads keeps painting on what the
     * canvas already holds.
     */
    const aimCanvasWindow = (startFrame: number, endFrame: number): void => {
      const window = canvasWindowRef.current;
      const renderer = strokeRendererRef.current;
      if (!window || !renderer?.getIsInitialized()) return;
      const current = renderer.committedSource().view;
      const next = window.plan(current, startFrame, endFrame);
      const cold = next === current ? window.missing(current) : window.missing(next);
      if (next === current && cold.length === 0) return;
      const pending = windowRequestRef.current;
      if (pending && pending.firstBlock === next.firstBlock && pending.lastBlock === next.lastBlock) return;
      windowRequestRef.current = next;
      void window.acquire(next).then((filled) => {
        if (windowRequestRef.current !== next) return;
        windowRequestRef.current = null;
        const live = strokeRendererRef.current;
        if (!filled || !live?.getIsInitialized() || canvasWindowRef.current !== window) return;
        const held = live.committedSource().view;
        if (held.firstBlock === next.firstBlock && held.lastBlock === next.lastBlock) {
          // The canvas is already over these blocks and only lacks content for
          // the cold ones, so nothing painted is drawn over.
          if (cold.length > 0) live.fillCanvas((target) => window.compose(held, cold, target));
        } else {
          live.slideView(next, (target, blocks) => window.compose(next, blocks, target), {
            midStroke: strokeActiveRef.current,
          });
        }
        invalidateRef.current();
      });
    };

    /**
     * Paints one stroke into the FBO from an explicit state snapshot. The frame
     * loop calls it with the live store and the cursor's brush origin; batch
     * a grid fill calls it once per stroke with a shared state. Returns false
     * when the source file's textures aren't ready.
     */
    const dispatchStroke = (state: State, cursorPos: Vector2, preview: boolean): boolean => {
      const strokeRenderer = strokeRendererRef.current;
      const file = openFiles[fileId];
      if (!strokeRenderer || !file?.spectrogramData) return false;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      // The renderer paints over the span the canvas holds, so the cursor and
      // the duration it reads them against are the window's, not the file's.
      const view = strokeRenderer.committedSource().view;
      const overWholeFile = viewCoversFile(view, file.spectrogramData.numFrames);
      const dabCursor = overWholeFile
        ? cursorPos
        : new Vector2(fileUvToViewUv(view, file.spectrogramData.numFrames, cursorPos.x), cursorPos.y);
      const dabDuration = overWholeFile
        ? totalDuration
        : (view.endFrame - view.startFrame) / file.spectrogramData.sampleRate;

      // The active step names the file the brush samples from; null means this
      // file paints from itself.
      const activeStepRaw = (state.brushes[state.activeBrushIndex]?.steps ?? [])[state.activeStepIndex];
      const activeStepSourceFile = activeStepRaw?.sourceFile ?? null;
      const sourceFileData = activeStepSourceFile
        ? getOpenFileByPath(activeStepSourceFile.path)
        : state.activeFileId
          ? openFiles[state.activeFileId]
          : null;
      const resolvedSourceFile = sourceFileData ?? openFiles[fileId];
      const resolvedSourceTextures = resolvedSourceFile?.rendererRef?.current?.getTextures();
      const resolvedSourceView = resolvedSourceFile?.rendererRef?.current?.getCanvasView();
      if (!resolvedSourceTextures || !resolvedSourceFile?.spectrogramData) return false;
      const sourceSpan =
        resolvedSourceView && !viewCoversFile(resolvedSourceView, resolvedSourceFile.spectrogramData.numFrames)
          ? resolvedSourceView
          : undefined;

      // Both onset maps are baked here rather than inside the renderer so the
      // sensitivity control and the file's latest detections reach the shader
      // through one path. Sensitivity is per file — each side of a cross-file
      // paint uses its own.
      const sourceFileInfo: SourceFileInfo = {
        id: resolvedSourceFile.id,
        filePath: resolvedSourceFile.filePath,
        displayName: resolvedSourceFile.displayName,
        spectrogramData: resolvedSourceFile.spectrogramData,
        textures: resolvedSourceTextures,
        view: sourceSpan,
        onsetTexture: getOnsetTexture(
          resolvedSourceFile.id,
          resolvedSourceFile.onsets,
          resolvedSourceFile.spectrogramData.numFrames / resolvedSourceFile.spectrogramData.sampleRate,
          state.filepathsOnsetSensitivity[resolvedSourceFile.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
        ),
      };
      const destOnsetTexture = getOnsetTexture(
        fileId,
        file.onsets,
        totalDuration,
        state.filepathsOnsetSensitivity[file.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
      );

      // Opt-in timing (set window.__paintTiming = true in the console) forces a
      // GPU sync so the logged duration reflects real stroke cost — useful for
      // comparing upper- vs lower-band paint latency.
      const paintTiming = (globalThis as { __paintTiming?: boolean }).__paintTiming === true;
      const paintT0 = paintTiming ? performance.now() : 0;
      countDiagStroke(preview);
      // The GPU can refuse the scratch allocations even after analysis fit the
      // budget; closing the file keeps the context alive.
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
        useStore.getState().closeFile(fileId);
        return false;
      }
      if (paintTiming) {
        strokeRenderer.finishGpu();
        console.log(`[paint] stroke ${(performance.now() - paintT0).toFixed(2)}ms`);
      }
      return true;
    };

    /**
     * The main render loop, called on every frame.
     * This handles initialization, brush stroke application, and updating the display material.
     */
    useFrame(({ gl, camera, clock, invalidate }) => {
      // Capture refs for use outside of useFrame
      glRef.current = gl;
      cameraRef.current = camera;

      if (!spectrogramData || !inverseMapTex || !metadataTex || !originalPackedDataTex) return;

      const frameT0 = perfEnabled() ? performance.now() : 0;
      const state = useStore.getState();
      const { cursorPosition, cursorVisible, hoveredFile: hoveredFileId } = useTransientStore.getState();

      const file = openFiles[fileId];
      if (!file || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      // Resolve the brush's bottom-left UV from the stored aim point.
      // cursorPosition is the user's aim; the renderer's shaders expect the
      // BL origin, which in center-anchor mode sits half a footprint away.
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
        const { blX, blY } = aimUvToBrushBlUv(
          state,
          aim.x,
          aim.y,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
        cursorPos = new Vector2(blX, blY);
      }

      // Check if this file is referenced as source by the active step.
      // When sourceFile is null, the active file is the implicit "self" source.
      const activeStepRaw = (state.brushes[state.activeBrushIndex]?.steps ?? [])[state.activeStepIndex];
      const activeStepSourceFile = activeStepRaw?.sourceFile ?? null;
      const sourceFileData = activeStepSourceFile
        ? getOpenFileByPath(activeStepSourceFile.path)
        : state.activeFileId
          ? openFiles[state.activeFileId]
          : null;
      const isSourceFile = sourceFileData?.id === fileId;

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
          const visible = visibleFrameRange(state);
          const view = canvasWindowFor(gl)?.plan(null, visible.start, visible.end);
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
        const window = canvasWindowRef.current;
        if (window) {
          const view = strokeRenderer.committedSource().view;
          strokeRenderer.initialize((target) => window.composeResident(view, target));
          // The canvas holds one window, so the picture of the rest of the
          // file comes from the analysed state rather than from the canvas.
          if (packedSeedRef.current) strokeRenderer.seedDisplayFromPacked(packedSeedRef.current);
          aimCanvasWindow(view.startFrame, view.endFrame);
        } else {
          strokeRenderer.initialize();
        }
      }

      // Hook up the history manager exactly once per component lifetime.
      // Decoupled from StrokeRenderer.isInitialized because reloadTextures()
      // recreates the StrokeRenderer but must not re-run history rehydration.
      //
      // Two flows:
      // - Existing tree: reopenPersistedFiles already populated
      //   spectrogramData (and seeded HistoryManager.currentPacked) by reading
      //   the history root + replaying deltas. The StrokeRenderer's FBO is
      //   already at the correct currentId state; we only need to restore the
      //   audio for that node.
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
            if (hadExisting || !packed) return null;
            const id = await historyManager.addRootSnapshot({
              data: packed,
              kind: "root",
              label: "Opened",
              spectrogram: spectrogramData,
            });
            // Analysis has already found this state's onsets, so they are stored
            // with it rather than found again the next time the file is opened.
            const opened = openFiles[fileId];
            if (id && opened?.onsets) {
              void historyManager
                .setNodeOnsets(id, packOnsetState({ onsets: opened.onsets, reference: opened.onsetReference }))
                .catch((error) => console.error("Storing onsets for history node failed:", error));
            }
            return id;
          });
          // The GPU and the store hold the state now, so the analysed array
          // is released; the local copy still feeds this first synthesis.
          releaseAnalysisData();
          if (nodeId === null) {
            await historyManager.restoreCurrentAudio();
            return;
          }
          await state.synthesizeFile(fileId, undefined, packed);
          const updated = openFiles[fileId];
          if (nodeId && updated?.audioBuffer) {
            historyManager.setStateAudio(nodeId, updated.audioBuffer, updated.audioPeak ?? 1);
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

      // Helper to calculate brush footprint from a step state (handles Grid/Full modes)
      const calculateBrushFootprint = (stepState: State) =>
        resolveBrushFootprint({
          brushSizeTime: stepState.brushSizeTime,
          brushSizePitch: stepState.brushSizePitch,
          gridSizeBeats: stepState.gridSizeBeats,
          gridSizeSemis: stepState.gridSizeSemis,
          bpm,
          totalDuration,
          bandsPerOctave: spectrogramData.bandsPerOctave,
          numBands: spectrogramData.numBands,
        });

      // Calculate maximum brush size across all steps (for display purposes)
      const activeStepState = createStepStateView(state, state.activeStepIndex);
      const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
      const brushSizeUv = new Vector2(0, 0);
      const displayFullAxes = { fullTime: false, fullPitch: false };
      for (let i = 0; i < steps.length; i++) {
        const stepState = createStepStateView(state, i);
        const stepFp = calculateBrushFootprint(stepState);
        // Match the painted footprint: a snapped Grid-mode time brush fills the
        // swung cell under the cursor, so the preview rectangle must too.
        let stepTimeUv = stepFp.sizeUv.x;
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
          if (swungTimeUv !== null) stepTimeUv = swungTimeUv;
        }
        brushSizeUv.x = Math.max(brushSizeUv.x, stepTimeUv);
        brushSizeUv.y = Math.max(brushSizeUv.y, stepFp.sizeUv.y);
        if (stepFp.fullTime) displayFullAxes.fullTime = true;
        if (stepFp.fullPitch) displayFullAxes.fullPitch = true;
      }

      // For source file: compute the sampling position in this file's UV space.
      let sourceDisplayPos = new Vector2(-1, -1);
      if (isSourceFile) {
        const mode = String(activeStepRaw?.sourcePositionMode ?? "follow");
        const sourcePositionUv =
          mode === "follow"
            ? new Vector2(0, 0)
            : new Vector2(
                (Number(activeStepRaw?.sourceTimeOffset) || 0) / 100,
                (Number(activeStepRaw?.sourcePitchOffset) || 0) / 100,
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
            );
            const destCursorUv = new Vector2(destCursorX, destCursorY);

            // Resolve the active step's footprint in the active file's space so that the
            // source display rectangle honours Full-axis anchoring (brush anchors to 0).
            const activeStepFp = resolveBrushFootprint({
              brushSizeTime: Number(activeStepRaw?.brushSizeTime ?? 0),
              brushSizePitch: Number(activeStepRaw?.brushSizePitch ?? 0),
              gridSizeBeats: state.gridSizeBeats,
              gridSizeSemis: state.gridSizeSemis,
              bpm: activeBpm,
              totalDuration: activeDuration,
              bandsPerOctave: activeFile.spectrogramData.bandsPerOctave,
              numBands: activeFile.spectrogramData.numBands,
            });
            const destAnchorUv = resolveBrushAnchor(destCursorUv, activeStepFp.fullTime, activeStepFp.fullPitch);

            const tScale = (activeBpm * activeDuration) / (bpm * totalDuration);
            const bScale = sourceBandUvSlope(activeFile.spectrogramData, spectrogramData);

            const offset = calculateSourceOffset(activeStepRaw?.lockedOffset, mode, destAnchorUv, tScale, bScale);
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

      if (canvasWindowRef.current) {
        const { numFrames } = spectrogramData;
        const visible = visibleFrameRange(state);
        const start = cursorPos.x >= 0 ? cursorPos.x * numFrames : visible.start;
        const end = cursorPos.x >= 0 ? (cursorPos.x + brushSizeUv.x) * numFrames : visible.end;
        aimCanvasWindow(start, end);
      }

      // Render brush stroke if requested
      if (applyStroke.current && cursorPos.x >= 0) {
        const preview = strokePreview.current;
        if (!dispatchStroke(state, cursorPos, preview)) return;

        if (!preview) {
          displayMode.current = "committed";
        }

        applyStroke.current = false;
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
      const displayBrushAnchor = resolveBrushAnchor(cursorPos, displayFullAxes.fullTime, displayFullAxes.fullPitch);
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
      displayMaterial.uniforms.wrapMode.value = activeStepState.brushWrapMode;

      // Update source offset uniforms (for display preview)
      if (activeStepSourceFile && sourceFileData?.spectrogramData) {
        const srcBpm = state.filepathsBpm[sourceFileData.filePath] || 120;
        const srcDur = sourceFileData.spectrogramData.numFrames / sourceFileData.spectrogramData.sampleRate;
        const tScale = (bpm * totalDuration) / (srcBpm * srcDur);
        const bScale = sourceBandUvSlope(spectrogramData, sourceFileData.spectrogramData);

        const sourceOffsetUv = calculateSourceOffset(
          activeStepRaw?.lockedOffset,
          String(activeStepRaw?.sourcePositionMode ?? "follow"),
          cursorPos,
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

    // The handle speaks file space whatever span the canvas holds: ranges,
    // values and UVs translate through the renderer's view at this boundary,
    // and a view covering the whole file passes everything straight through.
    const regionToFileUv = (
      region: { startX: number; endX: number; startY: number; endY: number } | null,
    ): { startX: number; endX: number; startY: number; endY: number } | null => {
      const renderer = strokeRendererRef.current;
      if (!renderer || !region || canvasCoversFile()) return region;
      const view = renderer.committedSource().view;
      return {
        ...region,
        startX: viewUvToFileUv(view, spectrogramData.numFrames, region.startX),
        endX: viewUvToFileUv(view, spectrogramData.numFrames, region.endX),
      };
    };
    const canvasCoversFile = (): boolean => {
      const view = strokeRendererRef.current?.committedSource().view;
      return view !== undefined && viewCoversFile(view, spectrogramData.numFrames);
    };
    const fileBandLayout = (): { numBands: number; metadata: Float32Array } => ({
      numBands: spectrogramData.numBands,
      metadata: spectrogramData.metadata,
    });
    /** Every packed pixel of the file, as one range per band. */
    const fullFilePixelRanges = (): Uint32Array => {
      const ranges = new Uint32Array(spectrogramData.numBands * 2);
      for (let band = 0; band < spectrogramData.numBands; band++) {
        ranges[band * 2] = spectrogramData.metadata[band * 4];
        ranges[band * 2 + 1] = spectrogramData.metadata[band * 4 + 1];
      }
      return ranges;
    };

    /**
     * Reads the whole packed state from the FBO, or null when the canvas
     * view does not hold the whole file (the block store serves it then).
     */
    const getFBOData = async (): Promise<Float32Array | null> => {
      if (!strokeRendererRef.current) {
        throw new Error("StrokeRenderer not initialized");
      }
      if (!canvasCoversFile()) return null;
      return strokeRendererRef.current.getFBOData();
    };

    const readPixelRanges = async (pixelRanges: Uint32Array): Promise<Float32Array> => {
      const renderer = strokeRendererRef.current;
      if (!renderer) {
        throw new Error("StrokeRenderer not initialized");
      }
      if (canvasCoversFile()) return renderer.readPixelRanges(pixelRanges);
      const clipped = clipRangesToView(renderer.committedSource().view, fileBandLayout(), pixelRanges);
      if (!clipped.covered) throw new Error("the canvas view does not hold the requested pixels");
      return renderer.readPixelRanges(clipped.viewRanges);
    };

    /**
     * Sets the FBO data from an external source (e.g., for undo/redo).
     */
    const setFBOData = (data: Float32Array) => {
      const renderer = strokeRendererRef.current;
      if (!renderer) return;

      if (canvasCoversFile()) {
        renderer.setFBOData(data);
      } else {
        renderer.setFBOData(composeViewContent(renderer.committedSource().view, data));
        renderer.seedDisplayFromPacked(data);
        renderer.getDisplayTiles()?.dropTiles(fullFilePixelRanges());
        canvasWindowRef.current?.invalidate();
      }
      applyStroke.current = false;
      displayMode.current = "committed";
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    const applyPhaseTurns = (turns: ArrayLike<number>) => {
      const renderer = strokeRendererRef.current;
      if (!renderer) return;
      if (canvasCoversFile()) {
        renderer.applyPhaseTurns(turns);
      } else {
        const view = renderer.committedSource().view;
        const layout = fileBandLayout();
        const translated: number[] = [];
        for (let i = 0; i + 3 < turns.length; i += 4) {
          const clipped = clipRangesToView(view, layout, Uint32Array.of(turns[i], turns[i + 1]));
          for (let j = 0; j + 1 < clipped.viewRanges.length; j += 2) {
            translated.push(clipped.viewRanges[j], clipped.viewRanges[j + 1], turns[i + 2], turns[i + 3]);
          }
        }
        renderer.applyPhaseTurns(translated);
        // Turns move phase, which the display does not show, but the slots
        // still hold the untorned values for the blocks they carry.
        const window = canvasWindowRef.current;
        if (window) {
          const turned: number[] = [];
          for (let i = 0; i + 3 < turns.length; i += 4) turned.push(turns[i], turns[i + 1]);
          window.invalidate(blocksForPixelRanges(window.grid, Uint32Array.from(turned)));
        }
      }
      applyStroke.current = false;
      displayMode.current = "committed";
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    /**
     * Carries a change the canvas cannot hold all of to the rest of the file:
     * the display picture takes the new values, the block slots forget the
     * blocks they held, and the ring lets go of the tiles over them.
     */
    const patchOutsideCanvas = (renderer: StrokeRenderer, values: Float32Array, fileRanges: Uint32Array): void => {
      renderer.patchDisplayFromCompact(values, fileRanges);
      renderer.getDisplayTiles()?.dropTiles(fileRanges);
      const window = canvasWindowRef.current;
      if (window) window.invalidate(blocksForPixelRanges(window.grid, fileRanges));
    };

    const patchFBOData = (data: Float32Array, pixelRanges: Uint32Array) => {
      const renderer = strokeRendererRef.current;
      if (!renderer) return;

      if (canvasCoversFile()) {
        renderer.patchFBOData(data, pixelRanges);
      } else {
        const clipped = clipRangesToView(renderer.committedSource().view, fileBandLayout(), pixelRanges);
        renderer.patchFBODataCompact(gatherPixelRanges(data, clipped.fileRanges), clipped.viewRanges);
        patchOutsideCanvas(renderer, gatherPixelRanges(data, pixelRanges), pixelRanges);
      }
      applyStroke.current = false;
      displayMode.current = "committed";
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    const patchFBODataCompact = (values: Float32Array, pixelRanges: Uint32Array) => {
      const renderer = strokeRendererRef.current;
      if (!renderer) return;

      if (canvasCoversFile()) {
        renderer.patchFBODataCompact(values, pixelRanges);
      } else {
        const clipped = clipRangesToView(renderer.committedSource().view, fileBandLayout(), pixelRanges, values);
        if (clipped.viewValues) renderer.patchFBODataCompact(clipped.viewValues, clipped.viewRanges);
        patchOutsideCanvas(renderer, values, pixelRanges);
      }
      applyStroke.current = false;
      displayMode.current = "committed";
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
    };

    /**
     * Returns the current set of textures.
     */
    const getTextures = (): {
      packed: WebGLRenderTarget;
      inverse: DataTexture;
      metadata: DataTexture;
      original: DataTexture;
    } | null => {
      if (!strokeRendererRef.current || !inverseMapTex || !metadataTex || !originalPackedDataTex) return null;
      return strokeRendererRef.current.getTextures();
    };

    /** The span those textures lay out. */
    const getCanvasView = (): CanvasView | null => strokeRendererRef.current?.committedSource().view ?? null;

    /**
     * Restores the spectrogram to its original, unmodified state.
     */
    const restoreOriginal = () => {
      if (strokeRendererRef.current) {
        strokeRendererRef.current.restoreOriginal();
      }
      invalidateRef.current();
      snapshotStaleRef.current = true;
      scheduleSnapshotRefresh();
      useStore.getState().synthesizeFile(fileId);
    };

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
      disposeCanvasWindow();

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
      gl.initTexture(live.inverse);
      live.inverse.image.data = new Float32Array(0);
      inverseSeedRef.current = null;
      spectrogramData.inverseMap = undefined;
    };

    const discardStrokePreview = (): boolean => {
      const restored = strokeRendererRef.current?.restoreRollback() ?? false;
      if (restored) {
        displayMode.current = "committed";
        invalidateRef.current?.();
        scheduleSnapshotRefresh();
      }
      return restored;
    };

    const beginStroke = () => {
      // Painting by hand supersedes a pattern preview rather than stacking on it.
      discardStrokePreview();
      strokeActiveRef.current = true;
      if (strokeRendererRef.current) {
        strokeRendererRef.current.beginStroke();
      }
    };

    const endStroke = () => {
      strokeActiveRef.current = false;
      if (strokeRendererRef.current) {
        strokeRendererRef.current.endStroke();
      }
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
      renderStrokeBatch: (strokes: StrokeDispatch[]) => {
        const strokeRenderer = strokeRendererRef.current;
        if (!strokeRenderer?.getIsInitialized()) return 0;
        let painted = 0;
        for (const stroke of strokes) {
          if (dispatchStroke(stroke.state, new Vector2(stroke.blX, stroke.blY), false)) painted++;
        }
        if (painted > 0) displayMode.current = "committed";
        invalidateRef.current?.();
        scheduleSnapshotRefresh();
        return painted;
      },
      beginStrokePreview: () => {
        const strokeRenderer = strokeRendererRef.current;
        if (!strokeRenderer?.getIsInitialized()) return;
        strokeRenderer.captureRollback();
        strokeRenderer.beginStroke();
      },
      discardStrokePreview,
      keepStrokePreview: () => strokeRendererRef.current?.releaseRollback(),
      getFBOData,
      readPixelRanges,
      applyPhaseTurns,
      setFBOData,
      patchFBOData,
      patchFBODataCompact,
      getTextures,
      getCanvasView,
      restoreOriginal,
      clearPreview,
      reloadTextures,
      releaseAnalysisData,
      beginStroke,
      endStroke,
      applyStroke: () => {
        // The frame loop resolves the position from the cursor.
        applyStroke.current = true;
        invalidateRef.current?.();
      },
      getDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.getDirtyRegion() ?? null),
      clearDirtyRegion: () => strokeRendererRef.current?.clearDirtyRegion(),
      consumeDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.consumeDirtyRegion() ?? null),
      getDirtyPixelRanges: () => {
        const renderer = strokeRendererRef.current;
        const ranges = renderer?.getDirtyPixelRanges() ?? null;
        if (!renderer || !ranges || canvasCoversFile()) return ranges;
        return viewRangesToFile(renderer.committedSource().view, ranges);
      },
      getCommittedFootprintUv: () => {
        const renderer = strokeRendererRef.current;
        const footprint = renderer?.getCommittedFootprintUv() ?? null;
        if (!renderer || !footprint || canvasCoversFile()) return footprint;
        const view = renderer.committedSource().view;
        return {
          ...footprint,
          timeMin: viewUvToFileUv(view, spectrogramData.numFrames, footprint.timeMin),
          timeMax: viewUvToFileUv(view, spectrogramData.numFrames, footprint.timeMax),
        };
      },
      getStrokeGeneration: () => strokeRendererRef.current?.getStrokeGeneration() ?? 0,
      expandDirtyRegion: (startX: number, endX: number, startY: number, endY: number) => {
        const renderer = strokeRendererRef.current;
        if (!renderer) return;
        if (canvasCoversFile()) {
          renderer.expandDirtyRegion(startX, endX, startY, endY);
        } else {
          const view = renderer.committedSource().view;
          renderer.expandDirtyRegion(
            fileUvToViewUv(view, spectrogramData.numFrames, startX),
            fileUvToViewUv(view, spectrogramData.numFrames, endX),
            startY,
            endY,
          );
        }
      },
      captureSnapshot,
      refreshSnapshot: scheduleSnapshotRefresh,
      renderExportImage,
    }));

    /**
     * Clears the stroke preview from the display.
     */
    const clearPreview = () => {
      displayMode.current = "committed";
      clearingPreview.current = true;
      invalidateRef.current();
    };

    // The component renders a mesh with a plane geometry and the custom `displayMaterial`.
    return (
      <mesh ref={mesh}>
        <planeGeometry args={[2, 2]} />
        <primitive object={displayMaterial} attach="material" />
      </mesh>
    );
  }),
);

FileRenderer.displayName = "FileRenderer";
FileRendererInner.displayName = "FileRendererInner";
