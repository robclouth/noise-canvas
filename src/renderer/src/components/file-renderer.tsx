import { createStepStateView, useStore } from "@/store";
import { notifications } from "@mantine/notifications";
import { useTransientStore } from "@renderer/store/transient";
import { diag } from "@renderer/lib/diag-log";
import { viewCoversFile, type CanvasView } from "@renderer/lib/canvas-view";
import { blockGrid } from "@renderer/lib/block-grid";
import { AimRest, needsCanvasWindow } from "@renderer/lib/canvas-window";
import { canvasWindowBlocks } from "@renderer/lib/gpu-budget";
import { ExportSourceWindow, exportBlockGrid } from "@renderer/lib/export-window";
import { sourceReadSpan, type SourceWindowTextures } from "@renderer/lib/source-window";
import { WindowedCanvas, type DabNeeds, type SourceNeed, type UvRegion } from "@renderer/lib/windowed-canvas";
import { strokeReach, type ReachContext } from "@renderer/lib/effect-reach";
import { strokeRefusal as refusalFor } from "@renderer/lib/whole-file-gate";
import { countDiagStroke } from "@renderer/lib/diag-sampler";
import { perfAdd, perfEnabled, perfMark, perfSyncEnabled } from "@renderer/lib/perf-probe";
import { useFrame, useThree } from "@react-three/fiber";
import { createDefaultUniforms } from "@renderer/effects/base-effect";
import { getOpenFileByPath, logFileFootprint, openFiles } from "@renderer/store/files";
import type { BrushStep } from "@renderer/parameters";
import { State, type OpenFile, type SpectrogramData } from "@renderer/store/types";
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
  AdditiveBlending,
  Camera,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
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
import { LONE_LAYER_TINT, type LayerTint } from "@renderer/lib/layer-tint";
import { effects } from "../effects";
import { deriveSideData, getHistoryManager } from "@renderer/lib/history-manager";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { metadataTextureRows } from "../lib/band-layout";
import { DEFAULT_ONSET_SENSITIVITY, packedFold, padToFold } from "../lib/constants";
import { displayLevelChoice } from "../lib/display-pyramid";
import type { DisplayTileRing } from "../lib/display-tiles-textures";
import { getFileOnsets } from "../lib/file-onsets";
import { impulseNeeds, type ImpulseNeed } from "../lib/impulse-need";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { getOnsetTexture, packOnsetState } from "../lib/onset-map";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "../lib/scale-snap";
import { FULL_SCALE_DB_OFFSET } from "../lib/constants";
import { renderExportImage as renderExportImageToCanvas, type ImageExportOptions } from "../lib/image-export";
import type { PosterInfo } from "../lib/image-export-poster";
import { captureMaterialToCanvas } from "../lib/snapshot-capture";
import {
  GpuMemoryError,
  ImpulseFileInfo,
  SourceFileInfo,
  StrokeRenderer,
  StrokeTextures,
} from "../lib/stroke-renderer";
import { shallow } from "zustand/shallow";
import { penState } from "../lib/pen-state";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { aimUvToBrushBlUv, footprintAimToBlUv } from "../lib/brush-anchor";
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
  /** The layer whose zoom and scroll place this display in an overlaid view. */
  viewFileId?: string;
  isLive: boolean;
  parked: boolean;
  snapshotCanvasRef: RefObject<HTMLCanvasElement | null>;
  onLiveFrame?: () => void;
  /** Requests a capture of every layer sharing the snapshot canvas. */
  onSnapshotRefresh?: () => void;
  /**
   * The hue pair this layer paints its left and right channels in. Defaults to
   * the orange and blue a layer on its own has always used.
   */
  tint?: LayerTint;
  /**
   * One layer of an overlaid stack. Every layer of one adds into the picture,
   * including the layer on top, or the top layer's opaque output would wipe the
   * layers already drawn.
   */
  overlaid?: boolean;
  /**
   * Drawn behind the layer on top: spectrogram only. The layer on top keeps the
   * grid, the brush preview and the rectangles, so a stack carries one of each.
   */
  behind?: boolean;
}

/** One stroke of a batch: where it is aimed, and the state to paint it with. */
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

/** The file a step samples from: the one it names, or the file being painted. */
function resolveStepSourceFile(state: State, step: BrushStep | undefined): OpenFile | undefined {
  const named = step?.sourceFile ?? null;
  if (named) return getOpenFileByPath(named.path);
  return state.activeFileId ? openFiles[state.activeFileId] : undefined;
}

/**
 * Handle for the FileRenderer component, exposing methods to parent components.
 */
/** The union of the steps' brush rectangles for one aim, in file UV. */
interface BrushUnionUv {
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
interface DabSpan {
  startFrame: number;
  endFrame: number;
  needs: DabNeeds;
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
  strokeRefusal: (state: State) => string | null;
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
   * Renders the committed spectrogram (no cursor/preview overlays) into the
   * snapshot canvas at its current on-screen size. Resolves false when the
   * renderer isn't ready yet or the view has no usable size.
   */
  /**
   * Paints the view into the snapshot canvas. An overlaid stack passes the
   * materials of the layers behind this one, drawn first, or the still would
   * show the top layer alone.
   */
  captureSnapshot: (behindMaterials?: RawShaderMaterial[]) => Promise<boolean>;
  /** This layer's display material, so a stack can capture every layer at once. */
  getDisplayMaterial: () => RawShaderMaterial | null;
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

// A region the display cannot serve finely yet is greyed only once it has been
// missing this long, then fades in over the second span.
const DISPLAY_LOADING_GRACE_MS = 120;
const DISPLAY_LOADING_FADE_MS = 160;

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
        if (aimRestTimer.current !== null) clearTimeout(aimRestTimer.current);
      };
    }, [fileId, viewFileId, scheduleSnapshotRefresh]);

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
          leftTint: { value: new Color(LONE_LAYER_TINT.left[0], LONE_LAYER_TINT.left[1], LONE_LAYER_TINT.left[2]) },
          rightTint: {
            value: new Color(LONE_LAYER_TINT.right[0], LONE_LAYER_TINT.right[1], LONE_LAYER_TINT.right[2]),
          },
          drawOverlays: { value: true },
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
          displayCanvasFirst: { value: false },
          displayFinerWanted: { value: false },
          displayLoadingAll: { value: false },
          displayLoading: { value: 0.0 },
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
    }, [displayMaterial, tint, overlaid, behind]);

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
    // True while the canvas window is aimed to hold the whole visible span.
    const viewAimedRef = useRef(false);

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

    // Effect to create and manage spectrogram textures
    useEffect(() => {
      if (parked) return;
      let cancelled = false;
      const prepare = async () => {
        const { numBands, metadata, numFrames, sampleRate, texels } = spectrogramData;
        const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
        if (!packedSeedRef.current && !needsCanvasWindow(grid, canvasWindowBlocks(grid))) {
          await serializeFileTask(fileId, async () => {
            const history = getHistoryManager(fileId);
            await history.initialize();
            const manifest = history.getManifest();
            if (!manifest || cancelled) return;
            const current =
              (await history.currentBlockState()) ?? (await history.reconstruct(manifest.currentId)).packedData;
            const original = await history.rootRanges(new Uint32Array([0, texels]));
            const anchor = history.nearestFullAnchor(manifest.currentId);
            const side = anchor ? await deriveSideData(anchor) : null;
            if (cancelled) return;
            currentSeedRef.current = current;
            packedSeedRef.current = original ?? current;
            inverseSeedRef.current = side?.inverseMap ?? null;
          });
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
     * Returns true while a tile the view needs is still being read.
     */
    const applyDisplayTileUniforms = (
      pyramidStepLog2: number,
      framesPerPixel: number,
      viewZoomPower: number,
      viewOffset: number,
      viewportWidth: number,
    ): boolean => {
      const uniforms = displayMaterial.uniforms;
      const gl = glRef.current;
      const strokeRenderer = strokeRendererRef.current;
      const tiles = strokeRenderer?.getDisplayTiles();
      if (!gl || !strokeRenderer || !tiles) {
        uniforms.displayTileCount.value = 0;
        return false;
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
      let lacking = false;
      if (canvasCoversFile()) {
        tiles.update(gl, strokeRenderer.committedSource(), ringView, pyramidStepLog2);
      } else if ((canvasRef.current?.holdsView() ?? false) || viewAimedRef.current) {
        // The canvas is the sharp picture over the view, or is filling to be
        // it, so tiles read out of the store would serve nothing.
        tiles.release();
        lacking = true;
      } else {
        const missing = tiles.aim(ringView, pyramidStepLog2);
        requestRingTiles(tiles, missing);
        lacking = missing.length > 0;
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
      return lacking;
    };

    /**
     * Reads the taps of the tiles the ring is missing out of the committed
     * state and cuts them in as they land. The read goes through the canvas,
     * which lays the paint of a stroke still committing over the store's
     * values. A tile
     * whose level has moved on, or whose slot the bound window took back, is
     * dropped: the next aim asks again.
     */
    const requestRingTiles = (tiles: DisplayTileRing, missing: number[]): void => {
      if (missing.length === 0) return;
      const level = tiles.gridLevel();
      for (const tile of missing) {
        const key = `${level}:${tile}`;
        if (ringRequestsRef.current.has(key)) continue;
        ringRequestsRef.current.add(key);
        const runs = tiles.tileTapRuns(tile);
        const read = canvasRef.current
          ? canvasRef.current.readCommittedTaps(runs)
          : getHistoryManager(fileId).currentTaps(runs);
        void read
          .then((values) => {
            ringRequestsRef.current.delete(key);
            const gl = glRef.current;
            const live = strokeRendererRef.current?.getDisplayTiles();
            if (!values || !gl || live !== tiles) return;
            if (tiles.gridLevel() !== level || !tiles.canCutTile(tile)) return;
            tiles.cutTileFromTaps(gl, tile, values);
            // A tile cut mid-stroke came from a store without the dabs so far.
            if (canvasRef.current?.isStroking && tiles.uniforms().tileCount > 0) {
              strokeRendererRef.current?.refreshDisplayFromStroke();
            }
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
        uniforms.displayCanvasFirst.value = false;
        uniforms.displayTileCount.value = 0;
        uniforms.displayLoading.value = 0;
        loadingSinceRef.current = null;
        return;
      }
      const framesPerPixel = spectrogramData.numFrames / (Math.pow(2, viewZoomPower) * Math.max(1, viewportWidth));
      const finestStepLog2 = pyramid.levels[0].stepLog2;
      const ringLacks = applyDisplayTileUniforms(
        finestStepLog2,
        framesPerPixel,
        viewZoomPower,
        viewOffset,
        viewportWidth,
      );

      // Past the pyramid's finest level the canvas is the sharp picture, and
      // the finest level stands in wherever the canvas does not reach yet.
      const finerThanPyramid = 2 ** finestStepLog2 > Math.max(framesPerPixel, 1);
      const canvasHolds = canvasRef.current?.holdsView() ?? true;
      uniforms.displayCanvasFirst.value = finerThanPyramid && canvasHolds;
      const ready = pyramid.readyLevel;
      const choice = finerThanPyramid
        ? { fine: ready, coarse: ready, blend: 0 }
        : displayLevelChoice(pyramid.levels, framesPerPixel, ready);
      uniforms.displayFineTex.value = pyramid.texture(choice.fine);
      uniforms.displayFineMetaTex.value = pyramid.metadataTexture(choice.fine);
      uniforms.displayCoarseTex.value = pyramid.texture(choice.coarse);
      uniforms.displayCoarseMetaTex.value = pyramid.metadataTexture(choice.coarse);
      uniforms.displayLevelBlend.value = choice.blend;
      uniforms.displayPyramidActive.value = true;

      // A region the pyramid serves in place of something finer is greyed as
      // loading, after a grace so a zoom whose tiles land at once never flashes.
      const levelsLoading = !finerThanPyramid && displayLevelChoice(pyramid.levels, framesPerPixel).fine < ready;
      uniforms.displayFinerWanted.value = finerThanPyramid;
      uniforms.displayLoadingAll.value = levelsLoading;
      const lacking = levelsLoading || (finerThanPyramid && !canvasHolds && ringLacks);
      if (!lacking) {
        loadingSinceRef.current = null;
        uniforms.displayLoading.value = 0;
        return;
      }
      const now = performance.now();
      // The grace runs from the last move of the view, so a zoom or pan under
      // way is never greyed while it still moves.
      const viewMoved = loadingViewRef.current.zoom !== viewZoomPower || loadingViewRef.current.offset !== viewOffset;
      if (viewMoved) loadingViewRef.current = { zoom: viewZoomPower, offset: viewOffset };
      if (loadingSinceRef.current === null || viewMoved) loadingSinceRef.current = now;
      const fade = (now - loadingSinceRef.current - DISPLAY_LOADING_GRACE_MS) / DISPLAY_LOADING_FADE_MS;
      uniforms.displayLoading.value = Math.min(1, Math.max(0, fade));
      if (fade < 1) invalidateRef.current?.();
    };

    const applyStaticDisplayUniforms = (state: State, viewportWidth: number, viewportHeight: number): void => {
      const file = openFiles[fileId];
      if (!file?.spectrogramData || !inverseMapTex || !metadataTex) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      const viewZoomPower = state.filesZoom[viewFileId];
      const viewOffset = state.filesOffset[viewFileId];
      const viewZoomPowerY = state.filesZoomY[viewFileId] ?? 0;
      const viewOffsetY = state.filesOffsetY[viewFileId] ?? 0;

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

    /** The frames the file's view shows at its current zoom and offset. */
    const visibleFrameRange = (state: State): { start: number; end: number } => {
      const { numFrames } = spectrogramData;
      const zoom = Math.pow(2, state.filesZoom[viewFileId] ?? 0);
      const span = numFrames / zoom;
      const start = zoom > 1 ? (state.filesOffset[viewFileId] ?? 0) * (numFrames - span) : 0;
      return { start, end: start + span };
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
            const seed = await historyManager.currentBlockState();
            if (cancelled) return;
            packedSeedRef.current = seed;
            const manifest = historyManager.getManifest();
            const anchor = manifest ? historyManager.nearestFullAnchor(manifest.currentId) : null;
            if (anchor) {
              const { inverseMap } = await deriveSideData(anchor);
              inverseSeedRef.current = inverseMap ?? null;
            }
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
      scheduleSnapshotRefresh,
    ]);

    /**
     * The file and frames a dab at `cursorPos` reads through a window of this
     * canvas's own. Null when the brush paints from this file, or from one
     * whose canvas holds all of it — that canvas serves the read as it always
     * did. `cursorPos` is in the file's UV.
     */
    const sourceNeedsFor = (state: State, cursorPos: Vector2): SourceNeed[] => {
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
    };

    /** True while an enabled step reads a file's original state, which a windowed canvas holds only on request. */
    const wantsOriginal = (state: State): boolean => {
      const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
      for (let index = 0; index < steps.length; index++) {
        if (steps[index].enabled === false) continue;
        if (createStepStateView(state, index).sourceDataMode === "original") return true;
      }
      return false;
    };

    /** The file a convolve step filters through, by the path it names or this file. */
    const responseFileFor = (path: string | null) => (path ? getOpenFileByPath(path) : openFiles[fileId]) ?? null;

    /** True while that file's own canvas holds a window of it rather than all of it. */
    const responseIsWindowed = (id: string): boolean => {
      const response = openFiles[id];
      const view = response?.rendererRef?.current?.getCanvasView();
      if (!view || !response?.spectrogramData) return true;
      return !viewCoversFile(view, response.spectrogramData.numFrames);
    };

    /** The response every enabled convolve step reads, and the frames of it its taps cover. */
    const impulseNeedsFor = (state: State): ImpulseNeed[] =>
      impulseNeeds(state, (path) => {
        const response = responseFileFor(path);
        return response?.spectrogramData ? { id: response.id, spectrogramData: response.spectrogramData } : null;
      });

    /** The responses this canvas has to window, because their own canvases hold a window. */
    const windowedImpulseNeeds = (state: State): SourceNeed[] =>
      impulseNeedsFor(state)
        .map((entry) => entry.need)
        .filter((need) => responseIsWindowed(need.fileId));

    /**
     * The rectangle the brush paints inside for one aim point, in file UV: the
     * union of the steps' own rectangles, since size and anchor mode are
     * per-step. A snapped Grid-mode time brush fills the swung cell under the
     * aim, so the union takes that cell's width.
     */
    const brushUnionAt = (state: State, cursorPos: Vector2, bpm: number, totalDuration: number): BrushUnionUv => {
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
    };

    /**
     * Paints one stroke into the FBO from an explicit state snapshot. The frame
     * loop calls it with the live store and the cursor's brush origin; batch
     * a grid fill calls it once per stroke with a shared state. Returns false
     * when the source file's textures aren't ready.
     */
    const dispatchStroke = (
      state: State,
      cursorPos: Vector2,
      preview: boolean,
      sourceOverride?: SourceFileInfo,
      preparedSpan?: DabSpan,
    ): boolean => {
      const strokeRenderer = strokeRendererRef.current;
      const file = openFiles[fileId];
      if (!strokeRenderer || !file?.spectrogramData) return false;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      // The renderer paints over the span the canvas holds, so the cursor and
      // the duration it reads them against are the window's, not the file's.
      const canvas = canvasRef.current;
      if (canvas) {
        const span = preparedSpan ?? dabSpan(state, cursorPos, canvas);
        if (!canvas.holdsFrames(span.startFrame, span.endFrame, span.needs.original)) return false;
      }
      const dabCursor = canvas ? canvas.dabCursor(cursorPos) : cursorPos;
      const dabDuration = canvas ? canvas.dabDuration(totalDuration) : totalDuration;

      // A window of the file cannot serve a brush that reads all of it, and a
      // dab that painted anyway would commit whatever the window's edge held.
      if (strokeRefusal(state) !== null) return false;

      // A file a step paints from holds whatever span its own brush left its
      // canvas on, so a window of this canvas's own serves the read instead.
      const sourceWindows = new Map<string, SourceWindowTextures>();
      for (const need of sourceNeedsFor(state, cursorPos)) {
        const window = canvas?.aimSource(need);
        if (!window) return false;
        sourceWindows.set(need.fileId, window);
      }

      // A convolve step filters through a file whose own canvas holds whatever
      // span its own brush left it on, so a response on a windowed canvas gets
      // a window of this canvas's own, placed where the taps read.
      const impulses = new Map<string, ImpulseFileInfo>();
      for (const entry of impulseNeedsFor(state)) {
        const response = openFiles[entry.need.fileId];
        const spectrogram = response?.spectrogramData;
        if (!spectrogram) return false;
        if (responseIsWindowed(entry.need.fileId)) {
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

      // Both onset maps are baked here rather than inside the renderer so the
      // sensitivity control and the file's latest detections reach the shader
      // through one path. Sensitivity is per file — each side of a cross-file
      // paint uses its own.
      const toSourceInfo = (openFile: OpenFile | undefined): SourceFileInfo | undefined => {
        if (!openFile?.spectrogramData) return undefined;
        // Source UVs address whatever span the textures hold: this canvas's own
        // window over the file, or the span that file's own canvas sits on.
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

      // A step with no Source of its own falls back to this: the file being
      // painted, which is what "paint from myself" means.
      const sourceFileInfo =
        sourceOverride ??
        toSourceInfo(state.activeFileId ? openFiles[state.activeFileId] : undefined) ??
        toSourceInfo(openFiles[fileId]);
      if (!sourceFileInfo) return false;

      // Every step samples from the file its own Source control names, so the
      // renderer gets one entry per step rather than one file for the brush. A
      // step naming a file that is no longer open falls back to painting from
      // the file under the brush.
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
              viewZoomPower: state.filesZoom[viewFileId],
              viewOffset: state.filesOffset[viewFileId],
              viewZoomPowerY: state.filesZoomY[viewFileId] ?? 0,
              viewOffsetY: state.filesOffsetY[viewFileId] ?? 0,
              pressure: penState.pressure,
              tiltX: penState.tiltX,
              tiltY: penState.tiltY,
              destOnsetTexture,
              impulses,
              stepSources,
              selection: state.filesSelection[fileId] ?? null,
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
          const visible = visibleFrameRange(state);
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
      if (!canvas.wholeFile) {
        const visible = visibleFrameRange(state);
        // The window holds the view and the dab under the pointer when it can,
        // so the picture is sharp across the view and a dab lands anywhere in
        // it; a view wider than the window centres on the dab instead.
        let start = visible.start;
        let end = visible.end;
        if (cursorPos.x >= 0) {
          const bothStart = Math.min(visible.start, dabStart);
          const bothEnd = Math.max(visible.end, dabEnd);
          if (canvas.fitsWindow(bothStart, bothEnd)) {
            start = bothStart;
            end = bothEnd;
          } else {
            start = dabStart;
            end = dabEnd;
          }
        }
        viewAimedRef.current = start <= visible.start && end >= visible.end;
        // A stroke pages ahead of the brush every frame. Everything else — a
        // pointer crossing the file, a pan under way — waits until the aim
        // stops, and takes a frame at the moment it does.
        const wait = canvas.isStroking ? 0 : aimRest.current.wait(start, end, performance.now());
        if (wait === 0) canvas.aim(start, end, original);
        else scheduleAimRest(wait);
      }

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

    /** True while the canvas holds every frame of the file. */
    const canvasCoversFile = (): boolean => canvasRef.current?.coversFile() ?? true;

    /** The clocks a reach is measured against, or null while the canvas holds the whole file. */
    const reachContext = (state: State): ReachContext | null => {
      const canvas = canvasRef.current;
      const file = openFiles[fileId];
      if (!canvas || canvas.wholeFile || !file?.spectrogramData) return null;
      const spectrogram = file.spectrogramData;
      return {
        bpm: state.filepathsBpm[file.filePath] || 120,
        fileSeconds: spectrogram.numFrames / spectrogram.sampleRate,
        canvasSeconds: canvas.windowSeconds(),
        bandsPerOctave: spectrogram.bandsPerOctave,
        numBands: spectrogram.numBands,
        responseSpan: (path) => {
          const other = responseFileFor(path)?.spectrogramData;
          if (!other) return null;
          const stride = 1 << Math.max(...other.synthesisMetadata.bandStepLog2s);
          return { seconds: other.numFrames / other.sampleRate, binSeconds: stride / other.sampleRate };
        },
      };
    };

    /**
     * What the brush reads past its dab, and whether a window can serve it,
     * kept per state object: every dab of a grid fill shares one state, and
     * the frame loop reads one until the store moves.
     */
    const reachByState = new WeakMap<State, { refusal: string | null; frames: { before: number; after: number } }>();
    const reachOf = (state: State): { refusal: string | null; frames: { before: number; after: number } } => {
      const known = reachByState.get(state);
      if (known) return known;
      const ctx = reachContext(state);
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
      // Before the canvas exists the context is empty, and that answer must not outlive it.
      if (canvasRef.current) reachByState.set(state, entry);
      return entry;
    };

    const strokeRefusal = (state: State): string | null => reachOf(state).refusal;

    /**
     * Frames of the file the effect chain reads either side of the dab's own
     * span. Capped at the file, because an effect that reads without bound is
     * refused rather than aimed at.
     */
    const reachFrames = (state: State): { before: number; after: number } => reachOf(state).frames;

    const dabSpan = (
      state: State,
      cursorPos: Vector2,
      canvas: WindowedCanvas,
      resolvedUnion?: BrushUnionUv,
    ): DabSpan => {
      const file = openFiles[fileId];
      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { numFrames, sampleRate } = spectrogramData;
      const totalDuration = numFrames / sampleRate;
      const reach = canvas.wholeFile ? { before: 0, after: 0 } : reachFrames(state);
      const union = resolvedUnion ?? brushUnionAt(state, cursorPos, bpm, totalDuration);
      return {
        startFrame: (union.hasSteps ? union.min.x : cursorPos.x) * numFrames - reach.before,
        endFrame: (union.hasSteps ? union.max.x : cursorPos.x) * numFrames + reach.after,
        needs: {
          sources: sourceNeedsFor(state, cursorPos),
          impulses: windowedImpulseNeeds(state),
          original: !canvas.wholeFile && wantsOriginal(state),
        },
      };
    };

    /** Takes a frame when the aim comes to rest, since a still pointer sends no events. */
    const scheduleAimRest = (wait: number): void => {
      if (aimRestTimer.current !== null) clearTimeout(aimRestTimer.current);
      aimRestTimer.current = setTimeout(() => {
        aimRestTimer.current = null;
        invalidateRef.current?.();
      }, wait);
    };

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
        if (ahead && ahead.length > 0) {
          // Strokes come in time order, so the first and the last bound the span.
          const first = ahead[0];
          const last = ahead[ahead.length - 1];
          const from = dabSpan(first.state, new Vector2(first.aimX, first.aimY), canvas);
          const to = dabSpan(last.state, new Vector2(last.aimX, last.aimY), canvas);
          canvas.prefetch(Math.min(from.startFrame, to.startFrame), Math.max(from.endFrame, to.endFrame));
        }
        let painted = 0;
        for (const stroke of strokes) {
          // A dab blends out of the canvas, so one on a block the canvas has
          // no content for waits for its window, as a pointer's dab does.
          if (strokeRefusal(stroke.state) !== null) continue;
          const aim = new Vector2(stroke.aimX, stroke.aimY);
          const span = dabSpan(stroke.state, aim, canvas);
          const dabState = stroke.state;
          if (
            canvas.paintWhenHeld(span.startFrame, span.endFrame, span.needs, () =>
              dispatchStroke(dabState, aim, false, undefined, span),
            )
          ) {
            painted++;
          }
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
        await canvasRef.current?.settle();
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
