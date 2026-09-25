import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { copyMaterial } from "../components/copy-material";
import { metadataTextureRows } from "./band-layout";
import { blockOfFrame, blockPixelRanges, type BlockGrid } from "./block-grid";
import { fileRangesToView, type CanvasView } from "./canvas-view";
import { CanvasWindow, type BlockReader, type BlockValueReader } from "./canvas-window";
import { PackedWindow } from "./packed-window";
import { composePixelRangeValues, intersectPixelRanges, mergePixelRanges, pixelRangeCount } from "./pixel-ranges";
import type { SourceWindowTextures } from "./source-window";
import { scatterIntoTargets } from "./target-scatter";

const copyCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);

/**
 * Which state of the painted file a read far from the brush takes: as the
 * stroke found it, or with the stroke's own paint on it.
 */
export type SelfState = "start" | "live";

/** Values over file pixel ranges, compact in range order. */
export type PaintLayer = { ranges: Uint32Array; values: Float32Array };

/** What a window over the painted file needs from its canvas. */
export type SelfWindowDeps = {
  gl: WebGLRenderer;
  grid: BlockGrid;
  windowBlocks: number;
  read: BlockValueReader;
  readBlock?: BlockReader;
  readRoot: BlockValueReader;
  readRootBlock?: BlockReader;
  /** Changes whenever the store's state moves. */
  revision: () => number;
  /**
   * The paint of strokes the store does not hold yet, oldest first, with a
   * key that changes when it does; null while some of it is still being read.
   */
  pending: () => { key: number; layers: PaintLayer[] } | null;
  /** Changes whenever the stroke on the canvas paints. */
  strokeKey: () => number;
  /** Draws the stroke's paint on `view`'s blocks into `target`, where `view` places them. */
  drawStroke: (view: CanvasView, target: WebGLRenderTarget) => void;
};

/**
 * A window over the file a canvas paints, for a brush that reads it further
 * from the dab than the canvas holds. It pages the store's blocks in as the
 * other-file windows do and lays over them the paint of strokes still
 * committing, which is the file as a stroke finds it; on request, it lays the
 * stroke's own paint over that too, which is the file as the canvas would
 * hold it.
 */
export class SelfWindow {
  private readonly deps: SelfWindowDeps;
  private readonly blocks: CanvasWindow;
  private original: PackedWindow | null = null;
  private readonly start: WebGLRenderTarget;
  private live: WebGLRenderTarget | null = null;
  private metadataTex: DataTexture | null = null;
  private held: CanvasView | null = null;
  private request: CanvasView | null = null;
  private fill: Promise<void> | null = null;
  private revision: number;
  private startKey = "";
  private liveKey = "";
  private disposed = false;
  private readonly copyScene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), copyMaterial));

  constructor(deps: SelfWindowDeps) {
    this.deps = deps;
    this.blocks = new CanvasWindow(deps.gl, deps.grid, {
      windowBlocks: deps.windowBlocks,
      read: deps.read,
      readBlock: deps.readBlock,
    });
    this.start = this.makeTarget();
    this.revision = deps.revision();
  }

  /** Bytes the window's slots and textures hold. */
  get allocatedBytes(): number {
    const targetBytes = this.start.width * this.start.height * 16;
    return this.blocks.allocatedBytes + targetBytes * (this.live ? 2 : 1) + (this.original?.allocatedBytes ?? 0);
  }

  /**
   * Points the window at [startFrame, endFrame). Blocks it lacks are read in
   * the background; the textures serve once they land.
   */
  aim(startFrame: number, endFrame: number, wantOriginal: boolean): void {
    if (this.disposed) return;
    this.followStore();
    const next = this.blocks.plan(this.held, startFrame, endFrame);
    const original = wantOriginal ? this.originalWindow() : this.original;
    const wanted = wantOriginal ? (original?.holds(next) ?? false) : true;
    if (this.held === next && this.blocks.ready(next) && wanted) return;
    const pending = this.request;
    if (pending && pending.firstBlock === next.firstBlock && pending.lastBlock === next.lastBlock) return;
    this.request = next;
    const reads = Promise.all([
      this.blocks.acquire(next),
      wantOriginal && original ? original.hold(next) : Promise.resolve(true),
    ]);
    const filling = reads.then(([filled, originalFilled]) => {
      if (this.disposed || this.request !== next) return;
      this.request = null;
      if (!filled || !originalFilled) return;
      this.takeView(next);
    });
    const tracked = filling.then(() => {
      if (this.fill === tracked) this.fill = null;
    });
    this.fill = tracked;
  }

  /**
   * True while the window holds every frame of [startFrame, endFrame), the
   * original too when `wantOriginal`, and can lay what the store lacks over
   * them. False for a span wider than the window.
   */
  holdsFrames(startFrame: number, endFrame: number, wantOriginal: boolean): boolean {
    this.followStore();
    const view = this.held;
    if (!view || !this.blocks.ready(view) || !this.deps.pending()) return false;
    if (wantOriginal && !(this.original?.holds(view) ?? false)) return false;
    const first = blockOfFrame(this.deps.grid, startFrame);
    const last = blockOfFrame(this.deps.grid, Math.max(startFrame, endFrame - 1));
    return first >= view.firstBlock && last <= view.lastBlock;
  }

  /** The textures to sample the file through in `state`, or null until the window can serve. */
  textures(state: SelfState): SourceWindowTextures | null {
    this.followStore();
    const view = this.held;
    const pending = this.deps.pending();
    if (!view || !this.metadataTex || !pending || !this.blocks.ready(view)) return null;
    const startKey = `${this.revision}:${pending.key}:${view.firstBlock}:${view.lastBlock}`;
    if (this.startKey !== startKey) {
      this.composeStart(view, this.start, pending.layers);
      this.startKey = startKey;
    }
    let packed = this.start;
    if (state === "live") {
      const live = (this.live ??= this.makeTarget());
      const liveKey = `${startKey}:${this.deps.strokeKey()}`;
      if (this.liveKey !== liveKey) {
        this.copyStart(live);
        this.deps.drawStroke(view, live);
        this.liveKey = liveKey;
      }
      packed = live;
    }
    const original = this.original?.holds(view) ? this.original.texture : undefined;
    return { packed, metadata: this.metadataTex, view, original };
  }

  /** The read in flight, or null while nothing is being read. */
  settled(): Promise<void> | null {
    return this.fill;
  }

  dispose(): void {
    this.disposed = true;
    this.held = null;
    this.request = null;
    this.blocks.dispose();
    this.original?.dispose();
    this.start.dispose();
    this.live?.dispose();
    for (const child of this.copyScene.children) if (child instanceof Mesh) child.geometry.dispose();
    this.metadataTex?.dispose();
    this.metadataTex = null;
  }

  /** Forgets every block once the store has moved, so the next aim reads it again. */
  private followStore(): void {
    const revision = this.deps.revision();
    if (revision === this.revision) return;
    this.revision = revision;
    this.blocks.storeMoved();
    this.blocks.invalidate();
    this.original?.invalidate();
    this.held = null;
    this.request = null;
    this.startKey = "";
    this.liveKey = "";
  }

  /** Composes the store's blocks into `target` and lays the uncommitted paint over them. */
  private composeStart(view: CanvasView, target: WebGLRenderTarget, layers: readonly PaintLayer[]): void {
    this.clear(target);
    this.blocks.compose(view, this.blocks.blocksOf(view), target);
    if (layers.length === 0) return;
    let within: Uint32Array = new Uint32Array(0);
    for (let block = view.firstBlock; block <= view.lastBlock; block++) {
      const list = blockPixelRanges(this.deps.grid, block);
      within = mergePixelRanges(within, list.ranges.subarray(0, list.count * 2));
    }
    for (const layer of layers) {
      const ranges = intersectPixelRanges(layer.ranges, within);
      if (pixelRangeCount(ranges) === 0) continue;
      const viewRanges = fileRangesToView(view, this.deps.grid.layout, ranges);
      if (!viewRanges) continue;
      scatterIntoTargets(this.deps.gl, composePixelRangeValues(ranges, [layer]), viewRanges, [target]);
    }
  }

  private takeView(view: CanvasView): void {
    this.held = view;
    this.startKey = "";
    this.liveKey = "";
    this.metadataTex?.dispose();
    const metadata = new DataTexture(metadataTextureRows(view.layout), view.layout.numBands, 1, RGBAFormat, FloatType);
    metadata.internalFormat = "RGBA32F";
    metadata.minFilter = NearestFilter;
    metadata.magFilter = NearestFilter;
    metadata.wrapS = ClampToEdgeWrapping;
    metadata.wrapT = ClampToEdgeWrapping;
    metadata.generateMipmaps = false;
    metadata.needsUpdate = true;
    this.metadataTex = metadata;
  }

  private originalWindow(): PackedWindow {
    if (!this.original) {
      this.original = new PackedWindow(this.deps.gl, this.deps.grid, {
        windowBlocks: this.deps.windowBlocks,
        read: this.deps.readRoot,
        readBlock: this.deps.readRootBlock,
      });
    }
    return this.original;
  }

  /** Copies the start texture into `target`, texel for texel. */
  private copyStart(target: WebGLRenderTarget): void {
    const { gl } = this.deps;
    copyMaterial.uniforms.inputTex.value = this.start.texture;
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    gl.render(this.copyScene, copyCamera);
    gl.setRenderTarget(previous);
    copyMaterial.uniforms.inputTex.value = null;
  }

  private makeTarget(): WebGLRenderTarget {
    const fold = this.blocks.viewFor({ firstBlock: 0, lastBlock: this.blocks.windowBlocks - 1 });
    return new WebGLRenderTarget(fold.textureWidth, fold.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  private clear(target: WebGLRenderTarget): void {
    const { gl } = this.deps;
    const oldClearColor = new Color();
    gl.getClearColor(oldClearColor);
    const oldClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(target);
    gl.clear(true, false, false);
    gl.setRenderTarget(null);
    gl.setClearColor(oldClearColor, oldClearAlpha);
  }
}
