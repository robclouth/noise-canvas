import type { Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { blockOfFrame, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import { BlockSlotCache } from "./block-slot-cache";
import { canvasViewOf, type CanvasView } from "./canvas-view";

const envWindowBlocks = Number(import.meta.env.VITE_CANVAS_WINDOW_BLOCKS);

/**
 * Blocks the painting canvas holds at once. `Infinity` keeps the whole file on
 * the canvas, which is the shape every path outside the block window expects.
 */
export const CANVAS_WINDOW_BLOCKS: number =
  Number.isFinite(envWindowBlocks) && envWindowBlocks >= 1 ? Math.floor(envWindowBlocks) : Infinity;

/** Blocks the canvas keeps past the brush before the window moves. */
export const CANVAS_WINDOW_MARGIN_BLOCKS = 1;

/** Slots kept beyond the window, so a window the brush comes back to is still resident. */
export const CANVAS_WINDOW_SPARE_BLOCKS = 4;

/** A run of blocks, both ends included. */
export type BlockSpan = { firstBlock: number; lastBlock: number };

/** Reads the packed values of file-absolute pixel ranges, compact and in order. */
export type BlockValueReader = (ranges: Uint32Array) => Promise<Float32Array | null>;

/** True when the file has more blocks than the canvas can hold. */
export function needsCanvasWindow(grid: BlockGrid, windowBlocks: number): boolean {
  return grid.blockCount > windowBlocks;
}

/**
 * Where a window of `windowBlocks` blocks sits so that it holds the blocks
 * `firstNeeded` to `lastNeeded`. A `current` window stays put while it holds
 * the need with `margin` blocks to spare on each side the file continues past;
 * otherwise the window centres on the need and clamps to the file.
 */
export function placeCanvasWindow(opts: {
  blockCount: number;
  windowBlocks: number;
  firstNeeded: number;
  lastNeeded: number;
  current?: BlockSpan | null;
  margin?: number;
}): BlockSpan {
  const { blockCount, windowBlocks, current = null, margin = CANVAS_WINDOW_MARGIN_BLOCKS } = opts;
  const size = Math.min(Math.max(1, Math.floor(windowBlocks)), blockCount);
  const first = Math.min(Math.max(0, opts.firstNeeded), blockCount - 1);
  const last = Math.min(Math.max(first, opts.lastNeeded), blockCount - 1);
  if (current && current.lastBlock - current.firstBlock + 1 === size) {
    const leftSpare = current.firstBlock === 0 ? Infinity : first - current.firstBlock;
    const rightSpare = current.lastBlock >= blockCount - 1 ? Infinity : current.lastBlock - last;
    if (leftSpare >= margin && rightSpare >= margin) return current;
  }
  const centred = Math.round((first + last - (size - 1)) / 2);
  const start = Math.min(Math.max(0, centred), blockCount - size);
  return { firstBlock: start, lastBlock: start + size - 1 };
}

/**
 * The view a block span lays out, in the texture fold every window of
 * `windowBlocks` keeps. A window at the end of the file holds fewer texels
 * than a full one, so it lays out inside the same textures and the canvas can
 * slide onto it without reallocating.
 */
export function canvasWindowView(grid: BlockGrid, span: BlockSpan, windowBlocks: number): CanvasView {
  const size = Math.min(Math.max(1, Math.floor(windowBlocks)), grid.blockCount);
  const full = canvasViewOf(grid, 0, size - 1);
  const view = canvasViewOf(grid, span.firstBlock, span.lastBlock);
  return { ...view, textureWidth: full.textureWidth, textureHeight: full.textureHeight };
}

/**
 * The canvas as a window of blocks that follows the brush: it places the
 * window, fills the block slots it needs from the store, and composes them
 * into a view. Every window keeps the texture fold of a full window, so the
 * shorter view at the end of the file lays out inside the same textures and
 * the canvas can slide onto it without reallocating.
 */
export class CanvasWindow {
  readonly grid: BlockGrid;
  readonly windowBlocks: number;
  private readonly cache: BlockSlotCache;
  private readonly read: BlockValueReader;
  private readonly loading = new Map<number, Promise<boolean>>();
  private disposed = false;

  constructor(
    gl: WebGLRenderer,
    grid: BlockGrid,
    opts: { windowBlocks: number; maxBytes?: number; read: BlockValueReader },
  ) {
    this.grid = grid;
    this.read = opts.read;
    this.windowBlocks = Math.min(Math.max(1, Math.floor(opts.windowBlocks)), grid.blockCount);
    const slotBytes = blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL;
    const budget = opts.maxBytes ?? (this.windowBlocks + CANVAS_WINDOW_SPARE_BLOCKS) * slotBytes;
    this.cache = new BlockSlotCache(gl, grid, Math.max(budget, this.windowBlocks * slotBytes));
  }

  /** Bytes the slot pages hold. */
  get allocatedBytes(): number {
    return this.cache.allocatedBytes;
  }

  /** The view a block span lays out, in the fold every window of this file keeps. */
  viewFor(span: BlockSpan): CanvasView {
    return canvasWindowView(this.grid, span, this.windowBlocks);
  }

  /**
   * The view the canvas should hold to paint the frames `[startFrame,
   * endFrame)`. Returns `current` itself while that view still serves, so an
   * unchanged identity means the canvas has nothing to do.
   */
  plan(current: CanvasView | null, startFrame: number, endFrame: number): CanvasView {
    const firstNeeded = blockOfFrame(this.grid, startFrame);
    const lastNeeded = blockOfFrame(this.grid, Math.max(startFrame, endFrame - 1));
    const span = placeCanvasWindow({
      blockCount: this.grid.blockCount,
      windowBlocks: this.windowBlocks,
      firstNeeded,
      lastNeeded,
      current,
    });
    if (current && span.firstBlock === current.firstBlock && span.lastBlock === current.lastBlock) return current;
    return this.viewFor(span);
  }

  /** The blocks a view spans, in order. */
  blocksOf(view: BlockSpan): number[] {
    const blocks: number[] = [];
    for (let block = view.firstBlock; block <= view.lastBlock; block++) blocks.push(block);
    return blocks;
  }

  /** The view's blocks that no slot holds. */
  missing(view: BlockSpan): number[] {
    return this.cache.missing(this.blocksOf(view));
  }

  /** True when every block of the view is in a slot, so the view can be composed. */
  ready(view: BlockSpan): boolean {
    return this.cache.missing(this.blocksOf(view)).length === 0;
  }

  /**
   * Reads the view's missing blocks into slots. Resolves true when the view
   * can be composed; false when a read failed or the window was disposed.
   */
  async acquire(view: BlockSpan): Promise<boolean> {
    const results = await Promise.all(this.missing(view).map((block) => this.loadBlock(block)));
    if (this.disposed) return false;
    return results.every(Boolean) && this.ready(view);
  }

  /** Starts reading the view's missing blocks without waiting for them. */
  prefetch(view: BlockSpan): void {
    for (const block of this.missing(view)) void this.loadBlock(block);
  }

  /** Draws the blocks' committed texels into `target` where `view` places them. */
  compose(view: CanvasView, blocks: number[], target: WebGLRenderTarget): void {
    this.cache.compose(view, blocks, target);
  }

  /**
   * Draws the blocks of `view` that have slots into `target` and returns the
   * ones that had none, which the target is still missing.
   */
  composeResident(view: CanvasView, target: WebGLRenderTarget): number[] {
    const cold = new Set(this.missing(view));
    const resident = this.blocksOf(view).filter((block) => !cold.has(block));
    if (resident.length > 0) this.cache.compose(view, resident, target);
    return [...cold];
  }

  /** Folds the painted texels of the view's blocks back into their slots. */
  copyBack(view: CanvasView, blocks: number[], source: Texture): void {
    this.cache.copyBack(view, blocks, source);
  }

  /** Drops the given blocks (or every block) from their slots. */
  invalidate(blocks?: number[]): void {
    this.cache.invalidate(blocks);
  }

  dispose(): void {
    this.disposed = true;
    this.loading.clear();
    this.cache.dispose();
  }

  private loadBlock(block: number): Promise<boolean> {
    const pending = this.loading.get(block);
    if (pending) return pending;
    const list = blockPixelRanges(this.grid, block);
    const ranges = list.ranges.slice(0, list.count * 2);
    const load = this.read(ranges)
      .then((values) => {
        if (this.disposed || !values) return false;
        this.cache.upload(block, values);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.loading.delete(block);
      });
    this.loading.set(block, load);
    return load;
  }
}
