import { describe, expect, it } from "vitest";
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  RGFormat,
  Scene,
  UniformsUtils,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { defaultValues } from "../../effects/base-effect";
import displayFrag from "../../glsl/display.frag";
import passThroughVert from "../../glsl/pass-through.vert";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { FULL_SCALE_DB_OFFSET, FULL_SCALE_MAGNITUDE, OVER_FULL_SCALE_RANGE_DB } from "../constants";
import { withPlatformDefines } from "../shader-utils";
import type { SpectrogramData } from "../../store/types";

const WIDTH = 256;
const HEIGHT = 128;
const NUM_FRAMES = 64;
const NUM_BANDS = 32;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function makeTexture(
  data: Float32Array,
  width: number,
  height: number,
  format: typeof RGBAFormat | typeof RGFormat | typeof RedFormat,
  internalFormat: "RGBA32F" | "RG32F" | "R32F",
): DataTexture {
  const texture = new DataTexture(data, width, height, format, FloatType);
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Renders the display shader over mock data and returns a sampler for reading
 * back the colour at a given (band, frame) position.
 */
function renderDisplay(
  spectrogramData: SpectrogramData,
  attribution: Float32Array | null,
  showClipping = true,
): (band: number, frame: number) => Rgb {
  const { textureWidth, textureHeight, numBands, numFrames } = spectrogramData;
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setSize(WIDTH, HEIGHT, false);

  const material = new RawShaderMaterial({
    uniforms: {
      ...UniformsUtils.clone(defaultValues),
      sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
      minDb: { value: -70 },
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
      targetRectPulse: { value: 0 },
      targetRectColor: { value: new Vector2(0, 0) },
      sourceSamplingBottomLeftUv: { value: new Vector2(-1, -1) },
      viewZoomPower: { value: 0 },
      viewOffset: { value: 0 },
      viewZoomPowerY: { value: 0 },
      viewOffsetY: { value: 0 },
      wrapMode: { value: 0 },
      fullScaleDbOffset: { value: FULL_SCALE_DB_OFFSET },
      overFullScaleRangeDb: { value: OVER_FULL_SCALE_RANGE_DB },
      clipAttributionTex: {
        value: makeTexture(
          attribution ?? new Float32Array(textureWidth * textureHeight),
          textureWidth,
          textureHeight,
          RedFormat,
          "R32F",
        ),
      },
      showClipping: { value: showClipping },
      hasClipAttribution: { value: attribution !== null },
    },
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(displayFrag),
    glslVersion: GLSL3,
  });

  material.uniforms.sourceSpectrogramTex.value = makeTexture(
    spectrogramData.packedData,
    textureWidth,
    textureHeight,
    RGBAFormat,
    "RGBA32F",
  );
  material.uniforms.sourceInverseMapTex.value = makeTexture(
    spectrogramData.inverseMap,
    textureWidth,
    textureHeight,
    RGFormat,
    "RG32F",
  );
  material.uniforms.sourceMetadataTex.value = makeTexture(spectrogramData.metadata, numBands, 1, RGBAFormat, "RGBA32F");
  material.uniforms.sourceFrameCount.value = numFrames;
  material.uniforms.sourceBandCount.value = numBands;
  material.uniforms.sourceChannelCount.value = 1;
  material.uniforms.sourceSampleRate.value = spectrogramData.sampleRate;
  material.uniforms.sourceMinFreq.value = spectrogramData.minFreq;
  material.uniforms.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
  material.uniforms.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;

  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  const target = new WebGLRenderTarget(WIDTH, HEIGHT);
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));

  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  renderer.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
  renderer.dispose();

  return (band: number, frame: number): Rgb => {
    // Band 0 is the highest frequency and sits at the top of the image; the
    // pixel buffer starts at the bottom row.
    const uvY = 1 - (band + 0.5) / numBands;
    const x = Math.floor(((frame + 0.5) / numFrames) * WIDTH);
    const y = Math.floor(uvY * HEIGHT);
    const i = (y * WIDTH + x) * 4;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
  };
}

/** Mock spectrogram with a uniform magnitude everywhere. */
function flatSpectrogram(magnitude: number): SpectrogramData {
  return createMockSpectrogramData({
    numFrames: NUM_FRAMES,
    numBands: NUM_BANDS,
    numChannels: 1,
    pattern: "constant",
    constantMagnitude: magnitude,
  });
}

describe("display shader: absolute level calibration", () => {
  it("keeps a coefficient at full scale free of the over-scale tint", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 0.5);
    const sample = renderDisplay(data, null);
    const { r, g, b } = sample(16, 32);

    // Comfortably below full scale, so it must stay neutral grey.
    expect(Math.abs(r - g)).toBeLessThan(12);
    expect(Math.abs(g - b)).toBeLessThan(12);
  });

  it("tints a coefficient that exceeds full scale", () => {
    // Well past the calibrated full-scale magnitude.
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 4);
    const sample = renderDisplay(data, null);
    const { r, g, b } = sample(16, 32);

    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
  });
});

describe("display shader: clipping overlay", () => {
  /** Attribution map with a positive block and a negative block. */
  function attributionMap(data: SpectrogramData): Float32Array {
    const map = new Float32Array(data.textureWidth * data.textureHeight);
    for (let frame = 0; frame < 20; frame++) map[10 * NUM_FRAMES + frame] = 1;
    for (let frame = 40; frame < 60; frame++) map[20 * NUM_FRAMES + frame] = -1;
    return map;
  }

  it("marks coefficients that drive the peak outwards in red", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 0.4);
    const sample = renderDisplay(data, attributionMap(data));
    const { r, g, b } = sample(10, 10);

    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
  });

  it("marks coefficients that hold the peak back in cyan", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 0.4);
    const sample = renderDisplay(data, attributionMap(data));
    const { r, g, b } = sample(20, 50);

    expect(g).toBeGreaterThan(r + 10);
    expect(b).toBeGreaterThan(r + 10);
  });

  it("leaves unattributed coefficients neutral", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 0.4);
    const sample = renderDisplay(data, attributionMap(data));
    const { r, g, b } = sample(25, 10);

    expect(Math.abs(r - g)).toBeLessThan(12);
    expect(Math.abs(g - b)).toBeLessThan(12);
  });

  it("draws nothing when the overlay is off", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 0.4);
    const sample = renderDisplay(data, attributionMap(data), false);
    const { r, g, b } = sample(10, 10);

    expect(Math.abs(r - g)).toBeLessThan(12);
    expect(Math.abs(g - b)).toBeLessThan(12);
  });

  it("leaves an over-full-scale coefficient untinted while the overlay is off", () => {
    const data = flatSpectrogram(FULL_SCALE_MAGNITUDE * 4);
    const sample = renderDisplay(data, null, false);
    const { r, g, b } = sample(16, 32);

    // The magnitude tint answers to the toggle, not just to the attribution map.
    expect(Math.abs(r - g)).toBeLessThan(12);
    expect(Math.abs(g - b)).toBeLessThan(12);
  });
});
