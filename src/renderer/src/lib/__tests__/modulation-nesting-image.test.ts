import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

function createTexturesFromSpectrogramData(spectrogramData: SpectrogramData) {
  const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;
  const packedDataTex = new DataTexture(packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
  packedDataTex.internalFormat = "RGBA32F";
  packedDataTex.minFilter = NearestFilter;
  packedDataTex.magFilter = NearestFilter;
  packedDataTex.wrapS = ClampToEdgeWrapping;
  packedDataTex.wrapT = ClampToEdgeWrapping;
  packedDataTex.needsUpdate = true;
  const originalPackedDataTex = packedDataTex.clone();
  originalPackedDataTex.needsUpdate = true;
  const inverseMapTex = new DataTexture(inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
  inverseMapTex.internalFormat = "RG32F";
  inverseMapTex.minFilter = NearestFilter;
  inverseMapTex.magFilter = NearestFilter;
  inverseMapTex.wrapS = ClampToEdgeWrapping;
  inverseMapTex.wrapT = ClampToEdgeWrapping;
  inverseMapTex.needsUpdate = true;
  const metadataTex = new DataTexture(metadata, numBands, 1, RGBAFormat, FloatType);
  metadataTex.internalFormat = "RGBA32F";
  metadataTex.minFilter = NearestFilter;
  metadataTex.magFilter = NearestFilter;
  metadataTex.wrapS = ClampToEdgeWrapping;
  metadataTex.wrapT = ClampToEdgeWrapping;
  metadataTex.needsUpdate = true;
  return { packedDataTex, originalPackedDataTex, inverseMapTex, metadataTex };
}

function createPlaceholderTexture(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

// A 16x1 horizontal step image: left half = 0, right half = 1 in the red channel.
function createStepImageTexture(): DataTexture {
  const w = 16;
  const data = new Float32Array(w * 4);
  for (let i = 0; i < w; i++) {
    const v = i < w / 2 ? 0 : 1;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, w, 1, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// A 16x1 uniform image: every texel = 0.5 in the red channel (no spatial detail).
function createFlatImageTexture(): DataTexture {
  const w = 16;
  const data = new Float32Array(w * 4);
  for (let i = 0; i < w; i++) {
    data[i * 4] = 0.5;
    data[i * 4 + 1] = 0.5;
    data[i * 4 + 2] = 0.5;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, w, 1, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { dynamicsEffect }, { blurEffect }, { synthesizeEffect }, { passThroughEffect }] =
    await Promise.all([
      import("../../effects/transform-effect"),
      import("../../effects/dynamics-effect"),
      import("../../effects/blur-effect"),
      import("../../effects/synthesize-effect"),
      import("../../effects/passthrough-effect"),
    ]);
  return {
    transform: transformEffect,
    dynamics: dynamicsEffect,
    blur: blurEffect,
    synthesize: synthesizeEffect,
    passthrough: passThroughEffect,
  };
}

const effectsList = [
  { id: "t", effect: "transform" as const, enabled: true, params: {} },
  { id: "d", effect: "dynamics" as const, enabled: false, params: {} },
  { id: "b", effect: "blur" as const, enabled: false, params: {} },
  { id: "s", effect: "synthesize" as const, enabled: false, params: {} },
];

function strokeParams(totalDuration: number): StrokeParams {
  return {
    cursorPos: new Vector2(0, 0),
    preview: false,
    bpm: 120,
    totalDuration,
    viewZoomPower: 0,
    viewOffset: 0,
    viewZoomPowerY: 0,
    viewOffsetY: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
  };
}

describe("modulation: nested + image", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTexturesFromSpectrogramData>;
  let placeholderTexture: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    spectrogramData = createMockSpectrogramData({ numFrames: 32, numBands: 8, pattern: "gradient" });
    textures = createTexturesFromSpectrogramData(spectrogramData);
    placeholderTexture = createPlaceholderTexture();
  });

  afterEach(() => {
    gl.dispose();
  });

  function makeRenderer(modulator1Texture: DataTexture): StrokeRenderer {
    const strokeTextures: StrokeTextures = {
      originalPackedDataTex: textures.originalPackedDataTex,
      inverseMapTex: textures.inverseMapTex,
      metadataTex: textures.metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const r = new StrokeRenderer(gl, spectrogramData, strokeTextures, "diag", effects);
    r.initialize();
    return r;
  }

  function sourceFile(r: StrokeRenderer): SourceFileInfo {
    const t = r.getTextures();
    return {
      id: "diag",
      filePath: "/test/diag.wav",
      displayName: "diag.wav",
      spectrogramData,
      textures: { packed: t.packed, inverse: t.inverse, metadata: t.metadata, original: t.original },
    };
  }

  function imageState(): State {
    return createMockStateWithSteps(
      [
        {
          name: "img",
          overrides: {
            brushIntensity: 100,
            brushSizeTime: 10,
            brushSizePitch: 100,
            brushCurveTime: 100,
            brushSkewTime: -100,
            brushCurvePitch: 100,
            brushSkewPitch: -100,
            accumulate: true,
            blendMode: 1,
            modulator1Mode: 0,
            modulator1PatternShape: 12, // IMAGE
            modulator1PatternRateBeats: 0.001, // tiles across the short canvas
            modulator1PatternRateSemis: 1,
            modulator1Strength: 100,
            brushIntensityMod1Amount: 100,
            effects: effectsList,
          },
        },
      ],
      { filepathsBpm: { "/test/diag.wav": 120 } },
    ) as State;
  }

  function maxAbsDiff(a: Float32Array, b: Float32Array): number {
    let d = 0;
    for (let i = 0; i < a.length; i += 4) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
  }

  it("IMAGE modulator output reflects the image content (shader path)", async () => {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    // Same routing, two different images: a spatially varying step image vs a
    // flat one. If the image is actually sampled, the painted outputs differ.
    const stepR = makeRenderer(createStepImageTexture());
    stepR.renderStroke(strokeParams(totalDuration), imageState(), sourceFile(stepR));
    const stepData = await stepR.getFBOData();
    stepR.dispose();

    const flatR = makeRenderer(createFlatImageTexture());
    flatR.renderStroke(strokeParams(totalDuration), imageState(), sourceFile(flatR));
    const flatData = await flatR.getFBOData();
    flatR.dispose();

    expect(maxAbsDiff(stepData, flatData)).toBeGreaterThan(1e-3);
  });

  it("updateModulatorTextures delivers a late-loaded image to the renderer", async () => {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    // Construct with the zero placeholder (mirrors a renderer built before the
    // image finished loading), then deliver the image after the fact.
    const renderer = makeRenderer(placeholderTexture);
    renderer.renderStroke(strokeParams(totalDuration), imageState(), sourceFile(renderer));
    const beforeUpdate = await renderer.getFBOData();

    renderer.updateModulatorTextures(createStepImageTexture(), placeholderTexture, placeholderTexture);
    renderer.renderStroke(strokeParams(totalDuration), imageState(), sourceFile(renderer));
    const afterUpdate = await renderer.getFBOData();

    // The delivered image changes the painted result; without the update the
    // renderer would keep sampling the zero placeholder.
    expect(maxAbsDiff(beforeUpdate, afterUpdate)).toBeGreaterThan(1e-3);
    renderer.dispose();
  });

  it("nested modulation: modulator1 -> modulator2 changes output vs no nesting", async () => {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    // Common base: modulator2 (sine) drives brushIntensity. Its baseline depth
    // is zero, so on its own it outputs a flat 0.5 with no spatial variation.
    // modulator1 is a spatially varying sawtooth whose only job is to nest into
    // modulator2's depth, turning that flat output into a varying one.
    const baseOverrides = {
      brushIntensity: 100,
      brushSizeTime: 10,
      brushSizePitch: 100,
      brushCurveTime: 100,
      brushSkewTime: -100,
      brushCurvePitch: 100,
      brushSkewPitch: -100,
      accumulate: true,
      blendMode: 1,
      modulator1Mode: 0,
      modulator1PatternShape: 3, // Sawtooth
      modulator1PatternRateBeats: 0.001, // tiny rate => cycles across the short canvas
      modulator1PatternRateSemis: 1,
      modulator1Strength: 100,
      modulator2Mode: 0,
      modulator2PatternShape: 0, // Sine
      modulator2PatternRateBeats: 0.001,
      modulator2PatternRateSemis: 1,
      modulator2Strength: 0, // flat without nesting
      brushIntensityMod2Amount: 100,
      effects: effectsList,
    };

    // Global state mirrors the real store: every modulator mod-amount key exists
    // and is zero (createModulatorsSlice), so the routing detector reading global
    // state sees no nested routing. The actual routing lives only on the step.
    // Imported dynamically to avoid the store's load-time circular dependency.
    const { createModulatorsSlice } = await import("../../store/modulators");
    const zeroGlobal = createModulatorsSlice() as unknown as Record<string, number>;

    function render(nested: boolean): Promise<Float32Array> {
      const renderer = makeRenderer(placeholderTexture);
      const state = createMockStateWithSteps(
        [
          {
            name: "nest",
            overrides: {
              ...baseOverrides,
              modulator2StrengthMod1Amount: nested ? 100 : 0,
            },
          },
        ],
        { filepathsBpm: { "/test/diag.wav": 120 }, ...zeroGlobal },
      ) as State;
      renderer.renderStroke(strokeParams(totalDuration), state, sourceFile(renderer));
      return renderer.getFBOData().finally(() => renderer.dispose());
    }

    const withoutNested = await render(false);
    const withNested = await render(true);

    let maxDiff = 0;
    for (let i = 0; i < withoutNested.length; i += 4) {
      maxDiff = Math.max(maxDiff, Math.abs(withoutNested[i] - withNested[i]));
    }

    // Nesting modulator1 into modulator2's depth must change the painted result.
    expect(maxDiff).toBeGreaterThan(1e-4);
  });
});
