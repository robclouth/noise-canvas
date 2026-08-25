import {
  Color,
  GLSL3,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
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
import type { State } from "../../store/types";
import { createMockStateWithSteps } from "../../test/mock-state";
import { DisplayMags } from "../display-mags";
import { buildWindowLayout, fileLayoutOf } from "../window-layout";
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
      displayMagsTex: { value: null },
      displayMagsActive: { value: false },
    },
    vertexShader: passThroughVert,
    fragmentShader: displayFrag,
    glslVersion: GLSL3,
  });
}

function maxDiffOf(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

describe("display mags parity", () => {
  const spectrogramData = createMockSpectrogramData({ numFrames: 16, numBands: 8, pattern: "gradient" });

  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let textures: ReturnType<typeof createHarnessTextures>;
  let renderer: StrokeRendererType;
  let displayMags: DisplayMags;
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
    displayMags = new DisplayMags(fileLayoutOf(spectrogramData));
    renderer = new StrokeRenderer(
      gl,
      spectrogramData,
      toStrokeTextures(textures),
      "display-mags-test",
      effects,
      null,
      displayMags,
    );
    renderer.initialize();

    material = createDisplayTestMaterial();

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
    displayMags.dispose();
    disposeHarnessTextures(textures);
    gl.dispose();
  });

  function renderDisplay(fromMags: boolean, magsTexture = renderer.getDisplayMagsTexture()): Uint8Array {
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
    u.displayMagsTex.value = magsTexture;
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

  it("scatters a window canvas into the file positions the whole file writes", async () => {
    const fileLayout = fileLayoutOf(spectrogramData);
    const half = buildWindowLayout(
      fileLayout,
      Math.floor(fileLayout.numFrames / 4),
      Math.floor((fileLayout.numFrames * 3) / 4),
    );
    const halfTextures = createHarnessTextures(spectrogramData, half);
    const halfMags = new DisplayMags(fileLayout);
    const halfRenderer = new StrokeRenderer(
      gl,
      spectrogramData,
      toStrokeTextures(halfTextures),
      "display-mags-window-test",
      effects,
      half,
      halfMags,
    );
    halfRenderer.initialize();

    const before = renderDisplay(true);
    const boosted = new Float32Array(spectrogramData.packedData);
    for (let i = 0; i < boosted.length; i += 4) {
      boosted[i] *= 3;
      boosted[i + 2] *= 3;
    }
    renderer.setFBOData(boosted);
    halfRenderer.setFBOData(boosted);

    const whole = renderDisplay(true);
    const windowed = renderDisplay(true, halfMags.texture());

    // Compare only the columns well inside the window; beyond it the windowed
    // texture holds nothing.
    let maxDiff = 0;
    const x0 = Math.ceil(WIDTH * 0.3);
    const x1 = Math.floor(WIDTH * 0.7);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = x0; x < x1; x++) {
        for (let c = 0; c < 4; c++) {
          const i = (y * WIDTH + x) * 4 + c;
          maxDiff = Math.max(maxDiff, Math.abs(whole[i] - windowed[i]));
        }
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(1);

    expect(maxChannelDiff(before, whole)).toBeGreaterThan(1);

    halfRenderer.dispose();
    halfMags.dispose();
    disposeHarnessTextures(halfTextures);
    renderer.setFBOData(spectrogramData.packedData);
  });

  it("seeds from the CPU packed state exactly as the canvas encode does", () => {
    renderer.setFBOData(spectrogramData.packedData);
    const cpuMags = new DisplayMags(fileLayoutOf(spectrogramData));
    cpuMags.seedFromPacked(gl, spectrogramData.packedData);
    expect(cpuMags.texture()).not.toBeNull();
    expect(maxChannelDiff(renderDisplay(true, cpuMags.texture()), renderDisplay(true))).toBe(0);
    cpuMags.dispose();
  });

  it("patches from the CPU packed state over its ranges alone, split across upload batches", () => {
    const fileLayout = fileLayoutOf(spectrogramData);
    const patched = new Float32Array(spectrogramData.packedData);
    const ranges = Uint32Array.of(0, 13, 20, 9, 40, 25);
    for (let r = 0; r < ranges.length; r += 2) {
      for (let p = ranges[r]; p < ranges[r] + ranges[r + 1]; p++) {
        patched[p * 4] *= 5;
        patched[p * 4 + 2] *= 5;
      }
    }

    const chunked = new DisplayMags(fileLayout, { uploadChunkPixels: 7 });
    chunked.seedFromPacked(gl, spectrogramData.packedData);
    chunked.patchFromPacked(gl, patched, ranges);

    const whole = new DisplayMags(fileLayout);
    whole.seedFromPacked(gl, patched);

    expect(maxChannelDiff(renderDisplay(true, chunked.texture()), renderDisplay(true, whole.texture()))).toBe(0);
    expect(maxChannelDiff(renderDisplay(true, chunked.texture()), renderDisplay(true))).toBeGreaterThan(1);

    chunked.dispose();
    whole.dispose();
  });

  it("skips a patch into an unseeded texture", () => {
    const unseeded = new DisplayMags(fileLayoutOf(spectrogramData));
    unseeded.patchFromPacked(gl, spectrogramData.packedData, Uint32Array.of(0, 16));
    expect(unseeded.texture()).toBeNull();
    unseeded.dispose();
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

describe("windowed preview parity", () => {
  const SAMPLE_RATE = 8000;
  const data = createConstantQMockSpectrogramData({
    durationSeconds: 2,
    sampleRate: SAMPLE_RATE,
    bandsPerOctave: 4,
  });
  const layout = fileLayoutOf(data);
  const wholeFile = buildWindowLayout(layout, 0, layout.numFrames);
  const half = buildWindowLayout(layout, Math.floor(layout.numFrames / 4), Math.floor((layout.numFrames * 3) / 4));

  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let material: RawShaderMaterial;
  let scene: Scene;
  let camera: OrthographicCamera;
  let target: WebGLRenderTarget;
  const disposers: Array<() => void> = [];

  beforeAll(async () => {
    const [dy, pt] = await Promise.all([
      import("../../effects/dynamics-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { dynamics: dy.dynamicsEffect, passthrough: pt.passThroughEffect } as EffectsRegistry;
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(WIDTH, HEIGHT);
    material = createDisplayTestMaterial();
    scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(2, 2), material);
    scene.add(mesh);
    camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    target = new WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: false, stencilBuffer: false });
  });

  afterAll(() => {
    for (const dispose of disposers.reverse()) dispose();
    target.dispose();
    material.dispose();
    gl.dispose();
  });

  function makeRenderer(window: ReturnType<typeof buildWindowLayout>, mags: DisplayMags): StrokeRendererType {
    const textures = createHarnessTextures(data, window);
    const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "preview-window", effects, window, mags);
    renderer.initialize();
    disposers.push(() => {
      renderer.dispose();
      disposeHarnessTextures(textures);
    });
    return renderer;
  }

  function renderPreview(renderer: StrokeRendererType, mags: DisplayMags, fileMetadata: Texture): Uint8Array {
    const pd = renderer.getPreviewDisplay();
    const u = material.uniforms;
    u.sourceSpectrogramTex.value = pd.committed;
    u.sourceMetadataTex.value = fileMetadata;
    u.sourceMinFreq.value = data.minFreq;
    u.sourceBandsPerOctave.value = data.bandsPerOctave;
    u.sourceFrameCount.value = data.numFrames;
    u.sourceBandCount.value = data.numBands;
    u.sourceChannelCount.value = data.numChannels;
    u.sourceSampleRate.value = data.sampleRate;
    u.previewTex.value = pd.preview;
    u.previewBinRangesTex.value = pd.binRanges;
    u.previewActive.value = pd.active;
    u.displayMagsTex.value = mags.texture();
    u.displayMagsActive.value = true;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
    u.previewActive.value = false;
    return pixels;
  }

  it("draws a windowed preview at the same file positions as a whole-file one", () => {
    const wholeMags = new DisplayMags(layout);
    disposers.push(() => wholeMags.dispose());
    const whole = makeRenderer(wholeFile, wholeMags);
    const halfMags = new DisplayMags(layout);
    disposers.push(() => halfMags.dispose());
    const paged = makeRenderer(half, halfMags);
    const wholeTextures = createHarnessTextures(data);
    disposers.push(() => disposeHarnessTextures(wholeTextures));
    const fileMetadata = wholeTextures.metadataTex;

    const state = createMockStateWithSteps([
      {
        name: "Gain",
        overrides: {
          brushIntensity: 100,
          brushSizeTime: 1,
          brushSizePitch: BRUSH_SIZE_PITCH_FULL,
          effects: [{ id: "preview-dyn", effect: "dynamics" as const, enabled: true, params: { dynamicsGainDb: -30 } }],
        },
      },
    ]) as State;

    // A one-beat dab at 0.4 sits well inside the half window, so the whole
    // preview overlay exists in both windows and only its addressing differs.
    for (const renderer of [whole, paged]) {
      renderer.beginStroke();
      renderer.renderStroke(
        makeStrokeParams(new Vector2(0.4, 0), data, { preview: true }),
        state,
        createSourceFile(renderer, data),
      );
    }

    const committed = renderPreview(whole, wholeMags, fileMetadata);
    material.uniforms.previewActive.value = false;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const committedOnly = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, committedOnly);

    // The same committed base under both, so what is compared is the preview
    // overlay's addressing alone.
    const wholePreview = committed;
    const windowedPreview = renderPreview(paged, wholeMags, fileMetadata);

    expect(maxDiffOf(wholePreview, committedOnly)).toBeGreaterThan(1);
    expect(maxDiffOf(wholePreview, windowedPreview)).toBeLessThanOrEqual(1);
  });
});
