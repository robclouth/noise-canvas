import {
  Color,
  GLSL3,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDefaultUniforms } from "../../effects/base-effect";
import displayFrag from "../../glsl/display.frag";
import passThroughVert from "../../glsl/pass-through.vert";
import { createConstantQMockSpectrogramData, createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import {
  createHarnessTextures,
  createSourceFile,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
} from "../../test/render-harness";
import type { SpectrogramData, State } from "../../store/types";
import { displayLevelChoice } from "../display-pyramid";
import type { EffectsRegistry, StrokeRenderer as StrokeRendererType } from "../stroke-renderer";
import { StrokeRenderer } from "../stroke-renderer";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "../utils";

/**
 * The display reads the committed picture from the pyramid rather than the
 * canvas. Rendering the real display shader from each must agree wherever the
 * level the view picks is at least as fine as the screen, after every kind of
 * committed write.
 */

const WIDTH = 96;
const HEIGHT = 48;

/** The real display shader with every overlay uniform quiet. */
function createDisplayTestMaterial(): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      ...createDefaultUniforms(),
      sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
      minDb: { value: -80 },
      maxDb: { value: 0 },
      bpm: { value: 120 },
      gridSize: { value: 0.25 },
      gridWidthUv: { value: 0 },
      gridHeightUv: { value: 0 },
      barWidthUv: { value: 0 },
      swingOffsetUv: { value: 0 },
      octaveHeightUv: { value: 0 },
      showHorizontalGrid: { value: false },
      showVerticalGrid: { value: false },
      scaleGridEnabled: { value: false },
      scaleOffsets: { value: new Float32Array(12) },
      pitchOffsetSemisFromC0: { value: 0 },
      showTargetRectangle: { value: false },
      showSourceRectangle: { value: false },
      targetRectPulse: { value: 1 },
      targetRectColor: { value: new Color(1, 1, 1) },
      sourceSamplingBottomLeftUv: { value: new Vector2(-1, -1) },
      viewZoomPower: { value: 0 },
      viewOffset: { value: 0 },
      viewZoomPowerY: { value: 0 },
      viewOffsetY: { value: 0 },
      wrapMode: { value: 0 },
      fullScaleDbOffset: { value: 0 },
      previewTex: { value: null },
      previewBinRangesTex: { value: null },
      previewActive: { value: false },
      displayFineTex: { value: null },
      displayFineMetaTex: { value: null },
      displayCoarseTex: { value: null },
      displayCoarseMetaTex: { value: null },
      displayLevelBlend: { value: 0 },
      displayPyramidActive: { value: false },
    },
    vertexShader: passThroughVert,
    fragmentShader: displayFrag,
    glslVersion: GLSL3,
  });
}

function maxChannelDiff(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

/** One display view of a spectrogram, renderable from either source. */
function makeView(gl: WebGLRenderer, data: SpectrogramData, effects: EffectsRegistry) {
  const textures = createHarnessTextures(data);
  const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "pyramid-parity", effects);
  renderer.initialize();

  const material = createDisplayTestMaterial();
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const target = new WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: false, stencilBuffer: false });

  /** Renders from the pyramid or the canvas at a zoom, the way the app binds them. */
  function render(fromPyramid: boolean, zoomPower = 0): Uint8Array {
    const preview = renderer.getPreviewDisplay();
    const u = material.uniforms;
    u.sourceSpectrogramTex.value = preview.committed;
    u.sourceMetadataTex.value = textures.metadataTex;
    u.sourceInverseMapTex.value = textures.inverseMapTex;
    u.sourceMinFreq.value = data.minFreq;
    u.sourceBandsPerOctave.value = data.bandsPerOctave;
    u.sourceFrameCount.value = data.numFrames;
    u.sourceBandCount.value = data.numBands;
    u.sourceChannelCount.value = data.numChannels;
    u.sourceSampleRate.value = data.sampleRate;
    u.sourceSpectrogramTextureSize.value = data.packedTextureSize;
    u.viewZoomPower.value = zoomPower;
    u.viewOffset.value = 0;

    const pyramid = renderer.getDisplayPyramid();
    if (fromPyramid && pyramid) {
      const framesPerPixel = data.numFrames / (2 ** zoomPower * WIDTH);
      const choice = displayLevelChoice(pyramid.levels, framesPerPixel);
      u.displayFineTex.value = pyramid.texture(choice.fine);
      u.displayFineMetaTex.value = pyramid.metadataTexture(choice.fine);
      u.displayCoarseTex.value = pyramid.texture(choice.coarse);
      u.displayCoarseMetaTex.value = pyramid.metadataTexture(choice.coarse);
      u.displayLevelBlend.value = choice.blend;
    }
    u.displayPyramidActive.value = fromPyramid;

    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    return pixels;
  }

  /** Renders from one named level alone, whatever the view would have picked. */
  function renderAtLevel(index: number): Uint8Array {
    render(false);
    const pyramid = renderer.getDisplayPyramid();
    if (!pyramid) throw new Error("the renderer built no display pyramid");
    const u = material.uniforms;
    u.displayFineTex.value = pyramid.texture(index);
    u.displayFineMetaTex.value = pyramid.metadataTexture(index);
    u.displayCoarseTex.value = pyramid.texture(index);
    u.displayCoarseMetaTex.value = pyramid.metadataTexture(index);
    u.displayLevelBlend.value = 0;
    u.displayPyramidActive.value = true;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    return pixels;
  }

  function dispose(): void {
    target.dispose();
    material.dispose();
    renderer.dispose();
    disposeHarnessTextures(textures);
  }

  return { renderer, material, render, renderAtLevel, dispose };
}

describe("display pyramid parity", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  const disposers: Array<() => void> = [];

  beforeAll(async () => {
    const [dy, pt] = await Promise.all([
      import("../../effects/dynamics-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { dynamics: dy.dynamicsEffect, passthrough: pt.passThroughEffect } as EffectsRegistry;
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(WIDTH, HEIGHT);
  });

  afterAll(() => {
    for (const dispose of disposers.reverse()) dispose();
    gl.dispose();
  });

  function view(data: SpectrogramData): ReturnType<typeof makeView> {
    const made = makeView(gl, data, effects);
    disposers.push(made.dispose);
    return made;
  }

  async function paintCommittedStroke(renderer: StrokeRendererType, data: SpectrogramData, gainDb: number) {
    const state = createMockStateWithSteps([
      {
        name: "Gain",
        overrides: {
          brushIntensity: 100,
          brushSizeTime: BRUSH_SIZE_TIME_FULL,
          brushSizePitch: BRUSH_SIZE_PITCH_FULL,
          effects: [
            { id: "test-dynamics", effect: "dynamics" as const, enabled: true, params: { dynamicsGainDb: gainDb } },
          ],
        },
      },
    ]) as State;
    renderer.beginStroke();
    renderer.renderStroke(makeStrokeParams(new Vector2(0, 0), data), state, createSourceFile(renderer, data));
    await renderer.getFBOData();
  }

  describe("on a flat layout at whole-file zoom", () => {
    const data = createMockSpectrogramData({ numFrames: 16, numBands: 8, pattern: "gradient" });

    it("matches the canvas within a grey unit before any stroke", () => {
      const v = view(data);
      expect(maxChannelDiff(v.render(true), v.render(false))).toBeLessThanOrEqual(1);
    });

    it("really reads the level it is given", () => {
      const v = view(data);
      const pyramid = v.renderer.getDisplayPyramid();
      expect(pyramid).not.toBeNull();
      const coarsest = pyramid!.levels.length - 1;
      expect(maxChannelDiff(v.render(false), v.renderAtLevel(coarsest))).toBeGreaterThan(1);
    });

    it("follows a committed stroke", async () => {
      const v = view(data);
      const before = v.render(true);
      await paintCommittedStroke(v.renderer, data, -24);
      const after = v.render(true);
      expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
      expect(maxChannelDiff(after, v.render(false))).toBeLessThanOrEqual(1);
    });

    it("follows setFBOData", () => {
      const v = view(data);
      const boosted = new Float32Array(data.packedData);
      for (let i = 0; i < boosted.length; i += 4) {
        boosted[i] *= 2;
        boosted[i + 2] *= 2;
      }
      const before = v.render(true);
      v.renderer.setFBOData(boosted);
      const after = v.render(true);
      expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
      expect(maxChannelDiff(after, v.render(false))).toBeLessThanOrEqual(1);
    });

    it("follows patchFBOData over its ranges alone", () => {
      const v = view(data);
      const patched = new Float32Array(data.packedData);
      const pixels = 20;
      for (let i = 0; i < pixels * 4; i += 4) {
        patched[i] = 0.9;
        patched[i + 2] = 0.9;
      }
      const before = v.render(true);
      v.renderer.patchFBOData(patched, Uint32Array.of(0, pixels));
      const after = v.render(true);
      expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
      expect(maxChannelDiff(after, v.render(false))).toBeLessThanOrEqual(1);
    });
  });

  describe("on a dyadic layout", () => {
    const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 4 });
    // Zoomed far enough in that one screen pixel covers less than one frame, so
    // the finest level is chosen and has to agree with the canvas exactly.
    const FINE_ZOOM = 8;

    it("picks the finest level at that zoom", () => {
      const v = view(data);
      const pyramid = v.renderer.getDisplayPyramid();
      expect(pyramid).not.toBeNull();
      const framesPerPixel = data.numFrames / (2 ** FINE_ZOOM * WIDTH);
      expect(displayLevelChoice(pyramid!.levels, framesPerPixel).fine).toBe(0);
    });

    it("matches the canvas within a grey unit", () => {
      const v = view(data);
      expect(maxChannelDiff(v.render(true, FINE_ZOOM), v.render(false, FINE_ZOOM))).toBeLessThanOrEqual(1);
    });

    it("follows a committed stroke", async () => {
      const v = view(data);
      const before = v.render(true, FINE_ZOOM);
      await paintCommittedStroke(v.renderer, data, -18);
      const after = v.render(true, FINE_ZOOM);
      expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
      expect(maxChannelDiff(after, v.render(false, FINE_ZOOM))).toBeLessThanOrEqual(1);
    });

    it("stays close to the canvas at whole-file zoom, where it shows a coarser level", () => {
      const v = view(data);
      expect(maxChannelDiff(v.render(true, 0), v.render(false, 0))).toBeLessThanOrEqual(24);
    });
  });
});
