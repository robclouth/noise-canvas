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

/**
 * Creates WebGL textures from SpectrogramData for testing.
 */
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

/**
 * Creates a placeholder texture for testing.
 */
function createPlaceholderTexture(): DataTexture {
  const data = new Float32Array(4);
  const tex = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a modulator scale LUT texture for testing.
 */
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

type EffectType = "transform" | "dynamics" | "blur" | "overtones" | "synthesize" | "passthrough";

/**
 * Creates a state configured for a specific effect.
 */
function createStateForEffect(effectType: EffectType): State {
  const effectOrder = [
    { effect: "transform" as const, enabled: effectType === "transform" },
    { effect: "dynamics" as const, enabled: effectType === "dynamics" },
    { effect: "blur" as const, enabled: effectType === "blur" },
    { effect: "overtones" as const, enabled: effectType === "overtones" },
    { effect: "synthesize" as const, enabled: effectType === "synthesize" },
  ];

  // Use createMockState with minimal overrides - let it use the default step
  const state = createMockState({
    effectOrder,
    filepathsBpm: {
      "/test/effects-test.wav": 120,
    },
  });

  // Update the step's effectOrder in the active slot
  const activeSlot = state.slots[state.activeSlotIndex];
  if (activeSlot && activeSlot[0]) {
    (activeSlot[0] as any).effectOrder = effectOrder;
  }

  return state;
}

/**
 * Checks if the output data contains any non-zero magnitude values.
 */
function hasNonZeroMagnitudes(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i += 4) {
    const magL = data[i]; // R channel = left magnitude
    const magR = data[i + 2]; // B channel = right magnitude
    if (magL > 1e-6 || magR > 1e-6) {
      return true;
    }
  }
  return false;
}

/**
 * Dynamically loads the effects module to avoid circular dependency at module load time.
 */
async function loadEffects(): Promise<EffectsRegistry> {
  const [
    { transformEffect },
    { dynamicsEffect },
    { blurEffect },
    { overtonesEffect },
    { synthesizeEffect },
    { passThroughEffect },
  ] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/blur-effect"),
    import("../../effects/overtones-effect"),
    import("../../effects/synthesize-effect"),
    import("../../effects/passthrough-effect"),
  ]);

  return {
    transform: transformEffect,
    dynamics: dynamicsEffect,
    blur: blurEffect,
    overtones: overtonesEffect,
    synthesize: synthesizeEffect,
    passthrough: passThroughEffect,
  };
}

describe("Effects", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: {
    packedDataTex: DataTexture;
    originalPackedDataTex: DataTexture;
    inverseMapTex: DataTexture;
    metadataTex: DataTexture;
  };
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    // Load effects dynamically to avoid circular dependency
    effects = await loadEffects();

    // Create WebGL renderer
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);

    // Create spectrogram data with non-zero values
    spectrogramData = createMockSpectrogramData({
      numFrames: 16,
      numBands: 8,
      pattern: "gradient", // Creates non-zero magnitude values
    });

    // Create textures
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

  /**
   * Helper to create a StrokeRenderer with real effects.
   */
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

    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "effects-test", effects);
    renderer.initialize();
    return renderer;
  }

  /**
   * Helper to create source file info.
   */
  function createSourceFile(renderer: StrokeRenderer): SourceFileInfo {
    const rendererTextures = renderer.getTextures();
    return {
      id: "effects-test",
      filePath: "/test/effects-test.wav",
      spectrogramData,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };
  }

  describe("non-black output", () => {
    it("transform effect should not produce black output", async () => {
      const renderer = createRenderer();
      const state = createStateForEffect("transform");
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      // Get initial data to verify it has content
      const initialData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(initialData)).toBe(true);

      // Apply stroke with transform effect
      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      // Get output data
      const outputData = await renderer.getFBOData();

      // Verify output is not all black
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("dynamics effect should not produce black output", async () => {
      const renderer = createRenderer();
      const state = createStateForEffect("dynamics");
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("blur effect should not produce black output", async () => {
      const renderer = createRenderer();
      const state = createStateForEffect("blur");
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("overtones effect should not produce black output", async () => {
      const renderer = createRenderer();
      const state = createStateForEffect("overtones");
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("synthesize effect should not produce black output", async () => {
      const renderer = createRenderer();
      const state = createStateForEffect("synthesize");
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("passthrough effect should not produce black output", async () => {
      const renderer = createRenderer();
      // Passthrough is used when no effects are enabled
      const effectOrder = [
        { effect: "transform" as const, enabled: false },
        { effect: "dynamics" as const, enabled: false },
        { effect: "blur" as const, enabled: false },
        { effect: "overtones" as const, enabled: false },
        { effect: "synthesize" as const, enabled: false },
      ];
      const state = createMockState({
        effectOrder,
        filepathsBpm: {
          "/test/effects-test.wav": 120,
        },
      });
      // Update the step's effectOrder in the active slot
      const activeSlot = state.slots[state.activeSlotIndex];
      if (activeSlot && activeSlot[0]) {
        (activeSlot[0] as any).effectOrder = effectOrder;
      }
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const params: StrokeParams = {
        cursorPos: new Vector2(0.0, 0.0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });
  });
});
