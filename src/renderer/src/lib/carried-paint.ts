import type { Texture } from "three";

import { blockPixelRanges, type BlockGrid } from "./block-grid";
import { viewRangesLeaving, viewRangesToFile, viewUvToFileUv, type CanvasView } from "./canvas-view";
import { intersectPixelRanges } from "./pixel-ranges";

/** The unpacked-UV box of a painted region. */
export type PaintBox = { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number };

/**
 * Texels a stroke painted on blocks that then left the canvas window, held by
 * file pixel until the stroke commits. Each carry books its pixels straight
 * away and fills them when the read lands, so a commit that starts before the
 * reads finish still knows which pixels it must wait for.
 */
export class CarriedPaint {
  private readonly slotOf = new Map<number, number>();
  private values = new Float32Array(0);
  private used = 0;
  private reads: Promise<unknown> = Promise.resolve();
  private box: PaintBox | null = null;

  /** Pixels carried. */
  get size(): number {
    return this.slotOf.size;
  }

  /**
   * Books the ranges' pixels and fills them from `read`, which holds exactly
   * those pixels in range order. A pixel booked again takes a fresh slot, so a
   * read that lands out of order cannot overwrite a later carry of it.
   */
  carry(ranges: Uint32Array, read: Promise<Float32Array>): void {
    const slots: number[] = [];
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      for (let pixel = ranges[i]; pixel < ranges[i] + ranges[i + 1]; pixel++) {
        slots.push(this.claim(pixel));
      }
    }
    this.reads = Promise.all([
      this.reads,
      read.then((values) => {
        for (let i = 0; i < slots.length; i++) {
          this.values.set(values.subarray(i * 4, i * 4 + 4), slots[i] * 4);
        }
      }),
    ]);
  }

  /** Forgets the ranges' pixels — the canvas holds them again. */
  drop(ranges: Uint32Array): void {
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      for (let pixel = ranges[i]; pixel < ranges[i] + ranges[i + 1]; pixel++) this.slotOf.delete(pixel);
    }
    if (this.slotOf.size === 0) this.box = null;
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
    const pixels = [...this.slotOf.keys()].sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 0; i < pixels.length; ) {
      let end = i + 1;
      while (end < pixels.length && pixels[end] === pixels[end - 1] + 1) end++;
      out.push(pixels[i], end - i);
      i = end;
    }
    return Uint32Array.from(out);
  }

  /** What it carries: ascending file ranges and their pixels in range order. */
  snapshot(): { ranges: Uint32Array; values: Float32Array } {
    const ranges = this.ranges();
    const values = new Float32Array(this.slotOf.size * 4);
    let at = 0;
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      for (let pixel = ranges[i]; pixel < ranges[i] + ranges[i + 1]; pixel++) {
        const slot = this.slotOf.get(pixel)!;
        values.set(this.values.subarray(slot * 4, slot * 4 + 4), at * 4);
        at++;
      }
    }
    return { ranges, values };
  }

  private claim(pixel: number): number {
    if (this.used === this.values.length >> 2) {
      const grown = new Float32Array(Math.max(1024, this.values.length * 2));
      grown.set(this.values);
      this.values = grown;
    }
    const slot = this.used++;
    this.slotOf.set(pixel, slot);
    return slot;
  }
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
  copyBack(view: CanvasView, blocks: number[], source: Texture): void;
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
  slots.copyBack(current, leaving, texture);

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
