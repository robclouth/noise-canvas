/** A pointer position in client pixels. */
export type ClientPoint = { x: number; y: number };

/** Most positions one pointer move may queue; a longer jump spaces them wider. */
export const MAX_TRAIL_POINTS = 512;

/**
 * The positions a stroke must also dab between `path[0]`, already painted, and
 * the last point of `path`, which the frame paints itself: the path sampled at
 * most `stepX` by `stepY` pixels apart, each sample resolved by `resolve`, with
 * nulls, repeats of the one before, and repeats of either end dropped.
 */
export function strokeTrail<T>(
  path: readonly ClientPoint[],
  stepX: number,
  stepY: number,
  resolve: (point: ClientPoint) => T | null,
  same: (a: T, b: T) => boolean,
): T[] {
  if (path.length < 2) return [];
  const steps: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    const n = Math.max(1, Math.ceil(Math.max(stepX > 0 ? dx / stepX : 0, stepY > 0 ? dy / stepY : 0)));
    steps.push(n);
    total += n;
  }
  const scale = total > MAX_TRAIL_POINTS ? MAX_TRAIL_POINTS / total : 1;

  const first = resolve(path[0]);
  const last = resolve(path[path.length - 1]);
  const out: T[] = [];
  let previous = first;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.round(steps[i - 1] * scale));
    for (let k = 1; k <= n; k++) {
      if (i === path.length - 1 && k === n) break;
      const t = k / n;
      const point = resolve({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (point === null) continue;
      if (previous !== null && same(point, previous)) continue;
      if (last !== null && same(point, last)) continue;
      out.push(point);
      previous = point;
    }
  }
  return out;
}
