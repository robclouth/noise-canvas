import { notifications } from "@mantine/notifications";
import type { Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat, RGFormat, Vector2 } from "three";
import { effects } from "../effects";
import type { StrokePosition, useTransientStore } from "../store/transient";
import type { OpenFile, SpectrogramData, State } from "../store/types";
import { bandMetadataTexture } from "./band-metadata-texture";
import type { CanvasView } from "./canvas-view";
import { DEFAULT_ONSET_SENSITIVITY } from "./constants";
import { exportBlockGrid, ExportSourceWindow } from "./export-window";
import type {
  BrushUnionUv,
  DabSpan,
  FileRendererHandle,
  FileDisplayData,
  RegionStroke,
  StrokeDispatch,
} from "./file-renderer-types";
import {
  dispatchStroke as dispatchFileStroke,
  dabSpan as fileDabSpan,
  strokeRefusal as fileStrokeRefusal,
  paintDab,
  prepareStrokeBatch,
  type DispatchOptions,
  type FileStrokeContext,
} from "./file-stroke-dispatch";
import type { serializeFileTask } from "./file-task-queue";
import { canvasWindowBlocks } from "./gpu-budget";
import type { deriveSideData, getHistoryManager } from "./history-manager";
import { renderExportImage as renderExportImageToCanvas, type ImageExportOptions } from "./image-export";
import type { PosterInfo } from "./image-export-poster";
import { getOnsetTexture, packOnsetState } from "./onset-map";
import { StrokeRenderer, type SourceFileInfo, type StrokeTextures } from "./stroke-renderer";
import { brushUnionForAim } from "./brush-anchor";
import { driveDabLog, recordDab } from "./drive-probe";
import { unitsToUv } from "./utils";
import { CoarseCanvas } from "./coarse-canvas";
import { DAB_NOT_TAKEN, STROKE_LOCKED, showPartlyPainted } from "./stroke-notices";
import { WindowedCanvas, type UvRegion } from "./windowed-canvas";

type EngineTextures = { packed: DataTexture; inverse: DataTexture; meta: DataTexture };
type FileEngineOperations = Omit<FileRendererHandle, "renderStroke" | "clearPreview">;
export interface FileEngineServices {
  getHistoryManager: typeof getHistoryManager;
  deriveSideData: typeof deriveSideData;
  serializeFileTask: typeof serializeFileTask;
  openFiles: Record<string, OpenFile>;
  logFileFootprint: (id: string, label: string) => void;
  getState: () => State;
  getTransientState: typeof useTransientStore.getState;
}
export interface FileEngineContext {
  spectrogramData: SpectrogramData;
  glRef: { current: WebGLRenderer };
  invalidateRef: { current: () => void };
  modulatorScaleLut: StrokeTextures["modulatorScaleLut"];
  modulator1Texture: StrokeTextures["modulator1Texture"];
  modulator2Texture: StrokeTextures["modulator2Texture"];
  modulator3Texture: StrokeTextures["modulator3Texture"];
  placeholderTexture: StrokeTextures["placeholderTexture"];
  resourcesChanged: () => void;
  strokeContext: FileStrokeContext;
}

/** Paints one dab; a preview goes to the partner buffer. */
type StrokePainter = (state: State, cursorPos: Vector2, preview: boolean, options?: DispatchOptions) => boolean;
/** The frames and reads one dab at `cursorPos` needs. */
type StrokeSpanner = (
  state: State,
  cursorPos: Vector2,
  canvas: WindowedCanvas,
  resolvedUnion?: BrushUnionUv,
) => DabSpan;
/** Why the brush cannot paint here, or null. */
type StrokeRefuser = (state: State, aim?: { x: number; y: number }) => string | null;
/**
 * Paints one committed dab through the canvas, on it or beside it; false
 * when neither can. `painted` is called each time a piece lands.
 */
type DabLayer = (
  state: State,
  aim: Vector2,
  canvas: WindowedCanvas,
  span: DabSpan,
  options?: DispatchOptions,
  painted?: () => void,
) => boolean;

// Settling a stroke longer than this shows how far it has got.
const EDIT_PROGRESS_AFTER_MS = 500;
// How often the progress it shows is brought up to date.
const EDIT_PROGRESS_INTERVAL_MS = 100;

/** Owns an open file's editable resources and operations. */
export class FileEngine {
  readonly strokeRendererRef: { current: StrokeRenderer | null } = { current: null };
  readonly canvasRef: { current: WindowedCanvas | null } = { current: null };
  readonly coarseRef: { current: CoarseCanvas | null } = { current: null };
  readonly historyHookedRef = { current: false };
  readonly liveTexturesRef: { current: EngineTextures | null } = { current: null };
  readonly isParkedRef: { current: boolean | undefined } = { current: false };
  readonly displayMode: { current: "preview" | "committed" } = { current: "committed" };
  readonly applyStroke = { current: false };
  readonly strokePreview = { current: false };
  /** Positions the pointer crossed between frames during a stroke, painted in order ahead of the cursor's dab. */
  readonly strokeTrail: StrokePosition[] = [];
  /** The position of the stroke's latest committed dab, so a queued repeat of it is not painted twice. */
  lastStrokeDab: StrokePosition | null = null;
  private context!: FileEngineContext;
  private disposed = false;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly fileId: string,
    private readonly services: FileEngineServices,
    parked?: boolean,
  ) {
    this.isParkedRef.current = parked;
  }
  updateContext(context: FileEngineContext): void {
    this.context = context;
  }
  get reachByState(): FileStrokeContext["reachByState"] {
    return this.context.strokeContext.reachByState;
  }
  subscribeVisualChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  contentRevision = 0;
  residencyRevision = 0;
  notifyContentChanged = (): void => {
    this.contentRevision++;
    for (const listener of this.listeners) listener();
  };
  notifyResidencyChanged = (): void => {
    this.residencyRevision++;
    for (const listener of this.listeners) listener();
  };
  private visualChanged = this.notifyContentChanged;
  createTextures = (spectrogramData = this.context.spectrogramData) => {
    const { numBands, metadata } = spectrogramData;
    // The canvas lays out its own view, so the file-wide packed and inverse
    // textures are placeholders the renderer never samples.
    const texWidth = 1;
    const texHeight = 1;
    const packedData = new Float32Array(4);
    const inverseMap = new Float32Array(2);

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

    const meta = bandMetadataTexture({ numBands, metadata }, spectrogramData.sampleRate);

    return { packed, inverse, meta };
  };
  disposeLiveTextures = () => {
    const { liveTexturesRef } = this;
    const live = liveTexturesRef.current;
    if (!live) return;
    live.packed.dispose();
    live.inverse.dispose();
    live.meta.dispose();
    liveTexturesRef.current = null;
  };
  installTextures = (next: EngineTextures) => {
    const { liveTexturesRef } = this;
    liveTexturesRef.current = next;
    this.context.resourcesChanged();
  };
  prepare = (parked: boolean | undefined): (() => void) | undefined => {
    const { strokeRendererRef, createTextures, disposeLiveTextures, installTextures, disposeCanvas } = this;
    const { spectrogramData } = this.context;
    if (parked) return;
    if (strokeRendererRef.current) {
      strokeRendererRef.current.dispose();
      strokeRendererRef.current = null;
    }
    disposeCanvas();
    installTextures(createTextures(spectrogramData));

    return () => {
      disposeLiveTextures();
      this.context.resourcesChanged();
    };
  };
  canvasFor = (gl: WebGLRenderer): WindowedCanvas => {
    const { strokeRendererRef, canvasRef, fileId } = this;
    const { spectrogramData, invalidateRef } = this.context;
    const { getHistoryManager, openFiles } = this.services;
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
        revision: () => getHistoryManager(fileId).revision,
        onChanged: () => {
          this.notifyResidencyChanged();
          invalidateRef.current?.();
        },
        // Another file is read as its canvas shows it: the store, with the
        // paint of strokes whose commits have not landed laid over it.
        sourceBlocks: (sourceId) => {
          const source = openFiles[sourceId];
          const spectrogram = source?.spectrogramData;
          if (!spectrogram) return null;
          const shown = () => openFiles[sourceId]?.rendererRef?.current;
          return {
            spectrogram,
            readCurrent: async (ranges) => {
              const values = await getHistoryManager(sourceId).currentRanges(ranges);
              const handle = shown();
              return values && handle?.withPendingPaint ? handle.withPendingPaint(ranges, values) : values;
            },
            readRoot: (ranges) => getHistoryManager(sourceId).rootRanges(ranges),
            readCurrentBlock: async (index) => {
              const values = await getHistoryManager(sourceId).currentBlock(index);
              const handle = shown();
              return values && handle?.blockWithPendingPaint ? handle.blockWithPendingPaint(index, values) : values;
            },
            readRootBlock: (index) => getHistoryManager(sourceId).rootBlock(index),
            revision: () => getHistoryManager(sourceId).revision + (shown()?.pendingPaintRevision?.() ?? 0),
          };
        },
      });
      this.coarseRef.current = new CoarseCanvas(gl);
    }
    return canvasRef.current;
  };
  disposeCanvas = (): void => {
    const { canvasRef, coarseRef } = this;
    coarseRef.current?.dispose();
    coarseRef.current = null;
    canvasRef.current?.dispose();
    canvasRef.current = null;
  };
  /**
   * Paints a dab on the coarse canvas too, as a preview or as part of the
   * stroke on it, for a canvas that holds a window of the file. False when
   * the coarse canvas has no picture to paint on yet.
   */
  paintCoarse = (state: State, aim: Vector2, span: DabSpan, preview: boolean, paint: StrokePainter): boolean => {
    const coarse = this.coarseRef.current;
    const parent = this.strokeRendererRef.current;
    if (!coarse || !parent || this.canvasRef.current?.holdsWholeFile !== false) return false;
    if (!coarse.sync(parent, this.context.spectrogramData.numFrames)) return false;
    const target = coarse.target;
    if (!target) return false;
    return paint(state, aim, preview, { span, beside: { ...target, reads: span.hover, sketch: true } });
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.listeners.clear();
    this.disposeLiveTextures();
    const { strokeRendererRef, disposeCanvas } = this;
    if (strokeRendererRef.current) {
      strokeRendererRef.current.dispose();
      strokeRendererRef.current = null;
    }
    disposeCanvas();
  };
  park = (): (() => void) => {
    const { strokeRendererRef, isParkedRef, disposeLiveTextures, disposeCanvas, fileId } = this;
    const { resourcesChanged } = this.context;
    const { getHistoryManager, serializeFileTask, openFiles } = this.services;

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
      resourcesChanged();
      if (openFiles[fileId]) {
        openFiles[fileId].parked = true;
      }
    });
    return () => {
      cancelled = true;
    };
  };
  resume = (): (() => void) | undefined => {
    const { historyHookedRef, isParkedRef, createTextures, installTextures, visualChanged, fileId } = this;
    const { spectrogramData, invalidateRef } = this.context;
    const { getHistoryManager, serializeFileTask, openFiles } = this.services;

    if (!isParkedRef.current) return;
    isParkedRef.current = false;
    let cancelled = false;
    void serializeFileTask(fileId, async () => {
      const file = openFiles[fileId];
      if (cancelled || !file?.parked) return;
      file.parked = false;
      const historyManager = getHistoryManager(fileId);
      if (!(file.spectrogramData ?? spectrogramData)) return;

      installTextures(createTextures(spectrogramData));

      invalidateRef.current?.();
      visualChanged();

      if (historyHookedRef.current && !file.audioBuffer) await historyManager.restoreCurrentAudio();
    });
    return () => {
      cancelled = true;
    };
  };
  initialise = (
    visibleFrames: () => { start: number; end: number },
    releaseSeeds = true,
  ): StrokeRenderer | undefined => {
    const originalPackedDataTex = this.liveTexturesRef.current?.packed ?? null;
    const inverseMapTex = this.liveTexturesRef.current?.inverse ?? null;
    const metadataTex = this.liveTexturesRef.current?.meta ?? null;
    if (this.disposed || this.isParkedRef.current || !originalPackedDataTex || !inverseMapTex || !metadataTex) return;
    const { strokeRendererRef, canvasRef, historyHookedRef, canvasFor, releaseAnalysisData, fileId } = this;
    const {
      spectrogramData,
      glRef,
      modulatorScaleLut,
      modulator1Texture,
      modulator2Texture,
      modulator3Texture,
      placeholderTexture,
    } = this.context;
    const { getHistoryManager, serializeFileTask, openFiles, logFileFootprint, getState } = this.services;
    const gl = glRef.current;
    const state = getState();

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

      try {
        const visible = visibleFrames();
        const view = canvasFor(gl).firstView(visible.start, visible.end);
        strokeRendererRef.current = new StrokeRenderer(gl, spectrogramData, textures, fileId, effects, view);
      } catch (error) {
        console.error("Creating the stroke renderer failed:", error);
        notifications.show({
          title: "Not enough graphics memory",
          message: "The file was closed because the graphics device could not allocate its buffers.",
          color: "red",
        });
        getState().closeFile(fileId);
        return;
      }
      logFileFootprint(fileId, "textures allocated");
    }

    const strokeRenderer = strokeRendererRef.current;

    if (!strokeRenderer.getIsInitialized()) {
      canvasFor(gl).initialize(spectrogramData.packedData ?? null, spectrogramData.coarseStrip ?? null);
      if (historyHookedRef.current && releaseSeeds) {
        releaseAnalysisData(spectrogramData);
      }
    }

    if (!historyHookedRef.current) {
      historyHookedRef.current = true;

      const epoch = this.epoch;
      const current = () => !this.disposed && this.epoch === epoch;
      (async () => {
        const historyManager = getHistoryManager(fileId);
        const packed = spectrogramData.packedData;

        const nodeId = await serializeFileTask(fileId, async () => {
          const hadExisting = await historyManager.initialize();
          if (!current() || hadExisting) return null;

          const id = await historyManager.addRootSnapshot({
            data: packed ?? null,
            kind: "root",
            label: "Opened",
            spectrogram: spectrogramData,
          });

          if (!current()) return null;
          const opened = openFiles[fileId];
          if (id && opened?.onsets && (opened.onsetReference?.odfMax ?? 0) > 0) {
            void historyManager
              .setNodeOnsets(id, packOnsetState({ onsets: opened.onsets, reference: opened.onsetReference }))
              .catch((error) => console.error("Storing onsets for history node failed:", error));
          }
          return id;
        });

        if (!current()) return;
        if (!packed) void canvasRef.current?.storeReady();

        releaseAnalysisData(spectrogramData);
        // Whatever the first pass finds, a brush stops waiting for onsets once it is done.
        const onsetsSettled = (): void => {
          const opened = openFiles[fileId];
          if (opened) opened.onsetsPending = false;
        };
        if (nodeId === null) {
          try {
            if (!openFiles[fileId]?.audioBuffer) await historyManager.restoreCurrentAudio();
          } finally {
            onsetsSettled();
          }
          return;
        }
        const gateBefore = openFiles[fileId]?.onsetReference?.odfMax ?? 0;
        try {
          await state.synthesizeFile(fileId, undefined, packed);
        } finally {
          onsetsSettled();
        }
        if (!current()) return;
        const updated = openFiles[fileId];
        if (nodeId && updated?.audioBuffer) {
          historyManager.setStateAudio(nodeId, updated.audioBuffer, updated.audioPeak ?? 1);
        }
        if (nodeId && gateBefore <= 0 && updated?.onsets && (updated.onsetReference?.odfMax ?? 0) > 0) {
          void historyManager
            .setNodeOnsets(nodeId, packOnsetState({ onsets: updated.onsets, reference: updated.onsetReference }))
            .catch((error) => console.error("Storing onsets for history node failed:", error));
        }
      })().catch((error: unknown) => console.error("Attaching file history failed:", error));
    }

    return strokeRenderer;
  };
  renderExportImage = async (
    options: ImageExportOptions,
    posterInfo: PosterInfo,
    onProgress?: (fraction: number) => void,
  ): Promise<HTMLCanvasElement | null> => {
    const { strokeRendererRef, canvasRef, fileId } = this;
    const { spectrogramData, glRef } = this.context;
    const { getHistoryManager } = this.services;
    const gl = glRef.current;
    const strokeRenderer = strokeRendererRef.current;
    if (!gl || !strokeRenderer || !strokeRenderer.getIsInitialized()) return null;
    const exportGrid = exportBlockGrid(spectrogramData);
    const windowed = canvasRef.current && !canvasRef.current.holdsWholeFile;
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
  regionToFileUv = (region: UvRegion | null): UvRegion | null => {
    const { canvasRef } = this;
    return canvasRef.current ? canvasRef.current.regionToFileUv(region) : region;
  };
  afterStateMove = (): void => {
    const { displayMode, applyStroke, visualChanged } = this;
    const { invalidateRef } = this.context;

    applyStroke.current = false;
    this.strokeTrail.length = 0;
    displayMode.current = "committed";
    invalidateRef.current();
    visualChanged();
  };

  /**
   * Paints the positions queued since the last frame, each once the canvas
   * holds its frames, in the order the pointer crossed them.
   */
  paintStrokeTrail = (
    state: State,
    canvas: WindowedCanvas,
    spec: SpectrogramData,
    bpm: number,
    layDab: DabLayer,
    span: StrokeSpanner,
  ): void => {
    if (this.strokeTrail.length === 0) return;
    const totalDuration = spec.numFrames / spec.sampleRate;
    for (const point of this.strokeTrail.splice(0)) {
      const last = this.lastStrokeDab;
      if (last && last.beats === point.beats && last.pitch === point.pitch) continue;
      this.lastStrokeDab = point;
      const uv = unitsToUv(point.beats, point.pitch, bpm, totalDuration, spec.bandsPerOctave, spec.numBands);
      if (uv.x < 0) continue;
      const aim = new Vector2(uv.x, uv.y);
      const dab = span(state, aim, canvas);
      const union = driveDabLog()
        ? brushUnionForAim(state, aim.x, aim.y, bpm, totalDuration, spec.bandsPerOctave, spec.numBands)
        : null;
      const record = union ? recordDab(this.fileId, union.blX, union.blY, union.sizeUvX, union.sizeUvY) : null;
      const laid = layDab(state, aim, canvas, dab, {}, () => {
        if (record) record.paintedAt = Date.now();
      });
      if (!laid) this.reportDroppedDab(state, aim);
    }
  };

  /** Tells the user, once a stroke, that a dab of it did not paint, and why. */
  private reportDroppedDab(state: State, aim: { x: number; y: number }): void {
    if (this.droppedDabReported) return;
    this.droppedDabReported = true;
    const reason = this.rollbackFailed
      ? STROKE_LOCKED
      : (fileStrokeRefusal(this.context.strokeContext, state, aim) ?? DAB_NOT_TAKEN);
    showPartlyPainted(this.fileId, reason);
  }
  private droppedDabReported = false;
  getFBOData = async (): Promise<Float32Array | null> => {
    const { canvasRef } = this;

    if (!canvasRef.current) throw new Error("StrokeRenderer not initialized");
    return await canvasRef.current.getFBOData();
  };
  readPixelRanges = async (pixelRanges: Uint32Array): Promise<Float32Array> => {
    const { canvasRef } = this;

    if (!canvasRef.current) throw new Error("StrokeRenderer not initialized");
    return await canvasRef.current.readPixelRanges(pixelRanges);
  };
  setFBOData = (data: Float32Array) => {
    const { canvasRef, afterStateMove } = this;

    if (canvasRef.current?.setFBOData(data)) {
      this.rollbackFailed = false;
      afterStateMove();
    }
  };
  applyPhaseTurns = (turns: ArrayLike<number>) => {
    const { canvasRef, afterStateMove } = this;

    if (canvasRef.current?.applyPhaseTurns(turns)) afterStateMove();
  };
  patchFBOData = (data: Float32Array, pixelRanges: Uint32Array) => {
    const { canvasRef, afterStateMove } = this;

    if (canvasRef.current?.patchFBOData(data, pixelRanges)) afterStateMove();
  };
  patchFBODataCompact = (values: Float32Array, pixelRanges: Uint32Array) => {
    const { canvasRef, afterStateMove } = this;

    if (canvasRef.current?.patchFBODataCompact(values, pixelRanges)) afterStateMove();
  };
  getTextures = (): {
    packed: WebGLRenderTarget;
    inverse: Texture;
    metadata: DataTexture;
    original: Texture;
  } | null => {
    const originalPackedDataTex = this.liveTexturesRef.current?.packed ?? null;
    const inverseMapTex = this.liveTexturesRef.current?.inverse ?? null;
    const metadataTex = this.liveTexturesRef.current?.meta ?? null;
    const { strokeRendererRef } = this;

    if (!strokeRendererRef.current || !inverseMapTex || !metadataTex || !originalPackedDataTex) return null;
    return strokeRendererRef.current.getTextures();
  };
  borrowDisplaySource = (): FileDisplayData | null => {
    const live = this.liveTexturesRef.current;
    if (!live) return null;
    return {
      spectrogramData: this.context.spectrogramData,
      inverseMapTex: live.inverse,
      metadataTex: live.meta,
      canvasView: this.strokeRendererRef.current?.committedSource().view,
      canvasMetadataTex: this.strokeRendererRef.current?.getTextures().metadata ?? live.meta,
    };
  };
  getCanvasView = (): CanvasView | null => {
    const { strokeRendererRef } = this;
    return strokeRendererRef.current?.committedSource().view ?? null;
  };
  restoreOriginal = (): Promise<void> => {
    const { fileId } = this;
    const { getHistoryManager } = this.services;
    return getHistoryManager(fileId).restoreOriginal();
  };
  reloadTextures = () => {
    this.epoch++;
    const spectrogram = this.services.openFiles[this.fileId]?.spectrogramData;
    if (spectrogram) {
      this.context.spectrogramData = spectrogram;
      this.context.strokeContext.spectrogramData = spectrogram;
    }
    const { strokeRendererRef, createTextures, disposeLiveTextures, installTextures, disposeCanvas, visualChanged } =
      this;
    const { invalidateRef, spectrogramData } = this.context;

    disposeLiveTextures();

    if (strokeRendererRef.current) {
      strokeRendererRef.current.dispose();
      strokeRendererRef.current = null;
    }
    disposeCanvas();
    if (this.isParkedRef.current) return;

    installTextures(createTextures(spectrogramData));

    invalidateRef.current();
    visualChanged();
  };
  releaseAnalysisData = (spectrogramData = this.context.spectrogramData) => {
    const { liveTexturesRef } = this;
    const { glRef } = this.context;

    const live = liveTexturesRef.current;
    const gl = glRef.current;
    if (!live || !gl) return;
    gl.initTexture(live.packed);
    live.packed.image.data = new Float32Array(0);
    spectrogramData.packedData = undefined;
    spectrogramData.coarseStrip = undefined;
    gl.initTexture(live.inverse);
    live.inverse.image.data = new Float32Array(0);
    spectrogramData.inverseMap = undefined;
  };
  discardStrokePreview = async (): Promise<boolean> => {
    const { canvasRef, displayMode } = this;
    const { invalidateRef } = this.context;
    this.restoringStroke = true;
    const canvas = canvasRef.current;
    let revision = canvas?.strokeRevision;
    const hadStroke = canvas?.strokeDiscardable ?? false;
    try {
      const restoration = canvas ? canvas.discardStroke() : Promise.resolve(false);
      this.coarseRef.current?.endStroke();
      revision = canvas?.strokeRevision;
      const restored = await restoration;
      if (canvas !== canvasRef.current || revision !== canvas?.strokeRevision) return false;
      this.rollbackFailed = !restored && hadStroke;
      if (restored) {
        displayMode.current = "committed";
        invalidateRef.current?.();
        this.notifyContentChanged();
      }
      return restored;
    } catch {
      if (canvas === canvasRef.current && revision === canvas?.strokeRevision) this.rollbackFailed = true;
      return false;
    } finally {
      if (this.rollbackFailed)
        notifications.show({ color: "red", title: "Stroke Not Applied", message: STROKE_LOCKED });
      this.restoringStroke = false;
      if (!this.settlingStroke) this.releaseStrokeWaiters();
    }
  };
  private settlingStroke = false;
  private restoringStroke = false;
  private rollbackFailed = false;
  private strokeWaiters: (() => void)[] = [];

  /**
   * Runs `start` once the stroke now settling or restoring has ended, so a
   * stroke begun meanwhile starts after the last one's commit has read it.
   * False when no stroke can start again on this canvas.
   */
  whenStrokeFree = (start: () => void): boolean => {
    if (this.rollbackFailed || !this.canvasRef.current) return false;
    this.strokeWaiters.push(start);
    return true;
  };

  private releaseStrokeWaiters(): void {
    for (const start of this.strokeWaiters.splice(0)) start();
  }

  beginStroke = (): boolean => {
    if (this.settlingStroke || this.restoringStroke || this.rollbackFailed || !this.canvasRef.current) return false;
    this.strokeTrail.length = 0;
    this.lastStrokeDab = null;
    this.droppedDabReported = false;
    this.canvasRef.current.beginStroke();
    const parent = this.strokeRendererRef.current;
    if (
      parent &&
      !this.canvasRef.current.holdsWholeFile &&
      this.coarseRef.current?.sync(parent, this.context.spectrogramData.numFrames)
    )
      this.coarseRef.current.beginStroke();
    return true;
  };
  endStroke = () => {
    const { canvasRef } = this;
    const { invalidateRef } = this.context;

    if (this.rollbackFailed) return;
    canvasRef.current?.endStroke();
    this.notifyContentChanged();
    invalidateRef.current?.();
    this.releaseStrokeWaiters();
  };
  fileOperations = (): FileEngineOperations => {
    const {
      strokeRendererRef,
      canvasRef,
      displayMode,
      applyStroke,
      strokePreview,
      regionToFileUv,
      getFBOData,
      readPixelRanges,
      setFBOData,
      applyPhaseTurns,
      patchFBOData,
      patchFBODataCompact,
      getTextures,
      getCanvasView,
      restoreOriginal,
      reloadTextures,
      releaseAnalysisData,
      discardStrokePreview,
      beginStroke,
      endStroke,
      fileId,
    } = this;
    const { invalidateRef, strokeContext } = this.context;
    const { openFiles, getState, getTransientState } = this.services;
    const { paint: dispatchStroke, span: dabSpan, refusal: strokeRefusal, layDab } = this.strokeDispatch(strokeContext);
    return {
      renderExportImage: this.renderExportImage,
      renderRegionStroke: (stroke: RegionStroke, preview: boolean) => {
        const aim = new Vector2(stroke.aimX, stroke.aimY);
        const canvas = canvasRef.current;
        let painted: boolean;
        if (preview || !canvas) {
          painted = dispatchStroke(stroke.state, aim, preview, { source: stroke.source });
        } else {
          // Like a brush dab, a region lands once the canvas holds its frames;
          // `settleStroke` waits for it.
          const span = dabSpan(stroke.state, aim, canvas);
          painted = layDab(stroke.state, aim, canvas, span, { source: stroke.source });
        }
        if (!painted) return false;
        displayMode.current = preview ? "preview" : "committed";
        invalidateRef.current?.();
        this.notifyContentChanged();
        return true;
      },
      createRegionSource: (id: string, spec: SpectrogramData, onsets?: Float32Array, onsetSensitivity?: number) => {
        const strokeRenderer = strokeRendererRef.current;
        if (!strokeRenderer?.getIsInitialized()) return null;

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
        if (this.rollbackFailed || !strokeRenderer?.getIsInitialized() || !canvas)
          return { painted: 0, refused: strokes[0] ?? null };
        const result = prepareStrokeBatch(strokeContext, canvas, strokes, ahead);
        if (result.painted > 0) displayMode.current = "committed";
        invalidateRef.current?.();
        this.notifyContentChanged();
        return result;
      },
      queueStrokeDabs: (points: readonly StrokePosition[]) => {
        this.strokeTrail.push(...points);
      },
      whenStrokeFree: this.whenStrokeFree,
      beginStrokePreview: beginStroke,
      discardStrokePreview,
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
      reloadTextures,
      releaseAnalysisData,
      beginStroke,
      endStroke,
      holdPaint: (ranges, values) => canvasRef.current?.holdPaint(ranges, values) ?? (async () => {}),
      withPendingPaint: async (ranges, values) => canvasRef.current?.withPendingPaint(ranges, values) ?? values,
      blockWithPendingPaint: async (index, values) => canvasRef.current?.blockWithPendingPaint(index, values) ?? values,
      pendingPaintRevision: () => canvasRef.current?.pendingPaintRevision ?? 0,
      landUnderStroke: (ranges, values, own) => canvasRef.current?.landUnderStroke(ranges, values, own),
      forgetBlocks: (ranges) => canvasRef.current?.forgetBlocks(ranges),
      settleStroke: async (signal) => {
        if (this.settlingStroke) return { status: "cancelled" };
        if (this.rollbackFailed) return { status: "failed", reason: "read-error" };
        const canvas = canvasRef.current;
        if (
          (this.strokeTrail.length > 0 || (applyStroke.current && !strokePreview.current)) &&
          canvas &&
          strokeRendererRef.current?.getIsInitialized()
        ) {
          const paintCursor = applyStroke.current && !strokePreview.current;
          applyStroke.current = false;
          const state = getState();
          const { cursorPosition, hoveredFile } = getTransientState();
          const file = openFiles[fileId];
          const spec = file?.spectrogramData;
          const bpm = (file && state.filepathsBpm[file.filePath]) || 120;
          if (spec) {
            this.paintStrokeTrail(state, canvas, spec, bpm, layDab, dabSpan);
            displayMode.current = "committed";
          }
          if (paintCursor && spec && cursorPosition && (state.activeFileId === fileId || hoveredFile === fileId)) {
            const aim = unitsToUv(
              cursorPosition.beats,
              cursorPosition.pitch,
              bpm,
              spec.numFrames / spec.sampleRate,
              spec.bandsPerOctave,
              spec.numBands,
            );
            if (aim.x >= 0) {
              this.lastStrokeDab = cursorPosition;
              if (!layDab(state, aim, canvas, dabSpan(state, aim, canvas))) this.reportDroppedDab(state, aim);
            }
          }
        }
        if (!canvas) return { status: "cancelled" };
        this.settlingStroke = true;
        const revision = canvas.strokeRevision;
        const stop = new AbortController();
        const forward = () => stop.abort();
        signal?.addEventListener("abort", forward, { once: true });
        const unwatch = this.watchSettle(canvas, forward);
        try {
          const result = await canvas.settle(stop.signal);
          if (canvas !== canvasRef.current || revision !== canvas.strokeRevision) return { status: "cancelled" };
          if (result.status !== "completed") {
            this.applyStroke.current = false;
            const restored = await this.discardStrokePreview();

            if (result.status === "failed" && restored)
              notifications.show({
                color: "red",
                title: "Stroke Not Applied",
                message:
                  result.reason === "read-error"
                    ? "Part of the file could not be read back from disk, so the stroke was taken off. Paint it again."
                    : "The canvas could not load the part of the file the stroke needs, so the stroke was taken off. Paint it again.",
              });
          }
          return result;
        } finally {
          unwatch();
          signal?.removeEventListener("abort", forward);
          this.settlingStroke = false;
        }
      },
      getDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.getDirtyRegion() ?? null),
      clearDirtyRegion: () => strokeRendererRef.current?.clearDirtyRegion(),
      consumeDirtyRegion: () => regionToFileUv(strokeRendererRef.current?.consumeDirtyRegion() ?? null),
      getDirtyPixelRanges: () => canvasRef.current?.dirtyPixelRanges() ?? null,
      getCommittedFootprintUv: () => canvasRef.current?.committedFootprintUv() ?? null,
      getStrokeGeneration: () => strokeRendererRef.current?.getStrokeGeneration() ?? 0,
      expandDirtyRegion: (startX: number, endX: number, startY: number, endY: number) =>
        canvasRef.current?.expandDirtyRegion(startX, endX, startY, endY),
    };
  };
  /**
   * Shows how far `canvas` has got painting the stroke once settling it runs
   * long, with `cancel` to stop it, until the returned function is called. A
   * grid fill shows its own progress instead.
   */
  private watchSettle(canvas: WindowedCanvas, cancel: () => void): () => void {
    const { getState } = this.services;
    if (getState().isFilling) return () => {};
    let total = canvas.pendingWork;
    let shown = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const update = (): void => {
      const left = canvas.pendingWork;
      total = Math.max(total, left);
      getState().showEditProgress({ done: total - left, total }, cancel);
      shown = true;
    };
    const delay = setTimeout(() => {
      update();
      interval = setInterval(update, EDIT_PROGRESS_INTERVAL_MS);
    }, EDIT_PROGRESS_AFTER_MS);
    return () => {
      clearTimeout(delay);
      if (interval) clearInterval(interval);
      if (shown) getState().showEditProgress(null);
    };
  }
  strokeDispatch = (
    strokeContext: FileStrokeContext,
  ): { paint: StrokePainter; span: StrokeSpanner; refusal: StrokeRefuser; layDab: DabLayer } => ({
    paint: (state: State, cursorPos: Vector2, preview: boolean, options?: DispatchOptions): boolean =>
      !this.rollbackFailed && dispatchFileStroke(strokeContext, state, cursorPos, preview, options),
    span: (state: State, cursorPos: Vector2, canvas: WindowedCanvas, resolvedUnion?: BrushUnionUv): DabSpan =>
      fileDabSpan(strokeContext, state, cursorPos, canvas, resolvedUnion),
    refusal: (state: State, aim?: { x: number; y: number }): string | null =>
      fileStrokeRefusal(strokeContext, state, aim),
    layDab: (state, aim, canvas, span, options, painted) => {
      if (this.rollbackFailed || !paintDab(strokeContext, canvas, state, aim, span, options, painted)) return false;
      if (this.coarseRef.current?.holdsStroke)
        this.paintCoarse(state, aim, span, false, (dabState, cursor, preview, coarse) =>
          dispatchFileStroke(strokeContext, dabState, cursor, preview, { ...options, ...coarse }),
        );
      return true;
    },
  });
}
