import {
  Color,
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
  Texture,
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
      displayTileTex: { value: null },
      displayTileMetaTex: { value: null },
      displayTileFirst: { value: 0 },
      displayTileCount: { value: 0 },
      displayTileSlots: { value: 1 },
      displayTileTexels: { value: 0 },
      displayTileBlend: { value: 0 },
      displayTileLevel: { value: 0 },
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
  function render(fromPyramid: boolean, zoomPower = 0, sourceTex?: Texture, offset = 0): Uint8Array {
    const preview = renderer.getPreviewDisplay();
    const u = material.uniforms;
    u.sourceSpectrogramTex.value = sourceTex ?? preview.committed;
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
    u.viewOffset.value = offset;

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
    u.displayTileCount.value = 0;

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

  /**
   * Renders from the tile ring, the way the app holds and binds it.
   * `shrinkWindow` narrows the window the shader is told about, so a view
   * reaches past the tiles the ring holds.
   */
  function renderFromRing(zoomPower = 0, offset = 0, shrinkWindow = 0): Uint8Array {
    render(false, zoomPower, undefined, offset);
    const ring = renderer.getDisplayTiles();
    if (!ring) throw new Error("the renderer built no tile ring");
    const zoom = 2 ** zoomPower;
    const span = data.numFrames / zoom;
    const startFrame = zoom > 1 ? offset * (data.numFrames - span) : 0;
    ring.update(
      gl,
      renderer.committedSource(),
      { framesPerPixel: span / WIDTH, startFrame, endFrame: startFrame + span, viewportPixels: WIDTH },
      // Above every level under test, so the ring is never left to the pyramid.
      30,
    );

    const u = material.uniforms;
    const bound = ring.uniforms();
    u.displayTileTex.value = ring.texture();
    u.displayTileMetaTex.value = ring.metadataTexture();
    u.displayTileFirst.value = bound.firstTile;
    u.displayTileCount.value = Math.max(bound.tileCount - shrinkWindow, 0);
    u.displayTileSlots.value = Math.max(1, bound.slotCount);
    u.displayTileTexels.value = bound.tileTexels;
    u.displayTileBlend.value = bound.blend;
    u.displayTileLevel.value = bound.level;

    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    u.displayTileCount.value = 0;
    return pixels;
  }

  function dispose(): void {
    target.dispose();
    material.dispose();
    renderer.dispose();
    disposeHarnessTextures(textures);
  }

  /** The canvas path over the file as it was analysed, whatever the canvas now holds. */
  function renderOriginal(zoomPower = 0): Uint8Array {
    return render(false, zoomPower, textures.originalPackedDataTex);
  }

  return { renderer, material, textures, render, renderAtLevel, renderFromRing, renderOriginal, dispose };
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

  describe("the tile ring", () => {
    const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 4 });
    const FINE_ZOOM = 8;

    // The mock's magnitude is the same everywhere, which hides a bin read from
    // the wrong place; this varies it along the packed layout.
    const varied = Float32Array.from(data.packedData);
    for (let i = 0; i < varied.length / 4; i++) {
      varied[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.37));
      varied[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.11));
    }

    function ringView(): ReturnType<typeof makeView> {
      const made = view(data);
      made.renderer.setFBOData(varied);
      return made;
    }

    it("matches the canvas within a grey unit where its bins are the source's", () => {
      const v = ringView();
      expect(maxChannelDiff(v.renderFromRing(FINE_ZOOM), v.render(false, FINE_ZOOM))).toBeLessThanOrEqual(1);
    });

    it("matches the canvas away from the file's start, where the ring has wrapped", () => {
      const v = ringView();
      expect(
        maxChannelDiff(v.renderFromRing(FINE_ZOOM, 0.5), v.render(false, FINE_ZOOM, undefined, 0.5)),
      ).toBeLessThanOrEqual(1);
      expect(
        maxChannelDiff(v.renderFromRing(FINE_ZOOM, 0.93), v.render(false, FINE_ZOOM, undefined, 0.93)),
      ).toBeLessThanOrEqual(1);
    });

    it("really reads the ring rather than falling through to the canvas", async () => {
      const v = ringView();
      await paintCommittedStroke(v.renderer, data, -18);
      // The canvas sampler is pointed at the file as analysed, so a fall
      // through to it would show the stroke missing.
      expect(maxChannelDiff(v.renderFromRing(FINE_ZOOM), v.renderOriginal(FINE_ZOOM))).toBeGreaterThan(1);
    });

    it("leaves the picture alone while it holds no tile", () => {
      const v = ringView();
      expect(maxChannelDiff(v.renderFromRing(FINE_ZOOM, 0, 99), v.render(false, FINE_ZOOM))).toBe(0);
    });

    it("agrees with the pyramid where both cover the view", () => {
      const v = ringView();
      expect(maxChannelDiff(v.renderFromRing(0), v.render(true, 0))).toBeLessThanOrEqual(1);
      expect(maxChannelDiff(v.renderFromRing(4), v.render(true, 4))).toBeLessThanOrEqual(1);
    });

    it("follows a committed stroke", async () => {
      const v = ringView();
      const before = v.renderFromRing(FINE_ZOOM);
      await paintCommittedStroke(v.renderer, data, -18);
      const after = v.renderFromRing(FINE_ZOOM);
      expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
      expect(maxChannelDiff(after, v.render(false, FINE_ZOOM))).toBeLessThanOrEqual(1);
    });

    it("composites a preview the same way the canvas path does, edges included", () => {
      const v = ringView();
      // Per band, a preview range whose edges fall inside the view, so the
      // interpolation straddles them on screen.
      const viewFrames = data.numFrames / 2 ** FINE_ZOOM;
      const binRanges = new Float32Array(data.numBands * 4);
      for (let band = 0; band < data.numBands; band++) {
        const binsInView = viewFrames / 2 ** data.metadata[band * 4 + 2];
        binRanges[band * 4] = Math.floor(binsInView * 0.25);
        binRanges[band * 4 + 1] = Math.floor(binsInView * 0.7);
      }
      const rangeTex = new DataTexture(binRanges, data.numBands, 1, RGBAFormat, FloatType);
      rangeTex.minFilter = NearestFilter;
      rangeTex.magFilter = NearestFilter;
      rangeTex.needsUpdate = true;

      const u = v.material.uniforms;
      const withPreview = (path: () => Uint8Array): Uint8Array => {
        u.previewActive.value = true;
        u.previewTex.value = v.textures.originalPackedDataTex;
        u.previewBinRangesTex.value = rangeTex;
        const pixels = path();
        u.previewActive.value = false;
        u.previewTex.value = null;
        u.previewBinRangesTex.value = null;
        return pixels;
      };
      const fromRing = withPreview(() => v.renderFromRing(FINE_ZOOM));
      const fromCanvas = withPreview(() => v.render(false, FINE_ZOOM));
      rangeTex.dispose();

      // The preview really shows over the varied canvas.
      expect(maxChannelDiff(fromRing, v.renderFromRing(FINE_ZOOM))).toBeGreaterThan(1);
      expect(maxChannelDiff(fromRing, fromCanvas)).toBeLessThanOrEqual(1);
    });
  });
});
