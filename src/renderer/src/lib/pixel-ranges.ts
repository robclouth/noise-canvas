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
