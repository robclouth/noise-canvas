import type { Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { blockPixelRanges, blocksForPixelRanges, blockTexels, type BlockGrid } from "./block-grid";
import { BlockSlotCache, MASK_SLOT_TEXEL, PACKED_SLOT_TEXEL } from "./block-slot-cache";
import type { CanvasView } from "./canvas-view";
import type { CarriedRead, PaintBox } from "./carried-paint";
import { intersectPixelRanges, mergePixelRanges } from "./pixel-ranges";

const NO_RANGES = new Uint32Array(0);

/** One weight a pixel out of a read that gives four floats a pixel. */
function firstOfFour(rgba: Float32Array): Float32Array {
  const weights = new Float32Array(rgba.length >> 2);
  for (let i = 0; i < weights.length; i++) weights[i] = rgba[i * 4];
  return weights;
}

/**
 * A stroke's paint on blocks that left the canvas window, kept on the GPU:
 * each block as the canvas last held it, and each brush step's mask over it,
 * with the file pixels the stroke painted there. A block that comes back is
 * drawn from here, so the stroke carries on where it left it, and the pen-up
 * read gathers the paint from here in one go.
 */
export class StrokeSlots {
  private readonly gl: WebGLRenderer;
  private readonly grid: BlockGrid;
  private readonly capacity: number;
  private readonly paint: BlockSlotCache;
  private readonly masks: (BlockSlotCache | null)[] = [];
  // Held blocks in the order they were kept, with the pixels painted on each.
  private readonly held = new Map<number, Uint32Array>();
  private box: PaintBox | null = null;

  constructor(gl: WebGLRenderer, grid: BlockGrid, blocks: number) {
    this.gl = gl;
    this.grid = grid;
    this.capacity = Math.max(1, Math.min(blocks, grid.blockCount));
    this.paint = new BlockSlotCache(
      gl,
      grid,
      this.capacity * blockTexels(grid, 0) * PACKED_SLOT_TEXEL.bytes,
      undefined,
      PACKED_SLOT_TEXEL,
    );
  }

  /** Blocks it can hold at once. */
  get slotCount(): number {
    return this.paint.slotCount;
  }

  /** Blocks it holds. */
  get size(): number {
    return this.held.size;
  }

  /** True while it holds the block. */
  holds(block: number): boolean {
    return this.held.has(block);
  }

  /** The painted file pixels of every block it holds, as one ascending range list. */
  ranges(): Uint32Array {
    let all: Uint32Array = NO_RANGES;
    for (const ranges of this.held.values()) all = mergePixelRanges(all, ranges);
    return all;
  }

  /** The unpacked-UV box its paint covers, or null when it holds nothing. */
  paintBox(): PaintBox | null {
    return this.box;
  }

  /** Widens the box its paint covers. */
  addBox(box: PaintBox): void {
    this.box = this.box
      ? {
          timeMin: Math.min(this.box.timeMin, box.timeMin),
          timeMax: Math.max(this.box.timeMax, box.timeMax),
          pitchMin: Math.min(this.box.pitchMin, box.pitchMin),
          pitchMax: Math.max(this.box.pitchMax, box.pitchMax),
        }
      : { ...box };
  }

  /** The held blocks to let go, oldest first, so `count` more fit. */
  oldest(count: number): number[] {
    const over = count - this.paint.freeSlots;
    return over > 0 ? [...this.held.keys()].slice(0, over) : [];
  }

  /**
   * Keeps the blocks as `canvas` and the step masks hold them, where `view`
   * places them, each with the file pixels the stroke painted on it. There
   * must be room for all of them: `oldest` names what to let go first.
   */
  keep(
    view: CanvasView,
    entries: readonly { block: number; ranges: Uint32Array }[],
    canvas: Texture,
    masks: readonly (Texture | null)[],
  ): void {
    const blocks = entries.map((entry) => entry.block);
    this.paint.take(view, blocks, canvas);
    for (let step = 0; step < masks.length; step++) {
      const mask = masks[step];
      if (mask) this.maskCache(step).take(view, blocks, mask);
    }
    for (const { block, ranges } of entries) {
      this.held.delete(block);
      this.held.set(block, ranges);
    }
  }

  /**
   * Issues the reads of a held block's paint and masks over the pixels the
   * stroke painted there, and lets the block go.
   */
  letGo(block: number): { ranges: Uint32Array; read: Promise<CarriedRead> } {
    const ranges = this.held.get(block);
    if (!ranges) throw new Error("the block is not held");
    const values = this.paint.read(ranges);
    const masks = Promise.all(
      this.masks.map((cache) => (cache?.has(block) ? cache.read(ranges).then(firstOfFour) : null)),
    );
    this.forget([block]);
    return { ranges, read: Promise.all([values, masks]).then(([read, weights]) => ({ values: read, masks: weights })) };
  }

  /**
   * Draws the painted pixels of the held blocks among `blocks` where `view`
   * places them: onto the canvas through `canvas`, given the file pixels it
   * changes, and each step's weights onto its mask through `mask`. Lets
   * those blocks go and returns them.
   */
  restore(
    view: CanvasView,
    blocks: readonly number[],
    canvas: (ranges: Uint32Array, draw: (target: WebGLRenderTarget) => void) => void,
    mask: (step: number, draw: (target: WebGLRenderTarget) => void) => void,
  ): number[] {
    const back = blocks.filter((block) => this.held.has(block));
    if (back.length === 0) return back;
    let ranges: Uint32Array = NO_RANGES;
    for (const block of back) ranges = mergePixelRanges(ranges, this.held.get(block)!);
    canvas(ranges, (target) => this.paint.composeRanges(view, ranges, target));
    for (let step = 0; step < this.masks.length; step++) {
      const cache = this.masks[step];
      if (!cache) continue;
      let masked: Uint32Array = NO_RANGES;
      for (const block of back) {
        if (cache.has(block)) masked = mergePixelRanges(masked, this.held.get(block)!);
      }
      if (masked.length > 0) mask(step, (target) => cache.composeRanges(view, masked, target));
    }
    this.forget(back);
    return back;
  }

  /**
   * Reads the named file pixels, which must all lie on held blocks, four
   * floats a pixel in range order. The copy is issued at the call.
   */
  read(fileRanges: Uint32Array): Promise<Float32Array> {
    return this.paint.read(fileRanges);
  }

  /**
   * Each brush step's mask weights over the named file pixels, which must all
   * lie on held blocks, one weight a pixel in range order; null for a step
   * that kept no mask on some of those blocks.
   */
  readMasks(fileRanges: Uint32Array): Promise<(Float32Array | null)[]> {
    const blocks = blocksForPixelRanges(this.grid, fileRanges);
    return Promise.all(
      this.masks.map((cache) =>
        cache && blocks.every((block) => cache.has(block)) ? cache.read(fileRanges).then(firstOfFour) : null,
      ),
    );
  }

  /** The held pixels among `fileRanges`. */
  within(fileRanges: Uint32Array): Uint32Array {
    return this.held.size === 0 ? NO_RANGES : intersectPixelRanges(this.ranges(), fileRanges);
  }

  /** The held blocks among `blocks`. */
  heldAmong(blocks: Iterable<number>): number[] {
    const held: number[] = [];
    for (const block of blocks) if (this.held.has(block)) held.push(block);
    return held;
  }

  /** The cache the held blocks' paint lives in, for copying from. */
  get paintCache(): BlockSlotCache {
    return this.paint;
  }

  /** Lets every block go. */
  clear(): void {
    this.forget([...this.held.keys()]);
  }

  dispose(): void {
    this.held.clear();
    this.box = null;
    this.paint.dispose();
    for (const cache of this.masks) cache?.dispose();
    this.masks.length = 0;
  }

  private maskCache(step: number): BlockSlotCache {
    while (this.masks.length <= step) this.masks.push(null);
    let cache = this.masks[step];
    if (!cache) {
      cache = new BlockSlotCache(
        this.gl,
        this.grid,
        this.capacity * blockTexels(this.grid, 0) * MASK_SLOT_TEXEL.bytes,
        undefined,
        MASK_SLOT_TEXEL,
      );
      this.masks[step] = cache;
    }
    return cache;
  }

  private forget(blocks: number[]): void {
    this.paint.invalidate(blocks);
    for (const cache of this.masks) cache?.invalidate(blocks);
    for (const block of blocks) this.held.delete(block);
    if (this.held.size === 0) this.box = null;
  }
}

/** The file pixels of `painted` that fall in `block`. */
export function paintOnBlock(grid: BlockGrid, block: number, painted: Uint32Array): Uint32Array {
  const list = blockPixelRanges(grid, block);
  return intersectPixelRanges(painted, list.ranges.subarray(0, list.count * 2));
}
