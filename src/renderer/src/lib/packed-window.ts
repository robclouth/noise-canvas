import { Color, FloatType, NearestFilter, RGBAFormat, type Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import type { BlockGrid } from "./block-grid";
import type { CanvasView } from "./canvas-view";
import { type BlockValueReader, CanvasWindow } from "./canvas-window";

/**
 * A read-only window of a file's packed state, as one texture. It pages the
 * blocks in through a block window and composes them into the layout a
 * `CanvasView` names, so a shader addresses it exactly as it addresses a
 * canvas holding that view. Every window of the file lays out in the same
 * texture fold, so moving the window never reallocates.
 */
export class PackedWindow {
  private readonly gl: WebGLRenderer;
  private readonly blocks: CanvasWindow;
  private readonly target: WebGLRenderTarget;
  private held: CanvasView | null = null;
  private request: CanvasView | null = null;
  private disposed = false;

  constructor(
    gl: WebGLRenderer,
    grid: BlockGrid,
    opts: { windowBlocks: number; maxBytes?: number; read: BlockValueReader },
  ) {
    this.gl = gl;
    this.blocks = new CanvasWindow(gl, grid, opts);
    const fold = this.blocks.viewFor({ firstBlock: 0, lastBlock: this.blocks.windowBlocks - 1 });
    this.target = new WebGLRenderTarget(fold.textureWidth, fold.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  /** Bytes the slot pages and the composed texture hold. */
  get allocatedBytes(): number {
    return this.blocks.allocatedBytes + this.target.width * this.target.height * 16;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  /** The view the texture lays out, or null while it lays out nothing. */
  get view(): CanvasView | null {
    return this.held;
  }

  /** True while the texture lays out exactly the blocks of `view`. */
  holds(view: CanvasView): boolean {
    return this.held !== null && this.held.firstBlock === view.firstBlock && this.held.lastBlock === view.lastBlock;
  }

  /**
   * Reads the view's blocks and composes them into the texture. Resolves true
   * when the texture holds the view, false when a read failed or another hold
   * took over.
   */
  async hold(view: CanvasView): Promise<boolean> {
    if (this.holds(view)) return true;
    this.request = view;
    const filled = await this.blocks.acquire(view);
    if (this.disposed || this.request !== view) return false;
    this.request = null;
    if (!filled) return false;
    this.clear();
    this.blocks.compose(view, this.blocks.blocksOf(view), this.target);
    this.held = view;
    return true;
  }

  /** Drops the slots and the composed texture, so the next hold reads again. */
  invalidate(): void {
    this.blocks.invalidate();
    this.held = null;
    this.request = null;
  }

  dispose(): void {
    this.disposed = true;
    this.held = null;
    this.request = null;
    this.blocks.dispose();
    this.target.dispose();
  }

  private clear(): void {
    const oldClearColor = new Color();
    this.gl.getClearColor(oldClearColor);
    const oldClearAlpha = this.gl.getClearAlpha();
    this.gl.setClearColor(0x000000, 0);
    this.gl.setRenderTarget(this.target);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(null);
    this.gl.setClearColor(oldClearColor, oldClearAlpha);
  }
}
