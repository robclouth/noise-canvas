/**
 * Max-reduction pyramid over a Float32Array, giving exact range-maximum
 * queries in O(log n). Level 0 is the base array; each level above halves it,
 * carrying the larger of each pair.
 */
export type MaxPyramid = Float32Array[];

const pyramidCache = new WeakMap<Float32Array, MaxPyramid>();

export function buildMaxPyramid(base: Float32Array): MaxPyramid {
  const levels: MaxPyramid = [base];
  let prev = base;
  while (prev.length > 1) {
    const next = new Float32Array(Math.ceil(prev.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = prev[i * 2];
      const b = i * 2 + 1 < prev.length ? prev[i * 2 + 1] : a;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    prev = next;
  }
  return levels;
}

/** The pyramid for `base`, built once per array identity. */
export function getMaxPyramid(base: Float32Array): MaxPyramid {
  let pyramid = pyramidCache.get(base);
  if (!pyramid) {
    pyramid = buildMaxPyramid(base);
    pyramidCache.set(base, pyramid);
  }
  return pyramid;
}

/** Maximum of the base values at indices [first, last], both clamped inclusive. Empty ranges give 0. */
export function queryMax(pyramid: MaxPyramid, first: number, last: number): number {
  let lo = Math.max(0, first);
  let hi = Math.min(pyramid[0].length - 1, last);
  let best = 0;
  for (let level = 0; lo <= hi; level++) {
    const values = pyramid[level];
    if (lo & 1) {
      if (values[lo] > best) best = values[lo];
      lo++;
    }
    if ((hi & 1) === 0) {
      if (values[hi] > best) best = values[hi];
      hi--;
    }
    lo >>= 1;
    hi >>= 1;
  }
  return best;
}
