/**
 * Utilities for flat [pixelStart, pixelCount, ...] range lists over the packed
 * coefficient array — the shared currency between the history delta encoder,
 * boundary conditioning, and partial FBO uploads.
 */

/**
 * Merges two flat [pixelStart, pixelCount, ...] range lists into one sorted,
 * non-overlapping list.
 */
export function mergePixelRanges(a: Uint32Array, b: Uint32Array): Uint32Array {
  const intervals: [number, number][] = [];
  for (const list of [a, b]) {
    for (let i = 0; i + 1 < list.length; i += 2) intervals.push([list[i], list[i] + list[i + 1]]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const out = new Uint32Array(merged.length * 2);
  merged.forEach(([start, end], i) => {
    out[i * 2] = start;
    out[i * 2 + 1] = end - start;
  });
  return out;
}
