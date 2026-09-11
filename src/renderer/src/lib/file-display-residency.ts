import type { RawShaderMaterial, WebGLRenderer } from "three";
import type { State, SpectrogramData } from "../store/types";
import type { AimRest } from "./canvas-window";
import { displayLevelChoice } from "./display-pyramid";
import type { DisplayTileRing } from "./display-tiles-textures";
import type { StrokeRenderer } from "./stroke-renderer";
import type { WindowedCanvas } from "./windowed-canvas";

export interface FileDisplayResidencyContext {
  viewFileId: string;
  spectrogramData: SpectrogramData;
  displayMaterial: RawShaderMaterial;
  glRef: { current: WebGLRenderer };
  strokeRendererRef: { current: StrokeRenderer | null };
  canvasRef: { current: WindowedCanvas | null };
  invalidateRef: { current: () => void };
  ringRequestsRef: { current: Set<string> };
  loadingSinceRef: { current: number | null };
  loadingViewRef: { current: { zoom: number; offset: number } };
  aimRest: { current: AimRest };
  aimRestTimer: { current: ReturnType<typeof setTimeout> | null };
  getState: () => State;
  currentTaps: (runs: Uint32Array) => Promise<Float32Array | null>;
}

const DISPLAY_LOADING_GRACE_MS = 120;
const DISPLAY_LOADING_FADE_MS = 160;

function applyDisplayTileUniforms(
  context: FileDisplayResidencyContext,
  pyramidStepLog2: number,
  framesPerPixel: number,
  viewZoomPower: number,
  viewOffset: number,
  viewportWidth: number,
): boolean {
  const { displayMaterial, glRef, strokeRendererRef, spectrogramData, canvasRef } = context;
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
  if (canvasCoversFile(context)) {
    tiles.update(gl, strokeRenderer.committedSource(), ringView, pyramidStepLog2);
  } else if (
    canvasRef.current?.holdsFrames(ringView.startFrame, ringView.endFrame) ||
    canvasRef.current?.isFillingFrames(ringView.startFrame, ringView.endFrame)
  ) {
    tiles.release();
    lacking = true;
  } else {
    const missing = tiles.aim(ringView, pyramidStepLog2);
    requestRingTiles(context, tiles, missing);
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
}

function requestRingTiles(context: FileDisplayResidencyContext, tiles: DisplayTileRing, missing: number[]): void {
  const { ringRequestsRef, canvasRef, glRef, strokeRendererRef, invalidateRef } = context;
  if (missing.length === 0) return;
  const level = tiles.gridLevel();
  for (const tile of missing) {
    const key = `${level}:${tile}`;
    if (ringRequestsRef.current.has(key)) continue;
    ringRequestsRef.current.add(key);
    const runs = tiles.tileTapRuns(tile);
    const read = canvasRef.current ? canvasRef.current.readCommittedTaps(runs) : context.currentTaps(runs);
    void read
      .then((values) => {
        ringRequestsRef.current.delete(key);
        const gl = glRef.current;
        const live = strokeRendererRef.current?.getDisplayTiles();
        if (!values || !gl || live !== tiles) return;
        if (tiles.gridLevel() !== level || !tiles.canCutTile(tile)) return;
        tiles.cutTileFromTaps(gl, tile, values);
        if (canvasRef.current?.isStroking && tiles.uniforms().tileCount > 0) {
          strokeRendererRef.current?.refreshDisplayFromStroke();
        }
        invalidateRef.current();
      })
      .catch(() => ringRequestsRef.current.delete(key));
  }
}

export function applyDisplayPyramidUniforms(
  context: FileDisplayResidencyContext,
  viewZoomPower: number,
  viewOffset: number,
  viewportWidth: number,
): void {
  const {
    displayMaterial,
    strokeRendererRef,
    loadingSinceRef,
    spectrogramData,
    canvasRef,
    loadingViewRef,
    invalidateRef,
  } = context;
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
    context,
    finestStepLog2,
    framesPerPixel,
    viewZoomPower,
    viewOffset,
    viewportWidth,
  );
  const finerThanPyramid = 2 ** finestStepLog2 > Math.max(framesPerPixel, 1);
  const canvas = canvasRef.current;
  const visible = visibleFrameRange(context, context.getState());
  const visibleRangeCovered = canvas?.holdsFrames(visible.start, visible.end) ?? true;
  uniforms.displayCanvasFirst.value = finerThanPyramid && (canvas?.isPopulated() ?? true);
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
  const levelsLoading = !finerThanPyramid && displayLevelChoice(pyramid.levels, framesPerPixel).fine < ready;
  uniforms.displayFinerWanted.value = finerThanPyramid;
  uniforms.displayLoadingAll.value = levelsLoading;
  const lacking = levelsLoading || (finerThanPyramid && !visibleRangeCovered && ringLacks);
  if (!lacking) {
    loadingSinceRef.current = null;
    uniforms.displayLoading.value = 0;
    return;
  }
  const now = performance.now();
  const viewMoved = loadingViewRef.current.zoom !== viewZoomPower || loadingViewRef.current.offset !== viewOffset;
  if (viewMoved) loadingViewRef.current = { zoom: viewZoomPower, offset: viewOffset };
  if (loadingSinceRef.current === null || viewMoved) loadingSinceRef.current = now;
  const fade = (now - loadingSinceRef.current - DISPLAY_LOADING_GRACE_MS) / DISPLAY_LOADING_FADE_MS;
  uniforms.displayLoading.value = Math.min(1, Math.max(0, fade));
  if (fade < 1) invalidateRef.current?.();
}

export function visibleFrameRange(
  context: Pick<FileDisplayResidencyContext, "spectrogramData" | "viewFileId">,
  state: State,
): { start: number; end: number } {
  const { spectrogramData, viewFileId } = context;
  const { numFrames } = spectrogramData;
  const zoom = Math.pow(2, state.filesZoom[viewFileId] ?? 0);
  const span = numFrames / zoom;
  const start = zoom > 1 ? (state.filesOffset[viewFileId] ?? 0) * (numFrames - span) : 0;
  return { start, end: start + span };
}

function canvasCoversFile(context: FileDisplayResidencyContext): boolean {
  return context.canvasRef.current?.coversFile() ?? true;
}

function scheduleAimRest(context: FileDisplayResidencyContext, wait: number): void {
  const { aimRestTimer, invalidateRef } = context;
  if (aimRestTimer.current !== null) clearTimeout(aimRestTimer.current);
  aimRestTimer.current = setTimeout(() => {
    aimRestTimer.current = null;
    invalidateRef.current?.();
  }, wait);
}

export function prepareVisibleRegion(
  context: FileDisplayResidencyContext,
  canvas: WindowedCanvas,
  state: State,
  cursorPos: { x: number },
  dabStart: number,
  dabEnd: number,
  original: boolean,
): void {
  const { aimRest } = context;
  if (!canvas.wholeFile) {
    const visible = visibleFrameRange(context, state);
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
    const wait = canvas.isStroking ? 0 : aimRest.current.wait(start, end, performance.now());
    if (wait === 0) canvas.aim(start, end, original);
    else scheduleAimRest(context, wait);
  }
}

export function disposeDisplayResidency(aimRestTimer: FileDisplayResidencyContext["aimRestTimer"]): void {
  if (aimRestTimer.current !== null) clearTimeout(aimRestTimer.current);
}
