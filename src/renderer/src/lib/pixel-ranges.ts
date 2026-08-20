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
