import {
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import addressProbeFrag from "../../test/address-probe.frag";
import probeVert from "../../test/paging-probe.vert";
import { EXACT_ADDRESS_PIXELS } from "../window-policy";

/**
 * The shaders address a packed texel by adding a band's offset to a bin index
 * in a float32. This pins, on the GPU itself, where that sum stops naming
 * texels one at a time — which is why the window policy caps a window at
 * EXACT_ADDRESS_PIXELS.
 */

const COLUMNS = 64;

describe("packed texel addressing on the GPU", () => {
  let renderer: WebGLRenderer;
  let scene: Scene;
  let camera: OrthographicCamera;
  let material: RawShaderMaterial;

  beforeAll(() => {
    renderer = new WebGLRenderer({ antialias: false });
    material = new RawShaderMaterial({
      uniforms: { baseIndex: { value: 0 } },
      vertexShader: probeVert,
      fragmentShader: addressProbeFrag,
      glslVersion: GLSL3,
    });
    scene = new Scene();
    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  });

  afterAll(() => {
    renderer.dispose();
  });

  /** The texel each of COLUMNS consecutive indices resolved to, as "x,y" keys. */
  function resolvedTexels(baseIndex: number): string[] {
    const target = new WebGLRenderTarget(COLUMNS, 1, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    material.uniforms.baseIndex.value = baseIndex;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const out = new Float32Array(COLUMNS * 4);
    renderer.readRenderTargetPixels(target, 0, 0, COLUMNS, 1, out);
    renderer.setRenderTarget(null);
    target.dispose();
    const texels: string[] = [];
    for (let x = 0; x < COLUMNS; x++) texels.push(`${out[x * 4]},${out[x * 4 + 1]}`);
    return texels;
  }

  it("resolves every index to its own texel below the ceiling", () => {
    for (const base of [0, 1_000_000, EXACT_ADDRESS_PIXELS - COLUMNS - 1]) {
      const texels = resolvedTexels(base);
      expect(new Set(texels).size).toBe(COLUMNS);
    }
  });

  it("collapses consecutive indices onto one texel past the ceiling", () => {
    const atCeiling = resolvedTexels(EXACT_ADDRESS_PIXELS);
    // Round-to-nearest-even: index+1 lands on the same texel as index.
    expect(atCeiling[1]).toBe(atCeiling[0]);
    expect(new Set(atCeiling).size).toBeLessThanOrEqual(COLUMNS / 2 + 1);

    // One octave further the granularity doubles again.
    const doubled = resolvedTexels(EXACT_ADDRESS_PIXELS * 2);
    expect(new Set(doubled).size).toBeLessThanOrEqual(COLUMNS / 4 + 1);
  });

  it("resolves the same span exactly once it is rebased under the ceiling", () => {
    // The window does exactly this: its metadata offsets are window-local, so
    // a bin that sat past 2^24 in the file addresses a small index instead.
    const rebased = resolvedTexels(EXACT_ADDRESS_PIXELS % 8192 === 0 ? 4096 : 0);
    expect(new Set(rebased).size).toBe(COLUMNS);
  });
});
