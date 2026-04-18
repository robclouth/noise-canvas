const EPSILON = 1e-6;

export function brushEnvelopeShape(localPos: number, curve: number, skew: number): number {
  if (localPos < 0 || localPos > 1) return 0;
  const c = Math.max(-1, Math.min(1, curve));
  const s = Math.max(0, Math.min(1, skew));
  const leftW = Math.max(s, EPSILON);
  const rightW = Math.max(1 - s, EPSILON);
  const x = localPos < s ? (s - localPos) / leftW : (localPos - s) / rightW;
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  if (c >= 0) {
    const p = 1 / Math.max(1 - c, EPSILON);
    return 1 - Math.pow(x, p);
  }
  const p = 1 / Math.max(1 + c * 0.98, EPSILON);
  return Math.pow(1 - x, p);
}
