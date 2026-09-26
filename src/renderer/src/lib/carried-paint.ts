import { intersectPixelRanges, mergePixelRanges, pixelRangeCount, subtractPixelRanges } from "./pixel-ranges";

/** The unpacked-UV box of a painted region. */
export type PaintBox = { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number };

/**
 * One carry: the file ranges it was booked with, the pixels of them still
 * carried, their values in booking order, and each brush step's mask weights
 * over the same pixels (null for a step with no mask).
 */
type Carry = {
  ranges: Uint32Array;
  booked: { start: number; end: number; offset: number }[];
  live: Uint32Array;
  values: Float32Array;
  masks: (Float32Array | null)[];
};

/** What a carry's read brings back: the pixels' values, and each step's mask weights over them. */
export type CarriedRead = { values: Float32Array; masks: readonly (Float32Array | null)[] };

/** Carried pixels taken back out: ascending file ranges, their values and mask weights in range order. */
export type TakenPaint = { ranges: Uint32Array; values: Float32Array; masks: (Float32Array | null)[] };

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
   * Books the ranges' pixels and fills them from `read`, whose values and
   * mask weights hold exactly those pixels in range order.
   */
  carry(ranges: Uint32Array, read: Promise<CarriedRead>): void {
    this.forget(ranges);
    const carry: Carry = {
      ranges,
      booked: bookedRuns(ranges),
      live: mergePixelRanges(ranges, NO_RANGES),
      values: new Float32Array(pixelRangeCount(ranges) * 4),
      masks: [],
    };
    this.carries.push(carry);
    this.inFlight++;
    this.reads = Promise.all([
      this.reads,
      read
        .then(({ values, masks }) => {
          carry.values.set(values.subarray(0, carry.values.length));
          carry.masks = masks.map((mask) => mask?.slice(0, carry.values.length >> 2) ?? null);
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
    return { ranges, values: this.valuesOf(ranges).values };
  }

  /**
   * The carried pixels within `ranges`, with the mask weights they were
   * carried with, left in the carry. Call once the reads have settled.
   */
  read(ranges: Uint32Array): TakenPaint {
    const within = intersectPixelRanges(this.ranges(), ranges);
    return { ranges: within, ...this.valuesOf(within) };
  }

  /**
   * Takes the carried pixels within `ranges` out of the carry, with the mask
   * weights they were carried with. Call once the reads have settled.
   */
  take(ranges: Uint32Array): TakenPaint {
    const within = intersectPixelRanges(this.ranges(), ranges);
    const taken = this.valuesOf(within);
    this.drop(within);
    return { ranges: within, ...taken };
  }

  /**
   * Writes every carried pixel inside `ranges` into `out`, which holds the
   * pixels of `ranges` in range order; pixels the carry does not hold are left
   * as they are.
   */
  copyInto(out: Float32Array, ranges: Uint32Array): void {
    const targets: { start: number; end: number; offset: number }[] = [];
    let at = 0;
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      targets.push({ start: ranges[i], end: ranges[i] + ranges[i + 1], offset: at });
      at += ranges[i + 1] * 4;
    }
    targets.sort((x, y) => x.start - y.start);
    for (const carry of this.carries) {
      const booked = carry.booked;
      const live = carry.live;
      let l = 0;
      let k = 0;
      for (const target of targets) {
        while (l + 1 < live.length && live[l] + live[l + 1] <= target.start) l += 2;
        while (k < booked.length && booked[k].end <= target.start) k++;
        for (let li = l; li + 1 < live.length && live[li] < target.end; li += 2) {
          const from = Math.max(target.start, live[li]);
          const to = Math.min(target.end, live[li] + live[li + 1]);
          for (let bk = k; bk < booked.length && booked[bk].start < to; bk++) {
            const lo = Math.max(from, booked[bk].start);
            const hi = Math.min(to, booked[bk].end);
            if (hi <= lo) continue;
            const src = booked[bk].offset + (lo - booked[bk].start) * 4;
            out.set(carry.values.subarray(src, src + (hi - lo) * 4), target.offset + (lo - target.start) * 4);
          }
        }
      }
    }
  }

  /**
   * The carried pixels of `ranges`, an ascending list every carry covers, in
   * range order, with each step's mask weights over them. A pixel whose
   * carry had no mask for a step reads a weight of zero there.
   */
  private valuesOf(ranges: Uint32Array): { values: Float32Array; masks: (Float32Array | null)[] } {
    const pixels = pixelRangeCount(ranges);
    const values = new Float32Array(pixels * 4);
    const masks: (Float32Array | null)[] = [];
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
      const booked = carry.booked;
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
          const to = outOffset(pixel);
          values.set(carry.values.subarray(from, from + take * 4), to);
          for (let step = 0; step < carry.masks.length; step++) {
            const mask = carry.masks[step];
            if (!mask) continue;
            while (masks.length <= step) masks.push(null);
            const weights = (masks[step] ??= new Float32Array(pixels));
            weights.set(mask.subarray(from >> 2, (from >> 2) + take), to >> 2);
          }
          pixel += take;
        }
      }
    }
    return { values, masks };
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
