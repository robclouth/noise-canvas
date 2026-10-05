import {
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
} from "three";
import { describe, expect, it } from "vitest";
import { createDefaultUniforms } from "../../effects/base-effect";
import passThroughVert from "../../glsl/pass-through.vert";
import probeFrag from "../../test/random-at-probe.frag";
import { createGL } from "../../test/render-harness";

/** randomAt for salts 1 to 4 at each bin, read back from the GPU. */
function drawsAt(bins: { frame: number; band: number }[]): Float32Array {
  const gl = createGL();
  const input = new Float32Array(bins.flatMap(({ frame, band }) => [Math.floor(frame / 4096), frame % 4096, band, 0]));
  const probeTex = new DataTexture(input, bins.length, 1, RGBAFormat, FloatType);
  probeTex.needsUpdate = true;
  const material = new RawShaderMaterial({
    uniforms: { ...createDefaultUniforms(), probeTex: { value: probeTex } },
    vertexShader: passThroughVert,
    fragmentShader: probeFrag,
    glslVersion: GLSL3,
  });
  const target = new WebGLRenderTarget(bins.length, 1, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), material));
  gl.setRenderTarget(target);
  gl.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const out = new Float32Array(bins.length * 4);
  gl.readRenderTargetPixels(target, 0, 0, bins.length, 1, out);
  gl.setRenderTarget(null);
  target.dispose();
  material.dispose();
  probeTex.dispose();
  gl.dispose();
  return out;
}

/** Correlation of neighbouring values in `values`. */
function neighbourCorrelation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    den += (values[i] - mean) ** 2;
    if (i > 0) num += (values[i] - mean) * (values[i - 1] - mean);
  }
  return num / den;
}

describe("randomAt", () => {
  it.each([0, 2 ** 25 - 1024])("draws independent values for neighbouring bins from frame %i", (start) => {
    const bins = Array.from({ length: 2048 }, (_, i) => ({ frame: start + i, band: 7 }));
    const out = drawsAt(bins);
    for (let salt = 0; salt < 4; salt++) {
      const values = bins.map((_, i) => out[i * 4 + salt]);
      expect(new Set(values).size).toBeGreaterThan(values.length * 0.99);
      expect(Math.abs(neighbourCorrelation(values))).toBeLessThan(0.1);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      expect(mean).toBeGreaterThan(0.45);
      expect(mean).toBeLessThan(0.55);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...values)).toBeLessThan(1);
    }
  });

  it("draws independent values for neighbouring bands", () => {
    const bins = Array.from({ length: 512 }, (_, band) => ({ frame: 2 ** 25 + 17, band }));
    const out = drawsAt(bins);
    const values = bins.map((_, i) => out[i * 4]);
    expect(Math.abs(neighbourCorrelation(values))).toBeLessThan(0.15);
  });
});
