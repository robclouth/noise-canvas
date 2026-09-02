import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import type { SpectrogramData } from "../store/types";
import { blockGrid, blockOfFrame, type BlockGrid } from "./block-grid";
import type { CanvasView } from "./canvas-view";
import { needsCanvasWindow, type BlockValueReader } from "./canvas-window";
import { canvasWindowBlocks } from "./gpu-budget";
import { PackedWindow } from "./packed-window";
import { metadataTextureRows } from "./band-layout";

/** What a source window needs to read another file's blocks. */
export type SourceFileBlocks = {
  spectrogram: SpectrogramData;
  /** The file's committed pixels, by file-absolute range. */
  readCurrent: BlockValueReader;
  /** The file's original pixels — what its block store was seeded with. */
  readRoot: BlockValueReader;
  /** Changes whenever the file's committed state moves, so a window re-reads. */
  revision: () => number;
};

/** The textures a brush samples a source window through. */
export type SourceWindowTextures = {
  packed: WebGLRenderTarget;
  metadata: DataTexture;
  /** The span the textures lay out. */
  view: CanvasView;
  /** Present once a step that reads the original has asked for it. */
  original?: Texture;
};

/**
 * The frames a source window should hold to serve a dab that reads
 * [start, end) of the file. The read wraps into the file — the shaders wrap a
 * source UV — and is then widened either side, because effects read around the
 * dab's own span. A read that wraps across the file's end spans both of its
 * edges and no one window holds both; this keeps the end it starts at.
 */
export function sourceReadSpan(
  read: { start: number; end: number },
  numFrames: number,
): { startFrame: number; endFrame: number } {
  const span = Math.max(1, read.end - read.start);
  const start = ((read.start % numFrames) + numFrames) % numFrames;
  return { startFrame: Math.max(0, start - span), endFrame: Math.min(numFrames, start + 2 * span) };
}

/**
 * A window over a file a brush paints FROM.
 *
 * The source file's own canvas holds whatever span its own brush left it on,
 * so a destination reading through it would be served that span and clamped at
 * the edges. This is the destination's own window over the source, placed by
 * the frames the brush reads.
 *
 * The window holds the source file's committed state. Its original is a
 * second window, built the first time a step asks to read it.
 */
export class SourceWindow {
  readonly fileId: string;
  private readonly gl: WebGLRenderer;
  private readonly blocks: SourceFileBlocks;
  private readonly grid: BlockGrid;
  private readonly windowBlocks: number;
  private readonly current: PackedWindow;
  private original: PackedWindow | null = null;
  private metadataTex: DataTexture | null = null;
  private held: CanvasView | null = null;
  private request: CanvasView | null = null;
  private fill: Promise<void> | null = null;
  private disposed = false;

  constructor(gl: WebGLRenderer, fileId: string, blocks: SourceFileBlocks, windowBlocks?: number) {
    const { numBands, metadata, numFrames, sampleRate } = blocks.spectrogram;
    this.gl = gl;
    this.fileId = fileId;
    this.blocks = blocks;
    this.grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
    this.windowBlocks = Math.min(windowBlocks ?? canvasWindowBlocks(this.grid), this.grid.blockCount);
    this.current = new PackedWindow(gl, this.grid, { windowBlocks: this.windowBlocks, read: blocks.readCurrent });
  }

  /** True when a window over the file serves less than all of it. */
  static isNeeded(spectrogram: SpectrogramData, windowBlocks?: number): boolean {
    const { numBands, metadata, numFrames, sampleRate } = spectrogram;
    const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
    return needsCanvasWindow(grid, windowBlocks ?? canvasWindowBlocks(grid));
  }

  /** The span the textures lay out, or null while they lay out nothing. */
  get view(): CanvasView | null {
    return this.held;
  }

  /** Bytes the window's slots and composed textures hold. */
  get allocatedBytes(): number {
    return this.current.allocatedBytes + (this.original?.allocatedBytes ?? 0);
  }

  /** The textures to sample the window through, or null until it holds a span. */
  textures(): SourceWindowTextures | null {
    const view = this.held;
    if (!view || !this.metadataTex) return null;
    const original = this.original?.holds(view) ? this.original.texture : undefined;
    return { packed: this.current.renderTarget, metadata: this.metadataTex, view, original };
  }

  /**
   * True while the textures hold every frame of [startFrame, endFrame), and
   * the original too when `wantOriginal`. A span wider than the window can
   * never fit inside one, so it asks only that the window holds something.
   */
  holdsFrames(startFrame: number, endFrame: number, wantOriginal: boolean): boolean {
    const view = this.held;
    if (!view) return false;
    if (wantOriginal && !(this.original?.holds(view) ?? false)) return false;
    const first = blockOfFrame(this.grid, startFrame);
    const last = blockOfFrame(this.grid, Math.max(startFrame, endFrame - 1));
    if (last - first + 1 > this.windowBlocks) return true;
    return first >= view.firstBlock && last <= view.lastBlock;
  }

  /**
   * Points the window at the frames [startFrame, endFrame). Blocks it lacks
   * are read in the background and taken when they land, so a brush ahead of
   * the reads keeps painting on what the window already holds.
   */
  aim(startFrame: number, endFrame: number, wantOriginal: boolean): void {
    if (this.disposed) return;
    const next = this.current.plan(startFrame, endFrame);
    const original = wantOriginal ? this.originalWindow() : this.original;
    const wanted = wantOriginal ? (original?.holds(next) ?? false) : true;
    if (this.held === next && wanted) return;
    const pending = this.request;
    if (pending && pending.firstBlock === next.firstBlock && pending.lastBlock === next.lastBlock) return;
    this.request = next;
    const reads = Promise.all([
      this.current.hold(next),
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

  /** The read in flight, or null while nothing is being read. */
  settled(): Promise<void> | null {
    return this.fill;
  }

  /** Drops every block, so the next aim reads again. */
  invalidate(): void {
    this.current.invalidate();
    this.original?.invalidate();
    this.held = null;
    this.request = null;
  }

  dispose(): void {
    this.disposed = true;
    this.held = null;
    this.request = null;
    this.current.dispose();
    this.original?.dispose();
    this.metadataTex?.dispose();
    this.metadataTex = null;
  }

  private originalWindow(): PackedWindow {
    if (!this.original) {
      this.original = new PackedWindow(this.gl, this.grid, {
        windowBlocks: this.windowBlocks,
        read: this.blocks.readRoot,
      });
    }
    return this.original;
  }

  /** Takes the view's own band table, which the shaders address the window through. */
  private takeView(view: CanvasView): void {
    this.held = view;
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
}
