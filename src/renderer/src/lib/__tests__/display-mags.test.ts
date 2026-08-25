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
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import type { State } from "../../store/types";
import { createMockStateWithSteps } from "../../test/mock-state";
import {
  createHarnessTextures,
  createSourceFile,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
} from "../../test/render-harness";
import type { EffectsRegistry, StrokeRenderer as StrokeRendererType } from "../stroke-renderer";
import { StrokeRenderer } from "../stroke-renderer";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "../utils";

/**
 * The display's committed base is the RG16F dB texture the stroke renderer
 * re-encodes at every committed write. Rendering the real display shader from
 * it must match rendering from the full-precision canvas within the dB
 * quantisation step, after every kind of write.
 */

const WIDTH = 96;
const HEIGHT = 48;

describe("display mags parity", () => {
  const spectrogramData = createMockSpectrogramData({ numFrames: 16, numBands: 8, pattern: "gradient" });

  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let textures: ReturnType<typeof createHarnessTextures>;
  let renderer: StrokeRendererType;
  let material: RawShaderMaterial;
  let scene: Scene;
  let camera: OrthographicCamera;
  let target: WebGLRenderTarget;

  beforeAll(async () => {
    const [dy, pt] = await Promise.all([
      import("../../effects/dynamics-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { dynamics: dy.dynamicsEffect, passthrough: pt.passThroughEffect } as EffectsRegistry;

    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(WIDTH, HEIGHT);

    textures = createHarnessTextures(spectrogramData);
    renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "display-mags-test", effects);
    renderer.initialize();

    material = new RawShaderMaterial({
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
        displayMagsTex: { value: null },
        displayMagsActive: { value: false },
      },
      vertexShader: passThroughVert,
      fragmentShader: displayFrag,
      glslVersion: GLSL3,
    });

    scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(2, 2), material);
    scene.add(mesh);
    camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    target = new WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: false, stencilBuffer: false });
  });

  afterAll(() => {
    target.dispose();
    material.dispose();
    renderer.dispose();
    disposeHarnessTextures(textures);
    gl.dispose();
  });

  function renderDisplay(fromMags: boolean): Uint8Array {
    const preview = renderer.getPreviewDisplay();
    const u = material.uniforms;
    u.sourceSpectrogramTex.value = preview.committed;
    u.sourceMetadataTex.value = textures.metadataTex;
    u.sourceInverseMapTex.value = textures.inverseMapTex;
    u.sourceMinFreq.value = spectrogramData.minFreq;
    u.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
    u.sourceFrameCount.value = spectrogramData.numFrames;
    u.sourceBandCount.value = spectrogramData.numBands;
    u.sourceChannelCount.value = spectrogramData.numChannels;
    u.sourceSampleRate.value = spectrogramData.sampleRate;
    u.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
    u.displayMagsTex.value = renderer.getDisplayMagsTexture();
    u.displayMagsActive.value = fromMags;

    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    return pixels;
  }

  function maxChannelDiff(a: Uint8Array, b: Uint8Array): number {
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    return max;
  }

  async function paintCommittedStroke(gainDb: number): Promise<void> {
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
    renderer.renderStroke(
      makeStrokeParams(new Vector2(0, 0), spectrogramData),
      state,
      createSourceFile(renderer, spectrogramData),
    );
    await renderer.getFBOData();
  }

  it("matches the canvas within a grey unit before any stroke", () => {
    expect(maxChannelDiff(renderDisplay(true), renderDisplay(false))).toBeLessThanOrEqual(1);
  });

  it("really switches sources on the active flag", () => {
    const fromCanvas = renderDisplay(false);
    const u = material.uniforms;
    const real = renderer.getDisplayMagsTexture();
    u.displayMagsActive.value = true;
    u.displayMagsTex.value = textures.placeholderTexture;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const swapped = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, swapped);
    u.displayMagsTex.value = real;
    expect(maxChannelDiff(fromCanvas, swapped)).toBeGreaterThan(1);
  });

  it("follows a committed stroke", async () => {
    const before = renderDisplay(true);
    await paintCommittedStroke(-24);
    const after = renderDisplay(true);
    expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
    expect(maxChannelDiff(after, renderDisplay(false))).toBeLessThanOrEqual(1);
  });

  it("follows setFBOData", () => {
    const boosted = new Float32Array(spectrogramData.packedData);
    for (let i = 0; i < boosted.length; i += 4) {
      boosted[i] *= 2;
      boosted[i + 2] *= 2;
    }
    const before = renderDisplay(true);
    renderer.setFBOData(boosted);
    const after = renderDisplay(true);
    expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
    expect(maxChannelDiff(after, renderDisplay(false))).toBeLessThanOrEqual(1);
  });

  it("follows patchFBOData over its ranges alone", () => {
    const patched = new Float32Array(spectrogramData.packedData);
    const pixels = 16;
    for (let i = 0; i < pixels * 4; i += 4) {
      patched[i] *= 4;
      patched[i + 2] *= 4;
    }
    const before = renderDisplay(true);
    renderer.patchFBOData(patched, Uint32Array.of(0, pixels));
    const after = renderDisplay(true);
    expect(maxChannelDiff(before, after)).toBeGreaterThan(1);
    expect(maxChannelDiff(after, renderDisplay(false))).toBeLessThanOrEqual(1);
  });
});
