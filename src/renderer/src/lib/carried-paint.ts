import type { Texture } from "three";

import { blockPixelRanges, type BlockGrid } from "./block-grid";
import { viewRangesLeaving, viewRangesToFile, viewUvToFileUv, type CanvasView } from "./canvas-view";
import { intersectPixelRanges, mergePixelRanges, pixelRangeCount, subtractPixelRanges } from "./pixel-ranges";

/** The unpacked-UV box of a painted region. */
export type PaintBox = { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number };

/** One carry: the file ranges it was booked with, the pixels of them still carried, and their values in booking order. */
type Carry = { ranges: Uint32Array; live: Uint32Array; values: Float32Array };

const NO_RANGES = new Uint32Array(0);

/**
 * Texels a stroke painted on blocks that then left the canvas window, held by
 * file range until the stroke commits. Each carry books its ranges straight
 * away and fills them when the read lands, so a commit that starts before the
 * reads finish still knows which pixels it must wait for. A range booked again
 * leaves the earlier carry of it, so a read that lands out of order cannot
 * overwrite a later carry.
 */
export class CarriedPaint {
  private carries: Carry[] = [];
  private reads: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private box: PaintBox | null = null;

  /** Pixels carried. */
  get size(): number {
    let count = 0;
    for (const carry of this.carries) count += pixelRangeCount(carry.live);
    return count;
  }

  /**
   * Books the ranges' pixels and fills them from `read`, which holds exactly
   * those pixels in range order.
   */
  carry(ranges: Uint32Array, read: Promise<Float32Array>): void {
    this.forget(ranges);
    const carry: Carry = {
      ranges,
      live: mergePixelRanges(ranges, NO_RANGES),
      values: new Float32Array(pixelRangeCount(ranges) * 4),
    };
    this.carries.push(carry);
    this.inFlight++;
    this.reads = Promise.all([
      this.reads,
      read
        .then((values) => {
          carry.values.set(values.subarray(0, carry.values.length));
        })
        .finally(() => {
          this.inFlight--;
        }),
    ]);
  }

  /** True while no carried read is still on its way. */
  get settledNow(): boolean {
    return this.inFlight === 0;
  }

  /** Forgets the ranges' pixels — the canvas holds them again. */
  drop(ranges: Uint32Array): void {
    this.forget(ranges);
    if (this.carries.length === 0) this.box = null;
  }

  /** Widens the unpacked-UV box the carried paint covers. */
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

  /** The box the carried paint covers, or null when it carries nothing. */
  paintBox(): PaintBox | null {
    return this.box;
  }

  /** Resolves once every carried read has landed. */
  async settled(): Promise<void> {
    await this.reads;
  }

  /** The carried pixels as an ascending [start, count, ...] file range list. */
  ranges(): Uint32Array {
    let length = 0;
    for (const carry of this.carries) length += carry.live.length;
    const all = new Uint32Array(length);
    let at = 0;
    for (const carry of this.carries) {
      all.set(carry.live, at);
      at += carry.live.length;
    }
    return mergePixelRanges(all, NO_RANGES);
  }

  /** What it carries: ascending file ranges and their pixels in range order. */
  snapshot(): { ranges: Uint32Array; values: Float32Array } {
    const ranges = this.ranges();
    return { ranges, values: this.valuesOf(ranges) };
  }

  /**
   * Takes the carried pixels within `ranges` out of the carry: ascending file
   * ranges and their pixels in range order. Call once the reads have settled.
   */
  take(ranges: Uint32Array): { ranges: Uint32Array; values: Float32Array } {
    const within = intersectPixelRanges(this.ranges(), ranges);
    const values = this.valuesOf(within);
    this.drop(within);
    return { ranges: within, values };
  }

  /** The carried pixels of `ranges`, an ascending list every carry covers, in range order. */
  private valuesOf(ranges: Uint32Array): Float32Array {
    const values = new Float32Array(pixelRangeCount(ranges) * 4);
    const starts: number[] = [];
    const offsets: number[] = [];
    let at = 0;
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      starts.push(ranges[i]);
      offsets.push(at);
      at += ranges[i + 1] * 4;
    }
    const outOffset = (pixel: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pixel) lo = mid;
        else hi = mid - 1;
      }
      return offsets[lo] + (pixel - starts[lo]) * 4;
    };
    for (const carry of this.carries) {
      const booked = bookedRuns(carry.ranges);
      const live = intersectPixelRanges(carry.live, ranges);
      let k = 0;
      for (let i = 0; i + 1 < live.length; i += 2) {
        const end = live[i] + live[i + 1];
        let pixel = live[i];
        while (pixel < end) {
          while (k < booked.length && booked[k].end <= pixel) k++;
          const run = booked[k];
          if (!run) break;
          const take = Math.min(end, run.end) - pixel;
          const from = run.offset + (pixel - run.start) * 4;
          values.set(carry.values.subarray(from, from + take * 4), outOffset(pixel));
          pixel += take;
        }
      }
    }
    return values;
  }

  /** Takes the ranges' pixels out of every carry, and lets go of carries left empty. */
  private forget(ranges: Uint32Array): void {
    const kept: Carry[] = [];
    for (const carry of this.carries) {
      carry.live = subtractPixelRanges(carry.live, ranges);
      if (carry.live.length > 0) kept.push(carry);
    }
    this.carries = kept;
  }
}

/** A carry's booked ranges as ascending runs with the value offset each starts at. */
function bookedRuns(ranges: Uint32Array): { start: number; end: number; offset: number }[] {
  const runs: { start: number; end: number; offset: number }[] = [];
  let at = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    runs.push({ start: ranges[i], end: ranges[i] + ranges[i + 1], offset: at });
    at += ranges[i + 1] * 4;
  }
  runs.sort((a, b) => a.start - b.start);
  return runs;
}

/** What carrying paint off the canvas needs from it. */
export type PaintCanvas = {
  getDirtyPixelRanges(): Uint32Array | null;
  getCommittedFootprintUv(): PaintBox | null;
  readPixelRanges(pixelRanges: Uint32Array): Promise<Float32Array>;
  committedSource(): { texture: Texture; view: CanvasView };
};

/** What it needs from the block slots behind the canvas. */
export type PaintSlots = {
  grid: BlockGrid;
  copyBack(view: CanvasView, blocks: number[], source: Texture, keep?: Iterable<number>): void;
  /** True while the block's slot still holds paint the canvas gave it. */
  holdsPaint(block: number): boolean;
};

/**
 * Moves the paint on the blocks leaving the canvas for `next` off it: the
 * block slots take the painted texels, so a window coming back shows them,
 * and `carried` books them for the commit. Returns the file ranges and the
 * read of their texels, or null when nothing painted leaves.
 */
export function carryPaintOut(
  canvas: PaintCanvas,
  slots: PaintSlots,
  carried: CarriedPaint,
  next: CanvasView,
  numFrames: number,
): { fileRanges: Uint32Array; read: Promise<Float32Array> } | null {
  const dirty = canvas.getDirtyPixelRanges();
  if (!dirty) return null;
  const { texture, view: current } = canvas.committedSource();
  const carry = intersectPixelRanges(dirty, viewRangesLeaving(current, next));
  if (carry.length === 0) return null;

  const leaving: number[] = [];
  for (let block = current.firstBlock; block <= current.lastBlock; block++) {
    if (block < next.firstBlock || block > next.lastBlock) leaving.push(block);
  }
  // A leaving block whose slot went while it was off the window claims a new
  // one here, and the slide that follows composes `next` out of its slots, so
  // those are the ones the claim must not take.
  const entering: number[] = [];
  for (let block = next.firstBlock; block <= next.lastBlock; block++) entering.push(block);
  slots.copyBack(current, leaving, texture, entering);

  const fileRanges = viewRangesToFile(current, carry);
  const read = canvas.readPixelRanges(carry);
  carried.carry(fileRanges, read);
  const footprint = canvas.getCommittedFootprintUv();
  if (footprint) {
    carried.addBox({
      ...footprint,
      timeMin: viewUvToFileUv(current, numFrames, footprint.timeMin),
      timeMax: viewUvToFileUv(current, numFrames, footprint.timeMax),
    });
  }
  return { fileRanges, read };
}

/**
 * Lets go of the pixels the blocks entering `current` bring back with them.
 * A block whose slot lost its paint to the store keeps its pixels in the
 * carry: the canvas shows the committed values there, but the commit must
 * still write what the stroke painted.
 */
export function dropReturningPaint(
  carried: CarriedPaint,
  slots: PaintSlots,
  current: CanvasView,
  previous: CanvasView,
): void {
  for (let block = current.firstBlock; block <= current.lastBlock; block++) {
    if (block >= previous.firstBlock && block <= previous.lastBlock) continue;
    if (!slots.holdsPaint(block)) continue;
    const list = blockPixelRanges(slots.grid, block);
    carried.drop(list.ranges.subarray(0, list.count * 2));
  }
}
