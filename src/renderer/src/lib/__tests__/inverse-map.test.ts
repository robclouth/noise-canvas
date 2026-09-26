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
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from "three";
import { afterAll, describe, expect, it } from "vitest";
import { effects } from "../../effects";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createGL, createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { blockGrid } from "../block-grid";
import { canvasViewInverseMap, canvasViewOf, type CanvasView } from "../canvas-view";
import { StrokeRenderer } from "../stroke-renderer";

const data = createConstantQMockSpectrogramData({ durationSeconds: 3, sampleRate: 8000, bandsPerOctave: 12 });
const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate, 0.25);

/** The two channels of each texel of a texture, read back through an RGBA float target. */
function readRg(gl: WebGLRenderer, texture: Texture, width: number, height: number): Float32Array {
  const material = new RawShaderMaterial({
    uniforms: { source: { value: texture } },
    vertexShader: `in vec3 position; void main() { gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; precision highp sampler2D; uniform sampler2D source; out vec4 outColor;
      void main() { outColor = vec4(texelFetch(source, ivec2(gl_FragCoord.xy), 0).rg, 0.0, 1.0); }`,
    glslVersion: GLSL3,
  });
  const target = new WebGLRenderTarget(width, height, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  gl.setRenderTarget(target);
  gl.render(new Scene().add(new Mesh(new PlaneGeometry(2, 2), material)), new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const rgba = new Float32Array(width * height * 4);
  gl.readRenderTargetPixels(target, 0, 0, width, height, rgba);
  gl.setRenderTarget(null);
  target.dispose();
  material.dispose();
  const rg = new Float32Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    rg[i * 2] = rgba[i * 4];
    rg[i * 2 + 1] = rgba[i * 4 + 1];
  }
  return rg;
}

let gl: WebGLRenderer | null = null;

describe("a view's inverse map", () => {
  afterAll(() => gl?.dispose());

  const views: [string, () => CanvasView][] = [
    ["the file's first blocks", () => canvasViewOf(grid, 0, 2)],
    ["the file's last blocks", () => canvasViewOf(grid, grid.blockCount - 3, grid.blockCount - 1)],
    ["some of the bands only", () => canvasViewOf(grid, 1, 3, { first: 5, last: 20 })],
  ];

  it.each(views)("is drawn on the GPU as it is built on the CPU, over %s", (_name, viewOf) => {
    gl ??= createGL();
    const view = viewOf();
    const textures = createHarnessTextures(data);
    const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "inverse-map", effects, view);
    try {
      const drawn = readRg(gl, renderer.getTextures().inverse, view.textureWidth, view.textureHeight);
      expect(Array.from(drawn)).toEqual(Array.from(canvasViewInverseMap(view)));
    } finally {
      renderer.dispose();
      disposeHarnessTextures(textures);
    }
  });
});
