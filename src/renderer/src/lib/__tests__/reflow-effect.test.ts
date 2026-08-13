import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

function createTexturesFromSpectrogramData(spectrogramData: SpectrogramData): {
  packedDataTex: DataTexture;
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
} {
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
  const data = new Float32Array(4);
  const tex = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

function createModulatorScaleLut(): DataTexture {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = i / 255;
    data[i * 4 + 1] = i / 255;
    data[i * 4 + 2] = i / 255;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

const REFLOW_STEP_PARAMS = {
  reflowMode: 1,
  reflowAmount: 100,
  reflowPitch: -12,
  reflowStretch: 1,
  reflowReach: 48,
};

function createReflowState(): State {
  const effects = [{ id: "test-reflow", effect: "reflow" as const, enabled: true, params: {} }];
  const state = createMockState({
    effects,
    filepathsBpm: { "/test/reflow-test.wav": 120 },
    ...REFLOW_STEP_PARAMS,
  });
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    const step = activeSteps[0] as unknown as Record<string, unknown>;
    step.effects = effects;
    Object.assign(step, REFLOW_STEP_PARAMS);
  }
  return state;
}

describe("Reflow effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTexturesFromSpectrogramData>;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    const [{ reflowEffect }, { passThroughEffect }] = await Promise.all([
      import("../../effects/reflow-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { reflow: reflowEffect, passthrough: passThroughEffect };

    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);

    // A low sample rate stretches the mock's duration to a fraction of a
    // second, so the retune's phase ramp accumulates measurably across frames.
    spectrogramData = createMockSpectrogramData({
      numFrames: 256,
      numBands: 32,
      sampleRate: 1000,
      pattern: "constant",
      constantMagnitude: 0.5,
    });

    textures = createTexturesFromSpectrogramData(spectrogramData);
    placeholderTexture = createPlaceholderTexture();
    modulatorScaleLut = createModulatorScaleLut();
  });

  afterEach(() => {
    gl.dispose();
    textures.packedDataTex.dispose();
    textures.originalPackedDataTex.dispose();
    textures.inverseMapTex.dispose();
    textures.metadataTex.dispose();
    placeholderTexture.dispose();
    modulatorScaleLut.dispose();
  });

  function createRenderer(): StrokeRenderer {
    const strokeTextures: StrokeTextures = {
      packedDataTex: textures.packedDataTex,
      originalPackedDataTex: textures.originalPackedDataTex,
      inverseMapTex: textures.inverseMapTex,
      metadataTex: textures.metadataTex,
      placeholderTexture,
      modulatorScaleLut,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "reflow-test", effects);
    renderer.initialize();
    return renderer;
  }

  function createSourceFile(renderer: StrokeRenderer): SourceFileInfo {
    const rendererTextures = renderer.getTextures();
    return {
      id: "reflow-test",
      filePath: "/test/reflow-test.wav",
      displayName: "reflow-test.wav",
      spectrogramData,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };
  }

  it("shifts phases toward the target pitch while leaving magnitudes untouched", async () => {
    const renderer = createRenderer();
    const state = createReflowState();
    const sourceFile = createSourceFile(renderer);
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    const initialData = await renderer.getFBOData();

    const params: StrokeParams = {
      cursorPos: new Vector2(0.0, 0.0),
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
    renderer.renderStroke(params, state, sourceFile);

    const outputData = await renderer.getFBOData();

    let changedPhases = 0;
    let maxMagDelta = 0;
    let sawContent = false;
    for (let i = 0; i < outputData.length; i += 4) {
      const magL0 = initialData[i];
      if (magL0 > 1e-6) sawContent = true;
      maxMagDelta = Math.max(
        maxMagDelta,
        Math.abs(outputData[i] - magL0),
        Math.abs(outputData[i + 2] - initialData[i + 2]),
      );
      if (magL0 > 1e-6 && Math.abs(outputData[i + 1] - initialData[i + 1]) > 0.05) {
        changedPhases++;
      }
    }

    expect(sawContent).toBe(true);
    expect(maxMagDelta).toBeLessThan(1e-3);
    expect(changedPhases).toBeGreaterThan(100);

    renderer.dispose();
  });
});
