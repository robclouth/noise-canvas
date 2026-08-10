import { describe, expect, it } from "vitest";
import { brushEnvelopeShape, renderBrushEnvelope } from "../brush-envelope";
import { ENVELOPE_PRESETS } from "../envelope-presets";
import type { ParameterKey } from "../../store/types";

// parameters.ts and the store import each other. The cycle only resolves when
// the store is the entry point, so load it first and pull parameters in after.
const loadParameterDefs = async () => {
  await import("../../store");
  return (await import("../../parameters")).getParameterDef;
};

const WIDTH = 24;
const HEIGHT = 16;

function raster(params: Parameters<typeof renderBrushEnvelope>[3], intensity?: number) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  renderBrushEnvelope(data, WIDTH, HEIGHT, params, intensity);
  return data;
}

/** Greyscale value at a pixel, 0-255. */
const at = (data: Uint8ClampedArray, x: number, y: number) => data[(y * WIDTH + x) * 4];

describe("renderBrushEnvelope", () => {
  const params = { curveTime: -30, skewTime: 40, curvePitch: 60, skewPitch: -20 };

  it("is the separable product of the time and pitch envelope shapes", () => {
    const data = raster(params);
    const curveX = params.curveTime / 100;
    const skewX = (params.skewTime + 100) / 200;
    const curveY = params.curvePitch / 100;
    const skewY = (params.skewPitch + 100) / 200;

    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const xv = brushEnvelopeShape(x / (WIDTH - 1), curveX, skewX);
        const yv = brushEnvelopeShape(1 - y / (HEIGHT - 1), curveY, skewY);
        expect(at(data, x, y)).toBe(Math.round(xv * yv * 255));
      }
    }
  });

  it("writes opaque greyscale pixels", () => {
    const data = raster(params);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const k = i * 4;
      expect(data[k + 1]).toBe(data[k]);
      expect(data[k + 2]).toBe(data[k]);
      expect(data[k + 3]).toBe(255);
    }
  });

  it("scales the whole field by intensity", () => {
    const full = raster(params, 100);
    const half = raster(params, 50);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      // Rounding means half can land one level either side of exactly half.
      expect(Math.abs(half[i * 4] - full[i * 4] / 2)).toBeLessThanOrEqual(1);
    }
  });

  it("clamps intensity outside 0-100", () => {
    expect(raster(params, -20).every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
    const over = raster(params, 500);
    const full = raster(params, 100);
    expect(Array.from(over)).toEqual(Array.from(full));
  });

  it("handles single-pixel dimensions without dividing by zero", () => {
    const data = new Uint8ClampedArray(4);
    renderBrushEnvelope(data, 1, 1, params);
    expect(Number.isNaN(data[0])).toBe(false);
  });
});

describe("ENVELOPE_PRESETS", () => {
  const shapeKeys: Array<[keyof (typeof ENVELOPE_PRESETS)[number], ParameterKey]> = [
    ["curveTime", "brushCurveTime"],
    ["skewTime", "brushSkewTime"],
    ["curvePitch", "brushCurvePitch"],
    ["skewPitch", "brushSkewPitch"],
  ];

  it("has unique ids and names", () => {
    expect(new Set(ENVELOPE_PRESETS.map((p) => p.id)).size).toBe(ENVELOPE_PRESETS.length);
    expect(new Set(ENVELOPE_PRESETS.map((p) => p.name)).size).toBe(ENVELOPE_PRESETS.length);
  });

  it("stays within each parameter's declared range", async () => {
    const getParameterDef = await loadParameterDefs();
    for (const preset of ENVELOPE_PRESETS) {
      for (const [field, paramKey] of shapeKeys) {
        const def = getParameterDef(paramKey);
        if (def.kind !== "number") throw new Error(`${paramKey} is not a number parameter`);
        const value = preset[field] as number;
        expect(value).toBeGreaterThanOrEqual(def.min);
        expect(value).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it("renders a visibly different shape for every preset", () => {
    const seen = new Map<string, string>();
    for (const preset of ENVELOPE_PRESETS) {
      const key = Array.from(raster(preset)).join(",");
      expect(seen.has(key), `${preset.name} renders identically to ${seen.get(key)}`).toBe(false);
      seen.set(key, preset.name);
    }
  });

  it("matches the default brush envelope with the Block preset", async () => {
    const getParameterDef = await loadParameterDefs();
    const block = ENVELOPE_PRESETS.find((p) => p.id === "block");
    expect(block).toBeDefined();
    for (const [field, paramKey] of shapeKeys) {
      expect(block![field]).toBe(getParameterDef(paramKey).default);
    }
  });
});
