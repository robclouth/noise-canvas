import {
  AdditiveBlending,
  Color,
  Mesh,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector4,
  type WebGLRenderer,
} from "three";
import type { State } from "../store/types";
import { openFiles } from "../store/files";
import { AimRest } from "./canvas-window";
import {
  bindFileSpectralInputs,
  bindFileTopOverlays,
  createFileDisplayMaterial,
  disposeFileDisplayMaterial,
} from "./file-display-material";
import {
  applyDisplayPyramidUniforms,
  disposeDisplayResidency,
  prepareVisibleRegion,
  visibleFrameRange,
  type FileDisplayResidencyContext,
} from "./file-display-residency";
import type { FileEngine } from "./file-engine";
import type { FileEngineRegistry } from "./file-engine-registry";
import type { FileViewDescriptor } from "./file-renderer-types";
import { getHistoryManager } from "./history-manager";
import { greyscaleTint, layerTint, LONE_LAYER_TINT } from "./layer-tint";
import { perfAdd, perfEnabled } from "./perf-probe";
import { ViewBackdrop } from "./view-backdrop";
import { ViewMotion } from "./view-motion";

export type ViewTransform = Pick<FileViewDescriptor, "viewZoomPower" | "viewOffset" | "viewZoomPowerY" | "viewOffsetY">;
export interface ViewDescriptor {
  topId: string;
  layerIds: readonly string[];
  transform: ViewTransform;
}
export interface ViewLayer {
  engine: FileEngine;
  material: ReturnType<typeof createFileDisplayMaterial>;
  residency: FileDisplayResidencyContext;
  unsubscribe: () => void;
  ready: boolean;
}

/** Reads the selected file's saved viewing transform. */
export function savedViewTransform(state: State, id: string): ViewTransform {
  return {
    viewZoomPower: state.filesZoom[id] ?? 0,
    viewOffset: state.filesOffset[id] ?? 0,
    viewZoomPowerY: state.filesZoomY[id] ?? 0,
    viewOffsetY: state.filesOffsetY[id] ?? 0,
  };
}

/** Owns an ordered direct display while borrowing its file engines. */
export class ViewDisplay {
  readonly motion = new ViewMotion();
  layers: ViewLayer[] = [];
  top: ViewLayer | undefined;
  descriptor: ViewDescriptor;
  width = 1;
  height = 1;
  private pending = new Set<ViewLayer>();
  private signature = "";
  private spectral: unknown[] = [];
  private overlays: unknown[] = [];
  private scene = new Scene();
  private geometry = new PlaneGeometry(2, 2);
  private mesh: Mesh = new Mesh(this.geometry, []);
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private backdrop: ViewBackdrop | null = null;
  private viewport = new Vector4();
  get backdropBytes(): number {
    return this.backdrop?.bytes ?? 0;
  }
  constructor(
    private registry: FileEngineRegistry,
    descriptor: ViewDescriptor,
    private changed: () => void,
  ) {
    this.descriptor = descriptor;
    this.camera.position.z = 1;
    this.scene.add(this.mesh);
  }
  update(descriptor: ViewDescriptor, state: State): void {
    const signature = JSON.stringify(descriptor);
    const membershipChanged = signature !== this.signature;
    this.signature = signature;
    this.descriptor = descriptor;
    const previous = new Map(this.layers.map((layer) => [layer.engine.fileId, layer]));
    const ids = [...descriptor.layerIds.filter((id) => id !== descriptor.topId), descriptor.topId];
    this.layers = ids.flatMap((id) => {
      const engine = this.registry.get(id);
      const spec = openFiles[id]?.spectrogramData;
      if (!engine || !spec) return [];
      let layer = previous.get(id);
      previous.delete(id);
      if (layer && layer.engine !== engine) {
        this.release(layer);
        layer = undefined;
      }
      const presentationChanged = membershipChanged || !layer;
      if (!layer) {
        const material = createFileDisplayMaterial(state);
        const record: ViewLayer = {
          engine,
          material,
          ready: false,
          unsubscribe: () => {},
          residency: {
            transform: descriptor.transform,
            spectrogramData: spec,
            displayMaterial: material,
            glRef: { current: this.registry.gl },
            strokeRendererRef: engine.strokeRendererRef,
            canvasRef: engine.canvasRef,
            coarseRef: engine.coarseRef,
            invalidateRef: { current: () => this.mark(record) },
            ringRequestsRef: { current: new Set() },
            loadingSinceRef: { current: null },
            loadingViewRef: { current: { zoom: 0, offset: 0 } },
            aimRest: { current: new AimRest() },
            aimRestTimer: { current: null },
            currentTaps: (runs) => getHistoryManager(id).currentTaps(runs),
            contentRevision: () => engine.contentRevision,
            isDisposed: () => !this.layers.includes(record),
            residencyChanged: () => engine.notifyResidencyChanged(),
          },
        };
        record.unsubscribe = engine.subscribeVisualChange(() => this.mark(record));
        layer = record;
        this.pending.add(layer);
      }
      layer.residency.transform = descriptor.transform;
      layer.residency.spectrogramData = spec;
      if (presentationChanged) {
        this.backdrop?.invalidate();
        const index = descriptor.layerIds.indexOf(id);
        const colour = descriptor.layerIds.length > 1 ? layerTint(index, descriptor.layerIds.length) : LONE_LAYER_TINT;
        const tint = id === descriptor.topId ? colour : greyscaleTint(colour);
        (layer.material.uniforms.leftTint.value as Color).setRGB(...tint.left);
        (layer.material.uniforms.rightTint.value as Color).setRGB(...tint.right);
        layer.material.uniforms.drawOverlays.value = id === descriptor.topId;
        const blending = descriptor.layerIds.length > 1 ? AdditiveBlending : NormalBlending;
        if (layer.material.blending !== blending) {
          layer.material.blending = blending;
          layer.material.needsUpdate = true;
        }
        layer.material.depthWrite = descriptor.layerIds.length === 1;
        this.pending.add(layer);
      }
      return [layer];
    });
    this.top = this.layers.find((layer) => layer.engine.fileId === descriptor.topId);
    if (membershipChanged) this.backdrop?.invalidate();
    if (this.layers.length <= 2) this.releaseBackdrop();
    for (const layer of previous.values()) this.release(layer);
    this.updateState(state);
    if (membershipChanged || this.pending.size) this.changed();
  }
  updateState(state: State): void {
    const spectral = [state.displayMinDb, state.displayMaxDb, state.filepathsBpm];
    const overlays = [
      state.gridSizeBeats,
      state.gridSizeSemis,
      state.gridSwing,
      state.scaleTonic,
      state.scaleType,
      state.pickingFileParam,
      state.filepathsOnsetSensitivity,
    ];
    if (spectral.some((value, i) => value !== this.spectral[i])) {
      this.backdrop?.invalidate();
      this.spectral = spectral;
      for (const layer of this.layers) this.pending.add(layer);
      this.changed();
    }
    if (overlays.some((value, i) => value !== this.overlays[i])) {
      this.overlays = overlays;
      if (this.top) this.mark(this.top);
    }
  }
  updateTransform(transform: ViewTransform): void {
    const previous = this.descriptor.transform;
    if (
      transform.viewZoomPower === previous.viewZoomPower &&
      transform.viewOffset === previous.viewOffset &&
      transform.viewZoomPowerY === previous.viewZoomPowerY &&
      transform.viewOffsetY === previous.viewOffsetY
    )
      return;
    this.descriptor = { ...this.descriptor, transform };
    this.motion.touch();
    this.backdrop?.invalidate();
    for (const layer of this.layers) {
      layer.residency.transform = transform;
      this.pending.add(layer);
    }
    this.changed();
  }
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.backdrop?.invalidate();
    for (const layer of this.layers) this.pending.add(layer);
    this.changed();
  }
  mark(layer: ViewLayer): void {
    if (layer !== this.top) this.backdrop?.invalidate();
    this.pending.add(layer);
    this.changed();
  }
  bind(layer: ViewLayer, state: State): void {
    const data = layer.engine.borrowDisplaySource();
    if (!data) {
      layer.ready = false;
      return;
    }
    const spec = data.spectrogramData;
    layer.residency.spectrogramData = spec;
    const view: FileViewDescriptor = {
      ...this.descriptor.transform,
      displayMinDb: state.displayMinDb,
      displayMaxDb: state.displayMaxDb,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      gridSwing: state.gridSwing,
      scaleTonic: state.scaleTonic,
      scaleType: state.scaleType,
      bpm: state.filepathsBpm[openFiles[layer.engine.fileId]?.filePath] || 120,
      totalDuration: spec.numFrames / spec.sampleRate,
      viewportWidth: this.width,
      viewportHeight: this.height,
    };
    bindFileSpectralInputs(layer.material, data, view);
    applyDisplayPyramidUniforms(layer.residency, view.viewZoomPower, view.viewOffset, this.width);
    if (layer === this.top) bindFileTopOverlays(layer.material, data, view);
    layer.material.uniforms.sourceSpectrogramTex.value = layer.engine.strokeRendererRef.current?.getDisplayTexture();
    layer.ready = true;
  }
  prepare(state: State): void {
    const work = [...this.pending];
    this.pending.clear();
    for (const layer of work) {
      const start = perfEnabled() ? performance.now() : 0;
      const renderer = layer.engine.initialise(() => visibleFrameRange(layer.residency));
      if (!renderer) {
        layer.ready = false;
        continue;
      }
      if (layer !== this.top) {
        const canvas = layer.engine.canvasFor(this.registry.gl);
        prepareVisibleRegion(layer.residency, canvas, { x: -1 }, 0, 0, false);
      }
      this.bind(layer, state);
      if (perfEnabled() && layer !== this.top) perfAdd("viewBackgroundPrepare", performance.now() - start);
    }
  }
  compose(gl: WebGLRenderer, purpose: "live" | "capture"): void {
    this.render(gl, purpose, true);
  }
  /** Draws each contribution directly, without using the backdrop. */
  composeDirect(gl: WebGLRenderer, purpose: "live" | "capture"): void {
    this.render(gl, purpose, false);
  }
  private render(gl: WebGLRenderer, purpose: "live" | "capture", cached: boolean): void {
    const timed = perfEnabled(),
      start = timed ? performance.now() : 0;
    const autoReset = gl.info.autoReset;
    const autoClear = gl.autoClear;
    gl.info.autoReset = false;
    gl.autoClear = false;
    const calls = gl.info.render.calls;
    try {
      gl.getCurrentViewport(this.viewport);
      if (
        cached &&
        (purpose === "capture" || !this.motion.active) &&
        this.layers.length > 2 &&
        this.viewport.z === this.width &&
        this.viewport.w === this.height
      ) {
        this.backdrop ??= new ViewBackdrop();
        this.backdrop.ensure(gl, this.width, this.height, () => this.drawLayers(gl, "capture", false));
        this.mesh.material = this.backdrop.material;
        gl.render(this.scene, this.camera);
        this.drawLayers(gl, purpose, true);
      } else this.drawLayers(gl, purpose);
    } finally {
      if (timed) {
        perfAdd("viewDisplayDraws", gl.info.render.calls - calls);
        perfAdd("viewDisplayCpu", performance.now() - start);
      }
      gl.info.autoReset = autoReset;
      gl.autoClear = autoClear;
    }
  }
  private drawLayers(gl: WebGLRenderer, purpose: "live" | "capture", topOnly?: boolean): void {
    for (const layer of this.layers) {
      if (topOnly !== undefined && (layer === this.top) !== topOnly) continue;
      if (!layer.ready) continue;
      const u = layer.material.uniforms;
      const previous = [
        u.sourceSpectrogramTex.value,
        u.previewActive.value,
        u.showTargetRectangle.value,
        u.showSourceRectangle.value,
      ];
      if (purpose === "capture" || layer !== this.top) {
        u.sourceSpectrogramTex.value = layer.engine.strokeRendererRef.current?.getDisplayTexture();
        u.previewActive.value = false;
        u.showTargetRectangle.value = false;
        u.showSourceRectangle.value = false;
      }
      this.mesh.material = layer.material;
      try {
        gl.render(this.scene, this.camera);
      } finally {
        [
          u.sourceSpectrogramTex.value,
          u.previewActive.value,
          u.showTargetRectangle.value,
          u.showSourceRectangle.value,
        ] = previous;
      }
    }
  }
  releaseBackdrop(): void {
    this.backdrop?.dispose();
    this.backdrop = null;
  }
  private release(layer: ViewLayer): void {
    layer.unsubscribe();
    this.pending.delete(layer);
    disposeDisplayResidency(layer.residency.aimRestTimer);
    disposeFileDisplayMaterial(layer.material);
  }
  dispose(): void {
    this.motion.dispose();
    this.releaseBackdrop();
    for (const layer of this.layers) this.release(layer);
    this.layers = [];
    this.top = undefined;
    this.geometry.dispose();
  }
}
