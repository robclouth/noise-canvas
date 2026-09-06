import type { Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { blockOfFrame, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import { BlockSlotCache } from "./block-slot-cache";
import { canvasViewOf, type CanvasView } from "./canvas-view";
import { CANVAS_WINDOW_SPARE_BLOCKS } from "./gpu-budget";

/** Blocks the canvas keeps past the brush before the window moves. */
export const CANVAS_WINDOW_MARGIN_BLOCKS = 1;

/** Milliseconds an aim holds still before the window follows it. */
export const CANVAS_WINDOW_REST_MS = 90;

/**
 * How long the frames the canvas is aimed at have held still. A pointer
 * crossing the file pages every block it passes through the window and serves
 * no dab, so a window that is not painting follows only an aim at rest.
 */
export class AimRest {
  private startFrame = NaN;
  private endFrame = NaN;
  private since = 0;

  /**
   * Milliseconds [startFrame, endFrame) must still hold still before the
   * window may follow it, and 0 once it has. A span different from the last
   * one asked about restarts the wait.
   */
  wait(startFrame: number, endFrame: number, now: number, restMs = CANVAS_WINDOW_REST_MS): number {
    if (startFrame !== this.startFrame || endFrame !== this.endFrame) {
      this.startFrame = startFrame;
      this.endFrame = endFrame;
      this.since = now;
      return restMs;
    }
    return Math.max(0, restMs - (now - this.since));
  }
}

/** A run of blocks, both ends included. */
export type BlockSpan = { firstBlock: number; lastBlock: number };

/** Reads the packed values of file-absolute pixel ranges, compact and in order. */
export type BlockValueReader = (ranges: Uint32Array) => Promise<Float32Array | null>;

/**
 * Reads one block's packed values, compact in block order. The array may be
 * the store's own, changed by a later patch, so a reader takes what it needs
 * at once and keeps no reference.
 */
export type BlockReader = (index: number) => Promise<Float32Array | null>;

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
  private readonly readBlock: BlockReader | null;
  private readonly loading = new Map<number, Promise<boolean>>();
  // Blocks whose slots hold paint the canvas gave them, not the store's values.
  private readonly painted = new Set<number>();
  // Blocks whose content the canvas holds. A fill the next window request
  // abandons leaves its blocks out, so a slide onto them composes them rather
  // than shifting an empty overlap into place.
  private readonly onCanvas = new Set<number>();
  // The blocks of the newest window asked for. A read started for a window
  // that has since been abandoned still lands, and it must not take a slot
  // from these: the canvas composes them, and a block with no slot is a hole.
  private requested: ReadonlySet<number> = new Set<number>();
  private disposed = false;

  constructor(
    gl: WebGLRenderer,
    grid: BlockGrid,
    opts: {
      windowBlocks: number;
      maxBytes?: number;
      readOnly?: boolean;
      read: BlockValueReader;
      /** Serves a whole block without the range read's copy, when the store can. */
      readBlock?: BlockReader;
    },
  ) {
    this.grid = grid;
    this.read = opts.read;
    this.readBlock = opts.readBlock ?? null;
    this.windowBlocks = Math.min(Math.max(1, Math.floor(opts.windowBlocks)), grid.blockCount);
    const slotBytes = blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL;
    // A slide that carries paint holds two windows at once: the one it enters,
    // claimed before the move, and the one it leaves, whose paint is folded
    // back into its slots. A jump the width of the window makes those sets
    // disjoint, so anything smaller evicts a block the slide is about to
    // compose. A window nothing copies back into needs one window's worth.
    const resident = (opts.readOnly ? 1 : 2) * this.windowBlocks;
    const budget = opts.maxBytes ?? (resident + CANVAS_WINDOW_SPARE_BLOCKS) * slotBytes;
    this.cache = new BlockSlotCache(gl, grid, Math.max(budget, resident * slotBytes));
  }

  /** Bytes the slot pages hold. */
  get allocatedBytes(): number {
    return this.cache.allocatedBytes;
  }

  /** Blocks the slots can hold at once. */
  get slotCount(): number {
    return this.cache.slotCount;
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
    this.requested = new Set(this.blocksOf(view));
    const results = await Promise.all(this.missing(view).map((block) => this.loadBlock(block)));
    if (this.disposed) return false;
    return results.every(Boolean) && this.ready(view);
  }

  /** Starts reading the view's missing blocks without waiting for them. */
  prefetch(view: BlockSpan): void {
    this.requested = new Set(this.blocksOf(view));
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

  /**
   * Folds the painted texels of the view's blocks back into their slots,
   * leaving the slots of `keep` alone.
   */
  copyBack(view: CanvasView, blocks: number[], source: Texture, keep?: Iterable<number>): void {
    this.cache.copyBack(view, blocks, source, keep);
    for (const block of blocks) this.painted.add(block);
  }

  /** True while the block's slot still holds paint the canvas gave it. */
  holdsPaint(block: number): boolean {
    return this.painted.has(block);
  }

  /** The view's blocks the canvas holds no content for, in order. */
  canvasLacks(view: BlockSpan): number[] {
    return this.blocksOf(view).filter((block) => !this.onCanvas.has(block));
  }

  /** Records that the canvas took these blocks' content. */
  markOnCanvas(blocks: number[]): void {
    for (const block of blocks) this.onCanvas.add(block);
  }

  /**
   * Records what a slide from `previous` to `next` left on the canvas: a block
   * the canvas already held and kept, or one that entered and was composed. A
   * block of the overlap the canvas never held stays missing, so shifting the
   * empty overlap into place does not pass for content.
   */
  markSlid(next: BlockSpan, previous: BlockSpan): void {
    const kept = this.blocksOf(next).filter(
      (block) => this.onCanvas.has(block) || block < previous.firstBlock || block > previous.lastBlock,
    );
    this.onCanvas.clear();
    this.markOnCanvas(kept);
  }

  /** Forgets what the canvas holds, so every block of its view is composed again. */
  clearCanvas(): void {
    this.onCanvas.clear();
  }

  /** Drops the given blocks (or every block) from their slots. */
  invalidate(blocks?: number[]): void {
    this.cache.invalidate(blocks);
    if (!blocks) this.painted.clear();
    else for (const block of blocks) this.painted.delete(block);
  }

  dispose(): void {
    this.disposed = true;
    this.loading.clear();
    this.painted.clear();
    this.onCanvas.clear();
    this.cache.dispose();
  }

  private loadBlock(block: number): Promise<boolean> {
    const pending = this.loading.get(block);
    if (pending) return pending;
    const load = this.readValues(block)
      .then((values) => {
        if (this.disposed || !values) return false;
        // Read as the value lands, not as the read started: the window asked
        // for may have moved on, and it is the newest one a slot is owed to.
        this.cache.upload(block, values, this.requested);
        this.painted.delete(block);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.loading.delete(block);
      });
    this.loading.set(block, load);
    return load;
  }

  private readValues(block: number): Promise<Float32Array | null> {
    if (this.readBlock) return this.readBlock(block);
    const list = blockPixelRanges(this.grid, block);
    return this.read(list.ranges.slice(0, list.count * 2));
  }
}
