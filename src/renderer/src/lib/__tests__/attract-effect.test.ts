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

import { EffectItem } from "../../effects/types";
import { createEffectStateView } from "../../store";
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

// Attract params go on the effect item and the rest on the step, matching
// where the app's parameter store writes each kind.
function createAttractState(params: Record<string, number>): State {
  const effectParams: Record<string, number> = {};
  const stepParams: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("attract")) effectParams[key] = value;
    else stepParams[key] = value;
  }
  const effects = [{ id: "test-attract", effect: "attract" as const, enabled: true, params: effectParams }];
  const state = createMockState({
    effects,
    filepathsBpm: { "/test/attract-test.wav": 120 },
    ...stepParams,
  });
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    const step = activeSteps[0] as unknown as Record<string, unknown>;
    step.effects = effects;
    Object.assign(step, stepParams);
  }
  return state;
}

function totalEnergy(data: Float32Array): number {
  let e = 0;
  for (let i = 0; i < data.length; i += 4) {
    e += data[i] * data[i] + data[i + 2] * data[i + 2];
  }
  return e;
}

describe("Attract effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTexturesFromSpectrogramData>;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    const [{ attractEffect }, { passThroughEffect }] = await Promise.all([
      import("../../effects/attract-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { attract: attractEffect, passthrough: passThroughEffect };

    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);

    // A low sample rate stretches the mock's duration to a fraction of a
    // second so brush-anchored phase ramps accumulate measurably.
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
      originalPackedDataTex: textures.originalPackedDataTex,
      inverseMapTex: textures.inverseMapTex,
      metadataTex: textures.metadataTex,
      placeholderTexture,
      modulatorScaleLut,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "attract-test", effects);
    renderer.initialize();
    return renderer;
  }

  function createSourceFile(renderer: StrokeRenderer): SourceFileInfo {
    const rendererTextures = renderer.getTextures();
    return {
      id: "attract-test",
      filePath: "/test/attract-test.wav",
      displayName: "attract-test.wav",
      spectrogramData,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };
  }

  function strokeParams(): StrokeParams {
    return {
      cursorPos: new Vector2(0.0, 0.0),
      preview: false,
      bpm: 120,
      totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };
  }

  it("is an identity when both pulls are zero", async () => {
    const renderer = createRenderer();
    const state = createAttractState({ attractMap: 1, attractAmountX: 0, attractAmountY: 0 });
    const sourceFile = createSourceFile(renderer);

    const initialData = await renderer.getFBOData();
    renderer.renderStroke(strokeParams(), state, sourceFile);
    const outputData = await renderer.getFBOData();

    let maxDelta = 0;
    for (let i = 0; i < outputData.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(outputData[i] - initialData[i]));
    }
    expect(maxDelta).toBeLessThan(1e-6);

    renderer.dispose();
  });

  it("pulls energy toward a modulator pattern's bright regions", async () => {
    const renderer = createRenderer();
    const state = createAttractState({
      attractMap: 3,
      attractAmountX: 0,
      attractAmountY: 100,
      attractSmoothY: 2,
      modulator1Mode: 0,
      modulator1PatternShape: 0,
      modulator1PatternRateSemis: 12,
      modulator1PatternRateBeats: 0,
    });
    const sourceFile = createSourceFile(renderer);

    const initialData = await renderer.getFBOData();
    renderer.renderStroke(strokeParams(), state, sourceFile);
    const outputData = await renderer.getFBOData();

    let changed = 0;
    let sawNaN = false;
    for (let i = 0; i < outputData.length; i += 4) {
      if (Number.isNaN(outputData[i]) || Number.isNaN(outputData[i + 1])) sawNaN = true;
      if (Math.abs(outputData[i] - initialData[i]) > 1e-4) changed++;
    }

    expect(sawNaN).toBe(false);
    expect(changed).toBeGreaterThan(100);

    const ratio = totalEnergy(outputData) / totalEnergy(initialData);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);

    renderer.dispose();
  });

  it("moves energy toward scale valleys without creating or destroying it wholesale", async () => {
    const renderer = createRenderer();
    const state = createAttractState({
      attractMap: 1,
      attractAmountX: 0,
      attractAmountY: 100,
      attractSmoothY: 2,
    });
    const sourceFile = createSourceFile(renderer);

    const initialData = await renderer.getFBOData();
    renderer.renderStroke(strokeParams(), state, sourceFile);
    const outputData = await renderer.getFBOData();

    let changed = 0;
    let sawNaN = false;
    for (let i = 0; i < outputData.length; i += 4) {
      if (Number.isNaN(outputData[i]) || Number.isNaN(outputData[i + 1])) sawNaN = true;
      if (Math.abs(outputData[i] - initialData[i]) > 1e-4) changed++;
    }

    expect(sawNaN).toBe(false);
    expect(changed).toBeGreaterThan(100);

    const ratio = totalEnergy(outputData) / totalEnergy(initialData);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);

    renderer.dispose();
  });

  it("skips the pitch pass when the pitch pull is zero", async () => {
    const { attractEffect } = await import("../../effects/attract-effect");
    const state = createAttractState({ attractMap: 0, attractAmountX: 100, attractAmountY: 0 });
    const step = state.brushes[state.activeBrushIndex]?.steps?.[0] as unknown as { effects: EffectItem[] };
    const passes = attractEffect.getActivePasses?.(createEffectStateView(state, 0, step.effects[0]));
    expect(passes).toEqual([1]);
  });

  it("keeps a time-only pull from carving band-dependent energy structure", async () => {
    textures.packedDataTex.dispose();
    textures.originalPackedDataTex.dispose();
    textures.inverseMapTex.dispose();
    textures.metadataTex.dispose();
    spectrogramData = createMockSpectrogramData({
      numFrames: 256,
      numBands: 32,
      sampleRate: 1000,
      pattern: "sine",
    });
    textures = createTexturesFromSpectrogramData(spectrogramData);

    const renderer = createRenderer();
    const state = createAttractState({
      attractMap: 0,
      attractAmountX: 100,
      attractAmountY: 0,
      attractSmoothX: 0.05,
    });
    const sourceFile = createSourceFile(renderer);

    const initialData = await renderer.getFBOData();
    renderer.renderStroke(strokeParams(), state, sourceFile);
    const outputData = await renderer.getFBOData();

    const { numFrames, numBands } = spectrogramData;
    const ratios: number[] = [];
    let changed = 0;
    for (let band = 0; band < numBands; band++) {
      let eBefore = 0;
      let eAfter = 0;
      let bandChanged = false;
      for (let frame = 0; frame < numFrames; frame++) {
        const i = (band * numFrames + frame) * 4;
        eBefore += initialData[i] * initialData[i];
        eAfter += outputData[i] * outputData[i];
        if (Math.abs(outputData[i] - initialData[i]) > 1e-4) {
          changed++;
          bandChanged = true;
        }
      }
      if (bandChanged && eBefore > 1e-9) ratios.push(eAfter / eBefore);
    }

    expect(changed).toBeGreaterThan(0);
    expect(ratios.length).toBeGreaterThan(4);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);
    expect(minRatio).toBeGreaterThan(0.95);
    expect(maxRatio / minRatio).toBeLessThan(1.05);

    renderer.dispose();
  });
});
