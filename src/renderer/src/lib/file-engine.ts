import { notifications } from "@mantine/notifications";
import type { Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat, RGFormat, Vector2 } from "three";
import { effects } from "../effects";
import type { useTransientStore } from "../store/transient";
import type { OpenFile, SpectrogramData, State } from "../store/types";
import { metadataTextureRows } from "./band-layout";
import { blockGrid } from "./block-grid";
import type { CanvasView } from "./canvas-view";
import { needsCanvasWindow } from "./canvas-window";
import { DEFAULT_ONSET_SENSITIVITY, packedFold, padToFold } from "./constants";
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
  prepareStrokeBatch,
  type FileStrokeContext,
} from "./file-stroke-dispatch";
import type { serializeFileTask } from "./file-task-queue";
import { canvasWindowBlocks } from "./gpu-budget";
import type { deriveSideData, getHistoryManager } from "./history-manager";
import { renderExportImage as renderExportImageToCanvas, type ImageExportOptions } from "./image-export";
import type { PosterInfo } from "./image-export-poster";
import { getOnsetTexture, packOnsetState } from "./onset-map";
import { StrokeRenderer, type SourceFileInfo, type StrokeTextures } from "./stroke-renderer";
import { unitsToUv } from "./utils";
import { WindowedCanvas, type UvRegion } from "./windowed-canvas";

type EngineTextures = { packed: DataTexture; inverse: DataTexture; meta: DataTexture };
type FileEngineOperations = Omit<
  FileRendererHandle,
  "renderStroke" | "clearPreview" | "applyStroke" | "captureSnapshot" | "refreshSnapshot"
>;
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
  scheduleSnapshotRefresh: () => void;
  strokeContext: FileStrokeContext;
}

/** Owns an open file's editable resources and operations. */
export class FileEngine {
  readonly strokeRendererRef: { current: StrokeRenderer | null } = { current: null };
  readonly canvasRef: { current: WindowedCanvas | null } = { current: null };
  readonly historyHookedRef = { current: false };
  readonly currentSeedRef: { current: Float32Array | null } = { current: null };
  readonly packedSeedRef: { current: Float32Array | null } = { current: null };
  readonly inverseSeedRef: { current: Float32Array | null } = { current: null };
  readonly liveTexturesRef: { current: EngineTextures | null } = { current: null };
  readonly isParkedRef: { current: boolean | undefined } = { current: false };
  readonly displayMode: { current: "preview" | "committed" } = { current: "committed" };
  readonly applyStroke = { current: false };
  readonly strokePreview = { current: false };
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
    if (context.spectrogramData.packedData) this.packedSeedRef.current = context.spectrogramData.packedData;
    if (context.spectrogramData.inverseMap) this.inverseSeedRef.current = context.spectrogramData.inverseMap;
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
    const { packedSeedRef, inverseSeedRef, fileId } = this;
    const { getHistoryManager } = this.services;
    const { metadata, texels, numBands } = spectrogramData;

    const grid = blockGrid({ numBands, metadata }, spectrogramData.numFrames, spectrogramData.sampleRate);
    const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));
    const fold = packedFold(texels);
    const texWidth = windowed ? 1 : fold.width;
    const texHeight = windowed ? 1 : fold.height;
    const packedSeed = packedSeedRef.current;
    let packedData = windowed ? new Float32Array(4) : packedSeed && padToFold(packedSeed, texels, 4);
    if (!packedData || packedData.length !== texWidth * texHeight * 4) {
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
  prepareHistorySeeds = async (
    cancelled: () => boolean,
    spectrogramData = this.context.spectrogramData,
  ): Promise<boolean> => {
    const { currentSeedRef, packedSeedRef, inverseSeedRef, fileId } = this;
    const { getHistoryManager, deriveSideData } = this.services;
    const history = getHistoryManager(fileId);
    await history.initialize();
    const manifest = history.getManifest();
    if (!manifest || cancelled()) return false;
    const current = (await history.currentBlockState()) ?? (await history.reconstruct(manifest.currentId)).packedData;
    const original = await history.rootRanges(new Uint32Array([0, spectrogramData.texels]));
    const anchor = history.nearestFullAnchor(manifest.currentId);
    const side = anchor ? await deriveSideData(anchor) : null;
    if (cancelled()) return false;
    currentSeedRef.current = current;
    packedSeedRef.current = original ?? current;
    inverseSeedRef.current = side?.inverseMap ?? null;
    return true;
  };
  prepare = (parked: boolean | undefined): (() => void) | undefined => {
    const {
      strokeRendererRef,
      packedSeedRef,
      createTextures,
      disposeLiveTextures,
      installTextures,
      prepareHistorySeeds,
      disposeCanvas,
      fileId,
    } = this;
    const { spectrogramData } = this.context;
    const { serializeFileTask } = this.services;
    if (parked) return;
    let cancelled = false;
    const prepare = async () => {
      const { numBands, metadata, numFrames, sampleRate } = spectrogramData;
      const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
      if (!packedSeedRef.current && !needsCanvasWindow(grid, canvasWindowBlocks(grid))) {
        const prepared = await serializeFileTask(fileId, () => prepareHistorySeeds(() => cancelled, spectrogramData));
        if (!prepared) return;
      }
      if (!cancelled) installTextures(createTextures(spectrogramData));
    };
    if (strokeRendererRef.current) {
      strokeRendererRef.current.dispose();
      strokeRendererRef.current = null;
    }
    disposeCanvas();
    void prepare().catch((error: unknown) => console.error("Preparing renderer textures failed:", error));

    return () => {
      cancelled = true;

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
        onChanged: () => {
          this.notifyResidencyChanged();
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
  disposeCanvas = (): void => {
    const { canvasRef } = this;
    canvasRef.current?.dispose();
    canvasRef.current = null;
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.listeners.clear();
    this.disposeLiveTextures();
    this.currentSeedRef.current = null;
    this.packedSeedRef.current = null;
    this.inverseSeedRef.current = null;
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
    const {
      historyHookedRef,
      packedSeedRef,
      inverseSeedRef,
      isParkedRef,
      createTextures,
      installTextures,
      prepareHistorySeeds,
      visualChanged,
      fileId,
    } = this;
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
      const specData = file.spectrogramData ?? spectrogramData;
      if (!specData) return;

      const { metadata, numBands, numFrames, sampleRate } = specData;
      const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
      const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));

      if (windowed) {
        packedSeedRef.current = null;
        inverseSeedRef.current = null;
      } else {
        if (!(await prepareHistorySeeds(() => cancelled, spectrogramData))) return;
      }

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
    const {
      strokeRendererRef,
      canvasRef,
      historyHookedRef,
      currentSeedRef,
      packedSeedRef,
      canvasFor,
      releaseAnalysisData,
      fileId,
    } = this;
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
      canvasFor(gl).initialize(packedSeedRef.current, spectrogramData.coarseStrip ?? null);
      if (currentSeedRef.current) {
        strokeRenderer.setFBOData(currentSeedRef.current);
        currentSeedRef.current = null;
      }
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
        if (nodeId === null) {
          if (!openFiles[fileId]?.audioBuffer) await historyManager.restoreCurrentAudio();
          return;
        }
        const gateBefore = openFiles[fileId]?.onsetReference?.odfMax ?? 0;
        await state.synthesizeFile(fileId, undefined, packed);
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
  regionToFileUv = (region: UvRegion | null): UvRegion | null => {
    const { canvasRef } = this;
    return canvasRef.current ? canvasRef.current.regionToFileUv(region) : region;
  };
  afterStateMove = (): void => {
    const { displayMode, applyStroke, visualChanged } = this;
    const { invalidateRef } = this.context;

    applyStroke.current = false;
    displayMode.current = "committed";
    invalidateRef.current();
    visualChanged();
  };
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

    if (canvasRef.current?.setFBOData(data)) afterStateMove();
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
    inverse: DataTexture;
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
      this.packedSeedRef.current = spectrogram.packedData ?? null;
      this.inverseSeedRef.current = spectrogram.inverseMap ?? null;
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
    const { packedSeedRef, inverseSeedRef, liveTexturesRef } = this;
    const { glRef } = this.context;

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
  discardStrokePreview = async (): Promise<boolean> => {
    const { strokeRendererRef, canvasRef, displayMode } = this;
    const { invalidateRef, scheduleSnapshotRefresh } = this.context;

    const canvas = canvasRef.current;
    const restored = canvas ? await canvas.discardStroke() : (strokeRendererRef.current?.restoreRollback() ?? false);
    if (restored) {
      displayMode.current = "committed";
      invalidateRef.current?.();
      scheduleSnapshotRefresh();
    }
    return restored;
  };
  beginStroke = () => {
    const { canvasRef, discardStrokePreview } = this;

    void discardStrokePreview();
    canvasRef.current?.beginStroke();
  };
  endStroke = () => {
    const { canvasRef } = this;
    const { invalidateRef } = this.context;

    canvasRef.current?.endStroke();
    this.notifyContentChanged();
    invalidateRef.current?.();
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
    const { invalidateRef, scheduleSnapshotRefresh, strokeContext } = this.context;
    const { openFiles, getState, getTransientState } = this.services;
    const { paint: dispatchStroke, span: dabSpan, refusal: strokeRefusal } = this.strokeDispatch(strokeContext);
    return {
      renderExportImage: this.renderExportImage,
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
          const state = getState();
          const { cursorPosition, hoveredFile } = getTransientState();
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
  strokeDispatch = (strokeContext: FileStrokeContext) => ({
    paint: (
      state: State,
      cursorPos: Vector2,
      preview: boolean,
      sourceOverride?: SourceFileInfo,
      preparedSpan?: DabSpan,
    ): boolean => dispatchFileStroke(strokeContext, state, cursorPos, preview, sourceOverride, preparedSpan),
    span: (state: State, cursorPos: Vector2, canvas: WindowedCanvas, resolvedUnion?: BrushUnionUv): DabSpan =>
      fileDabSpan(strokeContext, state, cursorPos, canvas, resolvedUnion),
    refusal: (state: State, aim?: { x: number; y: number }): string | null =>
      fileStrokeRefusal(strokeContext, state, aim),
  });
}
