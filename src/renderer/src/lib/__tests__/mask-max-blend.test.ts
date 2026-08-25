import {
  CustomBlending,
  FloatType,
  GLSL3,
  HalfFloatType,
  MaxEquation,
  Mesh,
  NearestFilter,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The stroke mask keeps the strongest weight each dab reached per pixel. It
 * gets that from MAX blending into a single R16F target, so this pins the
 * device capability the mask path depends on: overlapping draws into a
 * half-float red target must resolve to the larger value, whichever order they
 * arrive in.
 */

const VERT = /* glsl */ `
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float value;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(value, 0.0, 0.0, 1.0);
}
`;

const RESOLVE_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D maskTex;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(texture(maskTex, vUv).r, 0.0, 0.0, 1.0);
}
`;

const SIZE = 64;

describe("stroke mask MAX blending", () => {
  let gl: WebGLRenderer;
  let mask: WebGLRenderTarget;
  let resolved: WebGLRenderTarget;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(SIZE, SIZE);
    gl.autoClear = false;
    mask = new WebGLRenderTarget(SIZE, SIZE, {
      format: RedFormat,
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    resolved = new WebGLRenderTarget(SIZE, SIZE, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  });

  afterEach(() => {
    mask.dispose();
    resolved.dispose();
    gl.dispose();
  });

  /** A quad spanning x in [left, right] of clip space, writing `value` with MAX blending. */
  function makeQuad(left: number, right: number, value: number): Scene {
    const material = new RawShaderMaterial({
      uniforms: { value: { value } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      glslVersion: GLSL3,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new PlaneGeometry(right - left, 2);
    const mesh = new Mesh(geometry, material);
    mesh.position.x = (left + right) / 2;
    const scene = new Scene();
    scene.add(mesh);
    return scene;
  }

  /** Draws the quads in order into a cleared mask, then reads the mask back. */
  function drawAndRead(quads: Scene[]): Float32Array {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    gl.setRenderTarget(mask);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, false, false);
    for (const quad of quads) gl.render(quad, camera);

    const resolveScene = new Scene();
    resolveScene.add(
      new Mesh(
        new PlaneGeometry(2, 2),
        new RawShaderMaterial({
          uniforms: { maskTex: { value: mask.texture } },
          vertexShader: RESOLVE_VERT,
          fragmentShader: RESOLVE_FRAG,
          glslVersion: GLSL3,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    );
    gl.setRenderTarget(resolved);
    gl.clear(true, false, false);
    gl.render(resolveScene, camera);

    const pixels = new Float32Array(SIZE * SIZE * 4);
    gl.readRenderTargetPixels(resolved, 0, 0, SIZE, SIZE, pixels);
    gl.setRenderTarget(null);
    return pixels;
  }

  /** The red channel at a fraction across the target, sampled mid-height. */
  function redAt(pixels: Float32Array, xFraction: number): number {
    const x = Math.floor(xFraction * SIZE);
    const y = SIZE / 2;
    return pixels[(y * SIZE + x) * 4];
  }

  it("keeps the larger of two overlapping draws, in either order", () => {
    // Quads at x in [-1, 0.5] and [-0.5, 1] of clip space: the overlap is the
    // middle half of the target.
    const weak = makeQuad(-1, 0.5, 0.25);
    const strong = makeQuad(-0.5, 1, 0.75);

    const weakFirst = drawAndRead([weak, strong]);
    expect(redAt(weakFirst, 0.1)).toBeCloseTo(0.25, 3);
    expect(redAt(weakFirst, 0.5)).toBeCloseTo(0.75, 3);
    expect(redAt(weakFirst, 0.9)).toBeCloseTo(0.75, 3);

    const strongFirst = drawAndRead([strong, weak]);
    expect(redAt(strongFirst, 0.1)).toBeCloseTo(0.25, 3);
    expect(redAt(strongFirst, 0.5)).toBeCloseTo(0.75, 3);
    expect(redAt(strongFirst, 0.9)).toBeCloseTo(0.75, 3);
  });

  it("leaves the cleared value where nothing was drawn", () => {
    const pixels = drawAndRead([makeQuad(-1, 0, 0.5)]);
    expect(redAt(pixels, 0.25)).toBeCloseTo(0.5, 3);
    expect(redAt(pixels, 0.75)).toBe(0);
  });
});
