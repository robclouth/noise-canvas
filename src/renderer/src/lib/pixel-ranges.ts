/**
 * Utilities for flat [pixelStart, pixelCount, ...] range lists over the packed
 * coefficient array — the shared currency between the history delta encoder,
 * boundary conditioning, and partial FBO uploads.
 */

/** Sorted, non-overlapping [start, end) intervals covering the given lists. */
function toIntervals(...lists: Uint32Array[]): [number, number][] {
  const intervals: [number, number][] = [];
  for (const list of lists) {
    for (let i = 0; i + 1 < list.length; i += 2) intervals.push([list[i], list[i] + list[i + 1]]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function toRanges(intervals: [number, number][]): Uint32Array {
  const out = new Uint32Array(intervals.length * 2);
  intervals.forEach(([start, end], i) => {
    out[i * 2] = start;
    out[i * 2 + 1] = end - start;
  });
  return out;
}

/**
 * Merges two flat [pixelStart, pixelCount, ...] range lists into one sorted,
 * non-overlapping list.
 */
export function mergePixelRanges(a: Uint32Array, b: Uint32Array): Uint32Array {
  return toRanges(toIntervals(a, b));
}

/** The pixels of `a` that `b` does not cover, as a sorted range list. */
export function subtractPixelRanges(a: Uint32Array, b: Uint32Array): Uint32Array {
  const cuts = toIntervals(b);
  const out: [number, number][] = [];
  let ci = 0;
  for (const [start, end] of toIntervals(a)) {
    let from = start;
    while (ci < cuts.length && cuts[ci][1] <= from) ci++;
    let j = ci;
    while (from < end && j < cuts.length && cuts[j][0] < end) {
      const [cutStart, cutEnd] = cuts[j];
      if (cutStart > from) out.push([from, cutStart]);
      from = Math.max(from, cutEnd);
      j++;
    }
    if (from < end) out.push([from, end]);
  }
  return toRanges(out);
}

/** The pixels both lists cover, as a sorted range list. */
export function intersectPixelRanges(a: Uint32Array, b: Uint32Array): Uint32Array {
  return subtractPixelRanges(a, subtractPixelRanges(a, b));
}

/** Copies the ranges' pixels (4 floats each) from `src` into `dest`. */
export function scatterPixelRanges(dest: Float32Array, src: Float32Array, ranges: Uint32Array): void {
  const pixels = Math.min(dest.length, src.length) >> 2;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i];
    const end = Math.min(start + ranges[i + 1], pixels);
    if (end > start) dest.set(src.subarray(start * 4, end * 4), start * 4);
  }
}

/** Total pixels a range list covers. */
export function pixelRangeCount(ranges: Uint32Array): number {
  let count = 0;
  for (let i = 1; i < ranges.length; i += 2) count += ranges[i];
  return count;
}

/**
 * `ranges` cut into pieces of at most `pixels` pixels, a range split where a
 * piece ends, each with where its values start in a compact array of all of
 * `ranges`.
 */
export function pixelRangePieces(ranges: Uint32Array, pixels: number): { ranges: Uint32Array; at: number }[] {
  const pieces: { ranges: Uint32Array; at: number }[] = [];
  let current: number[] = [];
  let held = 0;
  let at = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    let start = ranges[i];
    let left = ranges[i + 1];
    while (left > 0) {
      const take = Math.min(left, pixels - held);
      current.push(start, take);
      held += take;
      start += take;
      left -= take;
      if (held === pixels) {
        pieces.push({ ranges: Uint32Array.from(current), at });
        at += held * 4;
        current = [];
        held = 0;
      }
    }
  }
  if (held > 0) pieces.push({ ranges: Uint32Array.from(current), at });
  return pieces;
}

/** Whether two float arrays hold the same bit patterns, NaNs and signed zeros included. */
export function float32BitsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const aBits = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const bBits = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < aBits.length; i++) if (aBits[i] !== bBits[i]) return false;
  return true;
}

/** Copies the ranges' pixels (4 floats each) out of `src` into one block, in range order. */
export function gatherPixelRanges(src: Float32Array, ranges: Uint32Array): Float32Array {
  const out = new Float32Array(pixelRangeCount(ranges) * 4);
  let at = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i];
    const count = ranges[i + 1];
    out.set(src.subarray(start * 4, (start + count) * 4), at);
    at += count * 4;
  }
  return out;
}

/** Writes a block gathered in range order back into `dest` at the ranges' pixels. */
export function scatterCompactPixelRanges(dest: Float32Array, compact: Float32Array, ranges: Uint32Array): void {
  let at = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i];
    const count = ranges[i + 1];
    dest.set(compact.subarray(at, at + count * 4), start * 4);
    at += count * 4;
  }
}

/**
 * Copies the pixels both range lists hold, out of `src` laid out in
 * `srcRanges` order and into `dest` laid out in `destRanges` order. Both lists
 * must be sorted and non-overlapping.
 */
export function copyCompactOverlap(
  dest: Float32Array,
  destRanges: Uint32Array,
  src: Float32Array,
  srcRanges: Uint32Array,
): void {
  let srcIndex = 0;
  let srcAt = 0;
  let destAt = 0;
  for (let i = 0; i + 1 < destRanges.length; i += 2) {
    const destStart = destRanges[i];
    const destEnd = destStart + destRanges[i + 1];
    while (srcIndex + 1 < srcRanges.length && srcRanges[srcIndex] + srcRanges[srcIndex + 1] <= destStart) {
      srcAt += srcRanges[srcIndex + 1] * 4;
      srcIndex += 2;
    }
    let cursor = srcIndex;
    let at = srcAt;
    while (cursor + 1 < srcRanges.length && srcRanges[cursor] < destEnd) {
      const srcStart = srcRanges[cursor];
      const srcEnd = srcStart + srcRanges[cursor + 1];
      const low = Math.max(destStart, srcStart);
      const high = Math.min(destEnd, srcEnd);
      if (high > low) {
        const from = at + (low - srcStart) * 4;
        dest.set(src.subarray(from, from + (high - low) * 4), destAt + (low - destStart) * 4);
      }
      at += srcRanges[cursor + 1] * 4;
      cursor += 2;
    }
    destAt += destRanges[i + 1] * 4;
  }
}

/**
 * Builds the values of `target`'s pixels as one block in range order, taking
 * each pixel from the first layer whose ranges hold it. Every layer's ranges
 * and values are in range order too. Throws when a pixel is in no layer.
 */
export function composePixelRangeValues(
  target: Uint32Array,
  layers: { ranges: Uint32Array; values: Float32Array }[],
): Float32Array {
  const out = new Float32Array(pixelRangeCount(target) * 4);
  // Each layer's ranges as [start, end, valueOffset] triples, sorted by start.
  const indexed = layers.map((layer) => {
    const entries: [number, number, number][] = [];
    let at = 0;
    for (let i = 0; i + 1 < layer.ranges.length; i += 2) {
      entries.push([layer.ranges[i], layer.ranges[i] + layer.ranges[i + 1], at]);
      at += layer.ranges[i + 1] * 4;
    }
    entries.sort((a, b) => a[0] - b[0]);
    return { entries, values: layer.values, cursor: 0 };
  });

  let outAt = 0;
  const targets: [number, number][] = [];
  for (let i = 0; i + 1 < target.length; i += 2) targets.push([target[i], target[i] + target[i + 1]]);
  targets.sort((a, b) => a[0] - b[0]);
  // Range order of the output follows `target` as given, so write through an
  // offset table rather than in sorted order.
  const offsets = new Map<number, number>();
  let acc = 0;
  for (let i = 0; i + 1 < target.length; i += 2) {
    offsets.set(target[i], acc);
    acc += target[i + 1] * 4;
  }

  for (const [start, end] of targets) {
    outAt = offsets.get(start)!;
    for (let p = start; p < end; ) {
      // The run ends where the target does, where the chosen layer's range
      // does, or where a layer of higher priority begins.
      let limit = end;
      let chosen: { values: Float32Array; entry: [number, number, number] } | null = null;
      for (const layer of indexed) {
        while (layer.cursor < layer.entries.length && layer.entries[layer.cursor][1] <= p) layer.cursor++;
        const entry = layer.entries[layer.cursor];
        if (!entry) continue;
        if (entry[0] <= p) {
          chosen = { values: layer.values, entry };
          break;
        }
        limit = Math.min(limit, entry[0]);
      }
      if (!chosen) throw new Error(`pixel ${p} is in no layer`);
      const run = Math.min(limit, chosen.entry[1]) - p;
      const from = chosen.entry[2] + (p - chosen.entry[0]) * 4;
      out.set(chosen.values.subarray(from, from + run * 4), outAt);
      p += run;
      outAt += run * 4;
    }
  }
  return out;
}

/**
 * Runs of taps over the packed array: [startPixel, count, stride] triples,
 * each inside one band, sorted by start. A run's taps are the pixels
 * `startPixel + k * stride` for `k` below `count`.
 */
export function tapCount(runs: Uint32Array): number {
  let count = 0;
  for (let i = 0; i + 2 < runs.length; i += 3) count += runs[i + 1];
  return count;
}

/** The pixel range each run's taps span, one [start, count] pair per run. */
export function tapSpanRanges(runs: Uint32Array): Uint32Array {
  const out = new Uint32Array((runs.length / 3) * 2);
  for (let i = 0, j = 0; i + 2 < runs.length; i += 3, j += 2) {
    out[j] = runs[i];
    out[j + 1] = runs[i + 1] === 0 ? 0 : (runs[i + 1] - 1) * runs[i + 2] + 1;
  }
  return out;
}

/** The left and right magnitudes at every tap of `runs`, two floats per tap in run order, out of the whole packed array. */
export function gatherTaps(src: Float32Array, runs: Uint32Array): Float32Array {
  const out = new Float32Array(tapCount(runs) * 2);
  let at = 0;
  for (let i = 0; i + 2 < runs.length; i += 3) {
    const start = runs[i];
    const count = runs[i + 1];
    const stride = runs[i + 2];
    for (let k = 0; k < count; k++) {
      const pixel = (start + k * stride) * 4;
      out[at++] = src[pixel];
      out[at++] = src[pixel + 2];
    }
  }
  return out;
}

/**
 * Copies into `out`, laid out as `gatherTaps` lays it, the magnitudes of
 * every tap of `runs` that `srcRanges` holds, out of `src` laid out in
 * `srcRanges` order. Taps outside the ranges are left as they are. Both lists
 * must be sorted and non-overlapping.
 */
export function copyTapsFromCompact(
  out: Float32Array,
  runs: Uint32Array,
  src: Float32Array,
  srcRanges: Uint32Array,
): void {
  let srcIndex = 0;
  let srcAt = 0;
  let outAt = 0;
  for (let i = 0; i + 2 < runs.length; i += 3) {
    const start = runs[i];
    const count = runs[i + 1];
    const stride = runs[i + 2];
    const end = count === 0 ? start : start + (count - 1) * stride + 1;
    while (srcIndex + 1 < srcRanges.length && srcRanges[srcIndex] + srcRanges[srcIndex + 1] <= start) {
      srcAt += srcRanges[srcIndex + 1] * 4;
      srcIndex += 2;
    }
    let cursor = srcIndex;
    let at = srcAt;
    while (cursor + 1 < srcRanges.length && srcRanges[cursor] < end) {
      const rangeStart = srcRanges[cursor];
      const rangeEnd = rangeStart + srcRanges[cursor + 1];
      const first = Math.max(0, Math.ceil((rangeStart - start) / stride));
      const last = Math.min(count - 1, Math.floor((rangeEnd - 1 - start) / stride));
      for (let k = first; k <= last; k++) {
        const pixel = at + (start + k * stride - rangeStart) * 4;
        out[(outAt + k) * 2] = src[pixel];
        out[(outAt + k) * 2 + 1] = src[pixel + 2];
      }
      at += srcRanges[cursor + 1] * 4;
      cursor += 2;
    }
    outAt += count;
  }
}
