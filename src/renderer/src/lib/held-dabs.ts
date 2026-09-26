import { blockOfFrame, coarsestBinFrames, frameRangeOfBlock, type BlockGrid } from "./block-grid";

/** A span of file frames, [start, end). */
export type FrameSpan = { start: number; end: number };

/**
 * What one dab paints and reads, in file frames: the spans it writes (two
 * when it wraps past the end of the file), how far past them it reads, and
 * whether it reads the canvas as the dabs before it left it rather than as
 * the stroke found it. `piece` is how far from each frame it writes it reads,
 * which a piece of the dab must hold around it; null when the dab can only be
 * painted whole.
 */
export type DabExtent = {
  writes: readonly FrameSpan[];
  before: number;
  after: number;
  readsLive: boolean;
  piece: { before: number; after: number } | null;
};

/**
 * Paints a dab, whole with a null clip or over the file frames of `clip`
 * only. Returns false when it could not paint yet, and is asked again.
 */
export type DabPainter = (clip: FrameSpan | null) => boolean;

type HeldDab<T> = {
  extent: DabExtent;
  blocks: number[];
  total: number;
  payload: T;
  paint: DabPainter;
  byBlock: boolean;
  holdsBack: boolean;
};

/**
 * How a held dab paints: `byBlock` paints each block on its own rather than
 * in a run with its ready neighbours, so what a piece reads elsewhere stays
 * one block's worth; `holdsBack` keeps every later dab waiting until it has
 * painted all of it.
 */
export type HoldOptions = { byBlock?: boolean; holdsBack?: boolean };

/** The blocks a dab writes, in order and without repeats. */
export function blocksOfDab(grid: BlockGrid, extent: DabExtent): number[] {
  const blocks = new Set<number>();
  for (const span of extent.writes) {
    const start = Math.max(0, span.start);
    const end = Math.min(grid.numFrames, span.end);
    if (end <= start) continue;
    for (let block = blockOfFrame(grid, start); block <= blockOfFrame(grid, end - 1); block++) blocks.add(block);
  }
  return [...blocks].sort((a, b) => a - b);
}

/** The file frames a dab writes in one block; empty at the block's start when it writes none there. */
export function blockWriteSpan(grid: BlockGrid, extent: DabExtent, block: number): FrameSpan {
  const frames = frameRangeOfBlock(grid, block);
  let start = frames.end;
  let end = frames.start;
  for (const span of extent.writes) {
    if (span.end <= frames.start || span.start >= frames.end) continue;
    start = Math.min(start, Math.max(frames.start, span.start));
    end = Math.max(end, Math.min(frames.end, span.end));
  }
  return end <= start ? { start: frames.start, end: frames.start } : { start, end };
}

/**
 * The file frames a dab reads while it writes its part of one block: what it
 * reads around that part, and one bin of the coarsest band past each block
 * edge the dab continues across, because a pixel next to a cut interpolates
 * over it. A dab that can only be painted whole reads all it reads for every
 * block.
 */
export function blockReadSpan(grid: BlockGrid, extent: DabExtent, block: number): FrameSpan {
  const { start, end } = blockWriteSpan(grid, extent, block);
  if (end <= start) return { start, end };
  const { piece } = extent;
  if (!piece) {
    let first = Infinity;
    let last = -Infinity;
    for (const span of extent.writes) {
      first = Math.min(first, span.start);
      last = Math.max(last, span.end);
    }
    return { start: Math.max(0, first - extent.before), end: Math.min(grid.numFrames, last + extent.after) };
  }
  const frames = frameRangeOfBlock(grid, block);
  const margin = coarsestBinFrames(grid);
  const continues = (edge: number): boolean => extent.writes.some((span) => span.start < edge && span.end > edge);
  return {
    start: Math.max(
      0,
      start - Math.max(extent.before, piece.before) - (start === frames.start && continues(start) ? margin : 0),
    ),
    end: Math.min(
      grid.numFrames,
      end + Math.max(extent.after, piece.after) + (end === frames.end && continues(end) ? margin : 0),
    ),
  };
}

/**
 * Dabs waiting for the canvas to hold what they paint, painted a block at a
 * time. A block of a dab waits only for the dabs before it that still have
 * that block to paint, or that read the canvas as the dabs before them left
 * it and still have that block to read; and, when it reads the canvas that
 * way itself, for those with a block within its reach. Everything else may go
 * ahead. So the canvas paints whatever it holds at once, however far behind
 * an older dab waits, and every pixel still takes its dabs in the order they
 * came. A dab held with `holdsBack` is the exception: nothing after it paints
 * before it has.
 */
export class HeldDabs<T> {
  private readonly grid: BlockGrid;
  private queue: HeldDab<T>[] = [];

  constructor(grid: BlockGrid) {
    this.grid = grid;
  }

  /** Dabs waiting. */
  get size(): number {
    return this.queue.length;
  }

  /** The payload of the dab held longest, or null when none is held. */
  oldest(): T | null {
    return this.queue[0]?.payload ?? null;
  }

  /** Blocks still to paint, over every dab. */
  get pieces(): number {
    let count = 0;
    for (const dab of this.queue) count += dab.blocks.length;
    return count;
  }

  /** Holds a dab. */
  push(extent: DabExtent, payload: T, paint: DabPainter, options: HoldOptions = {}): void {
    const blocks = blocksOfDab(this.grid, extent);
    if (blocks.length === 0) return;
    const { byBlock = false, holdsBack = false } = options;
    this.queue.push({ extent, blocks, total: blocks.length, payload, paint, byBlock, holdsBack });
  }

  clear(): void {
    this.queue = [];
  }

  /**
   * Paints every block `holds` says the canvas can take for its dab and that
   * no older dab still waits on, a run of neighbouring blocks at a time.
   */
  release(holds: (extent: DabExtent, payload: T, block: number) => boolean): void {
    const blockFrames = this.grid.blockFrames;
    const older = new Set<number>();
    const olderReads = new Set<number>();
    for (const dab of this.queue) {
      const { extent } = dab;
      const reachBefore = Math.ceil(extent.before / blockFrames);
      const reachAfter = Math.ceil(extent.after / blockFrames);
      const waitsOn = (block: number): boolean => {
        if (older.has(block) || olderReads.has(block)) return true;
        if (!extent.readsLive) return false;
        for (let near = block - reachBefore; near <= block + reachAfter; near++) if (older.has(near)) return true;
        return false;
      };
      const runnable = dab.blocks.filter((block) => !waitsOn(block) && holds(extent, dab.payload, block));
      if (runnable.length > 0) {
        const whole = !dab.byBlock && runnable.length === dab.total && extent.writes.length === 1;
        const done = new Set<number>();
        for (const run of dab.byBlock ? runnable.map((block) => [block]) : contiguousRuns(runnable)) {
          const clip = whole
            ? null
            : {
                start: frameRangeOfBlock(this.grid, run[0]).start,
                end: frameRangeOfBlock(this.grid, run[run.length - 1]).end,
              };
          // A run that did not paint waits for the next release.
          if (dab.paint(clip)) for (const block of run) done.add(block);
        }
        dab.blocks = dab.blocks.filter((block) => !done.has(block));
      }
      if (dab.holdsBack && dab.blocks.length > 0) break;
      for (const block of dab.blocks) {
        older.add(block);
        if (!extent.readsLive) continue;
        const read = blockReadSpan(this.grid, extent, block);
        if (read.end <= read.start) continue;
        for (let near = blockOfFrame(this.grid, read.start); near <= blockOfFrame(this.grid, read.end - 1); near++)
          olderReads.add(near);
      }
    }
    this.queue = this.queue.filter((dab) => dab.blocks.length > 0);
  }

  /**
   * The frames the canvas should hold next: what the oldest waiting block
   * reads, widened over the blocks after it, in the order they wait, while
   * `fits` says one window still holds them all; the payloads of the dabs
   * they belong to; and the frames the oldest waiting block writes. Null when
   * nothing waits.
   */
  target(fits: (start: number, end: number) => boolean): { span: FrameSpan; payloads: T[]; part: FrameSpan } | null {
    let span: FrameSpan | null = null;
    const payloads: T[] = [];
    const oldest = this.queue[0];
    if (!oldest) return null;
    const part = blockWriteSpan(this.grid, oldest.extent, oldest.blocks[0]);
    for (const dab of this.queue) {
      for (const [index, block] of dab.blocks.entries()) {
        const read = blockReadSpan(this.grid, dab.extent, block);
        const next: FrameSpan = span
          ? { start: Math.min(span.start, read.start), end: Math.max(span.end, read.end) }
          : read;
        if (span && !fits(next.start, next.end)) return { span, payloads, part };
        span = next;
        if (index === 0) payloads.push(dab.payload);
      }
      if (dab.holdsBack) break;
    }
    return span ? { span, payloads, part } : null;
  }
}

/** Ascending blocks split into runs of neighbours. */
function contiguousRuns(blocks: number[]): number[][] {
  const runs: number[][] = [];
  for (const block of blocks) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === block - 1) run.push(block);
    else runs.push([block]);
  }
  return runs;
}
