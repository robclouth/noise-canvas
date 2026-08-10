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

/** The four shape parameters, in the -100..100 percent range the UI uses. */
export interface BrushEnvelopeShapeParams {
  curveTime: number;
  skewTime: number;
  curvePitch: number;
  skewPitch: number;
}

/**
 * Rasterizes the 2D brush envelope into RGBA pixel data as greyscale — the same
 * separable time × pitch product the shader applies. `intensity` is the 0-100
 * brush strength, which scales the whole field.
 */
export function renderBrushEnvelope(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { curveTime, skewTime, curvePitch, skewPitch }: BrushEnvelopeShapeParams,
  intensity = 100,
): void {
  const curveX = curveTime / 100;
  const skewX = (skewTime + 100) / 200;
  const curveY = curvePitch / 100;
  const skewY = (skewPitch + 100) / 200;

  const xProfile = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    xProfile[i] = brushEnvelopeShape(width === 1 ? 0 : i / (width - 1), curveX, skewX);
  }
  const yProfile = new Float32Array(height);
  for (let j = 0; j < height; j++) {
    const t = height === 1 ? 0 : 1 - j / (height - 1);
    yProfile[j] = brushEnvelopeShape(t, curveY, skewY);
  }

  const scale = Math.max(0, Math.min(1, intensity / 100));

  for (let j = 0; j < height; j++) {
    const yv = yProfile[j];
    const rowOffset = j * width * 4;
    for (let i = 0; i < width; i++) {
      const v = Math.round(xProfile[i] * yv * scale * 255);
      const k = rowOffset + i * 4;
      data[k] = v;
      data[k + 1] = v;
      data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
}
