import { brushEnvelopeShape } from "./brush-envelope";

/** The parameters that define the envelope's shape, as opposed to its size or strength. */
export const ENVELOPE_SHAPE_PARAMS = ["brushCurveTime", "brushSkewTime", "brushCurvePitch", "brushSkewPitch"] as const;

export type EnvelopeShapeParam = (typeof ENVELOPE_SHAPE_PARAMS)[number];

export type EnvelopeShapeValues = Record<EnvelopeShapeParam, number>;

export type EnvelopeShape = {
  /** One or two words, shown under the tile's tooltip. */
  name: string;
  values: EnvelopeShapeValues;
  /**
   * What the tile draws, for shapes that do not read at tile size: a slightly
   * soft edge fills a 30-pixel tile with flat white, and a sharp edge thins to
   * a sub-pixel line. The tile exaggerates the curve; the click still applies
   * `values`.
   */
  preview?: EnvelopeShapeValues;
};

/** The ready-made shapes the tiles above the envelope preview apply. */
export const ENVELOPE_SHAPES: readonly EnvelopeShape[] = [
  {
    name: "Box",
    values: { brushCurveTime: 100, brushSkewTime: 0, brushCurvePitch: 100, brushSkewPitch: 0 },
  },
  {
    name: "Soft",
    values: { brushCurveTime: 70, brushSkewTime: 0, brushCurvePitch: 70, brushSkewPitch: 0 },
    preview: { brushCurveTime: 30, brushSkewTime: 0, brushCurvePitch: 30, brushSkewPitch: 0 },
  },
  {
    name: "Soft Time",
    values: { brushCurveTime: -50, brushSkewTime: 0, brushCurvePitch: 100, brushSkewPitch: 0 },
  },
  {
    name: "Soft Pitch",
    values: { brushCurveTime: 100, brushSkewTime: 0, brushCurvePitch: -50, brushSkewPitch: 0 },
  },
  {
    name: "Fade Out",
    values: { brushCurveTime: 0, brushSkewTime: -100, brushCurvePitch: 100, brushSkewPitch: 0 },
  },
  {
    name: "Fade In",
    values: { brushCurveTime: 0, brushSkewTime: 100, brushCurvePitch: 100, brushSkewPitch: 0 },
  },
  {
    name: "Fade Down",
    values: { brushCurveTime: 100, brushSkewTime: 0, brushCurvePitch: 0, brushSkewPitch: -100 },
  },
  {
    name: "Fade Up",
    values: { brushCurveTime: 100, brushSkewTime: 0, brushCurvePitch: 0, brushSkewPitch: 100 },
  },
];

/** Paints the envelope as a greyscale field, brightest where the brush deposits most. */
export function drawEnvelope(ctx: CanvasRenderingContext2D, values: EnvelopeShapeValues, intensity: number): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  const curveX = values.brushCurveTime / 100;
  const skewX = (values.brushSkewTime + 100) / 200;
  const curveY = values.brushCurvePitch / 100;
  const skewY = (values.brushSkewPitch + 100) / 200;

  const xProfile = new Float32Array(w);
  for (let i = 0; i < w; i++) {
    xProfile[i] = brushEnvelopeShape(i / (w - 1), curveX, skewX);
  }
  const yProfile = new Float32Array(h);
  for (let j = 0; j < h; j++) {
    const t = 1 - j / (h - 1);
    yProfile[j] = brushEnvelopeShape(t, curveY, skewY);
  }

  const scale = Math.max(0, Math.min(1, intensity / 100));

  for (let j = 0; j < h; j++) {
    const yv = yProfile[j];
    const rowOffset = j * w * 4;
    for (let i = 0; i < w; i++) {
      const v = Math.round(xProfile[i] * yv * scale * 255);
      const k = rowOffset + i * 4;
      data[k] = v;
      data[k + 1] = v;
      data[k + 2] = v;
      data[k + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}
