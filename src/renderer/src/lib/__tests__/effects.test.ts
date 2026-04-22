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
import { createMockSpectrogramData, getPixelAtUv, readSpectrogramPixel } from "../../test/mock-spectrogram";
import { createMockState, createMockStateWithSteps } from "../../test/mock-state";
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
  const effects = [
    { id: "test-transform", effect: "transform" as const, enabled: effectType === "transform", params: {} },
    { id: "test-dynamics", effect: "dynamics" as const, enabled: effectType === "dynamics", params: {} },
    { id: "test-blur", effect: "blur" as const, enabled: effectType === "blur", params: {} },
    { id: "test-overtones", effect: "overtones" as const, enabled: effectType === "overtones", params: {} },
    { id: "test-synthesize", effect: "synthesize" as const, enabled: effectType === "synthesize", params: {} },
  ];

  // Use createMockState with minimal overrides - let it use the default step
  const state = createMockState({
    effects,
    filepathsBpm: {
      "/test/effects-test.wav": 120,
    },
  });

  // Update the step's effects in the active brush
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    (activeSteps[0] as Record<string, unknown>).effects = effects;
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });

    it("passthrough effect should not produce black output", async () => {
      const renderer = createRenderer();
      // Passthrough is used when no effects are enabled
      const effects = [
        { id: "test-transform", effect: "transform" as const, enabled: false, params: {} },
        { id: "test-dynamics", effect: "dynamics" as const, enabled: false, params: {} },
        { id: "test-blur", effect: "blur" as const, enabled: false, params: {} },
        { id: "test-overtones", effect: "overtones" as const, enabled: false, params: {} },
        { id: "test-synthesize", effect: "synthesize" as const, enabled: false, params: {} },
      ];
      const state = createMockState({
        effects,
        filepathsBpm: {
          "/test/effects-test.wav": 120,
        },
      });
      // Update the step's effects in the active brush
      const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
      if (activeSteps && activeSteps[0]) {
        (activeSteps[0] as Record<string, unknown>).effects = effects;
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
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
      };

      renderer.renderStroke(params, state, sourceFile);

      const outputData = await renderer.getFBOData();
      expect(hasNonZeroMagnitudes(outputData)).toBe(true);

      renderer.dispose();
    });
  });

  describe("non-cumulative strokes with additive blend", () => {
    it("should not accumulate when stroking back and forth with additive blend mode", async () => {
      // Create spectrogram with constant values for predictable testing
      const constantSpectrogramData = createMockSpectrogramData({
        numFrames: 16,
        numBands: 8,
        pattern: "constant",
        constantMagnitude: 0.5,
      });

      const constantTextures = createTexturesFromSpectrogramData(constantSpectrogramData);

      const constantStrokeTextures: StrokeTextures = {
        packedDataTex: constantTextures.packedDataTex,
        originalPackedDataTex: constantTextures.originalPackedDataTex,
        inverseMapTex: constantTextures.inverseMapTex,
        metadataTex: constantTextures.metadataTex,
        placeholderTexture,
        modulatorScaleLut,
        modulator1Texture: placeholderTexture,
        modulator2Texture: placeholderTexture,
        modulator3Texture: placeholderTexture,
      };

      const renderer = new StrokeRenderer(
        gl,
        constantSpectrogramData,
        constantStrokeTextures,
        "additive-test",
        effects,
      );
      renderer.initialize();

      // Create state with additive blend mode and non-cumulative strokes
      const state = createMockStateWithSteps(
        [
          {
            name: "Additive Blend Step",
            overrides: {
              blendMode: 1, // Additive blend mode
              brushIntensity: 100,
              // Large rectangular brush anchored at the cursor
              brushSizeTime: 10,
              brushCurveTime: 100,
              brushSkewTime: -100,
              brushSizePitch: 100,
              brushCurvePitch: 100,
              brushSkewPitch: -100,
              effects: [
                { id: "test-transform", effect: "transform", enabled: false, params: {} },
                { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
                { id: "test-blur", effect: "blur", enabled: false, params: {} },
                { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
                { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
              ],
              accumulate: false, // non-cumulative mode
            },
          },
        ],
        {
          filepathsBpm: {
            "/test/additive-test.wav": 120,
          },
        },
      ) as State;

      const totalDuration = constantSpectrogramData.numFrames / constantSpectrogramData.sampleRate;
      const rendererTextures = renderer.getTextures();
      const sourceFile: SourceFileInfo = {
        id: "additive-test",
        filePath: "/test/additive-test.wav",
        spectrogramData: constantSpectrogramData,
        textures: {
          packed: rendererTextures.packed,
          inverse: rendererTextures.inverse,
          metadata: rendererTextures.metadata,
          original: rendererTextures.original,
        },
      };

      // Brush starts at bottom-left (0,0) and extends up/right
      // Sample at a point well inside the brush area
      const cursorPos = new Vector2(0.0, 0.0);
      const sampleUv = new Vector2(0.5, 0.5);

      // Get original magnitude
      const originalData = await renderer.getFBOData();
      const originalPixel = getPixelAtUv(originalData, sampleUv, constantSpectrogramData);
      expect(originalPixel).not.toBeNull();
      const originalMag = originalPixel![0];
      expect(originalMag).toBeCloseTo(0.5, 2);

      // Begin a stroke (captures strokeStartFbo)
      renderer.beginStroke();

      const params: StrokeParams = {
        cursorPos,
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 1,
        tiltX: 0,
        tiltY: 0,
      };

      // First stroke
      renderer.renderStroke(params, state, sourceFile);

      const dataAfter1 = await renderer.getFBOData();
      const pixel1 = getPixelAtUv(dataAfter1, sampleUv, constantSpectrogramData);
      expect(pixel1).not.toBeNull();
      const mag1 = pixel1![0];

      // With additive blend: target = blendOriginal + source = 0.5 + 0.5 = 1.0
      expect(mag1).toBeCloseTo(1.0, 1);

      // Stroke again at the same position (simulating back-and-forth painting)
      renderer.renderStroke(params, state, sourceFile);
      const dataAfter2 = await renderer.getFBOData();
      const pixel2 = getPixelAtUv(dataAfter2, sampleUv, constantSpectrogramData);
      expect(pixel2).not.toBeNull();
      const mag2 = pixel2![0];

      renderer.renderStroke(params, state, sourceFile);
      const dataAfter3 = await renderer.getFBOData();
      const pixel3 = getPixelAtUv(dataAfter3, sampleUv, constantSpectrogramData);
      expect(pixel3).not.toBeNull();
      const mag3 = pixel3![0];

      // In non-cumulative mode, subsequent strokes should NOT accumulate
      expect(mag2).toBeCloseTo(mag1, 1);
      expect(mag3).toBeCloseTo(mag1, 1);

      renderer.endStroke();
      renderer.dispose();
      constantTextures.packedDataTex.dispose();
      constantTextures.originalPackedDataTex.dispose();
      constantTextures.inverseMapTex.dispose();
      constantTextures.metadataTex.dispose();
    });
  });

  describe("stereo spread", () => {
    // Source is symmetric (L == R). With modulator1 driving brushIntensity as
    // a Pattern-mode sine LFO, painted intensity varies spatially. At
    // stereoSpread=0 both channels sample the modulator at the same UV, so L
    // and R output magnitudes must match per pixel. At stereoSpread=100 the
    // channels decorrelate and magnitudes must diverge somewhere in the brush.
    function createStereoSpreadState(stereoSpread: number): State {
      const effectsList = [
        { id: "test-transform", effect: "transform" as const, enabled: true, params: {} },
        { id: "test-dynamics", effect: "dynamics" as const, enabled: false, params: {} },
        { id: "test-blur", effect: "blur" as const, enabled: false, params: {} },
        { id: "test-overtones", effect: "overtones" as const, enabled: false, params: {} },
        { id: "test-synthesize", effect: "synthesize" as const, enabled: false, params: {} },
      ];

      return createMockStateWithSteps(
        [
          {
            name: "Stereo",
            overrides: {
              brushIntensity: 100,
              brushSizeTime: 10,
              brushSizePitch: 100,
              brushCurveTime: 100,
              brushSkewTime: -100,
              brushCurvePitch: 100,
              brushSkewPitch: -100,
              accumulate: true,
              // Add blend mode produces target = source + modified which
              // differs from source, so intensity changes make the output
              // magnitude change. This surfaces the L/R divergence that
              // identity-blend would mask.
              blendMode: 1,
              modulator1Mode: 0,
              modulator1PatternShape: 0, // Sine
              // Tight rate so the 0.5-UV stereo offset spans several cycles
              // across the very short test spectrogram.
              modulator1PatternRateBeats: 0.001,
              modulator1PatternRateSemis: 1,
              modulator1Strength: 100,
              modulator1StereoSpread: stereoSpread,
              brushIntensityMod1Amount: 100,
              effects: effectsList,
            },
          },
        ],
        {
          filepathsBpm: { "/test/effects-test.wav": 120 },
        },
      ) as State;
    }

    function strokeParams(totalDuration: number): StrokeParams {
      return {
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
    }

    function maxChannelMagDivergence(data: Float32Array): number {
      let maxDiff = 0;
      for (let i = 0; i < data.length; i += 4) {
        maxDiff = Math.max(maxDiff, Math.abs(data[i] - data[i + 2]));
      }
      return maxDiff;
    }

    it("should produce identical L and R magnitudes when stereoSpread is zero", async () => {
      const renderer = createRenderer();
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      renderer.renderStroke(strokeParams(totalDuration), createStereoSpreadState(0), sourceFile);
      const data = await renderer.getFBOData();

      // Sanity: the modulated stroke produced non-zero output.
      expect(hasNonZeroMagnitudes(data)).toBe(true);
      // Every pixel's L and R magnitudes must match — mono path preserved.
      expect(maxChannelMagDivergence(data)).toBeLessThan(1e-5);

      renderer.dispose();
    });

    it("should produce divergent L and R magnitudes when stereoSpread is non-zero", async () => {
      const renderer = createRenderer();
      const sourceFile = createSourceFile(renderer);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      renderer.renderStroke(strokeParams(totalDuration), createStereoSpreadState(100), sourceFile);
      const data = await renderer.getFBOData();

      expect(hasNonZeroMagnitudes(data)).toBe(true);
      // A full-range spread on a sine LFO must push L and R meaningfully apart
      // somewhere inside the brush. Threshold is generous because the exact
      // divergence depends on brush envelope × intensity × effect gain.
      expect(maxChannelMagDivergence(data)).toBeGreaterThan(0.001);

      renderer.dispose();
    });
  });

  // Cross-file painting with different analysis geometry must map by FREQUENCY,
  // not by UV ratio. If the two files share minFreq + bandsPerOctave, source
  // band i and dest band i are the same frequency; the paint should deposit
  // source[band i] into dest[band i] regardless of how many bands each file
  // has. A weak "any non-zero output" check hides a wrong mapping (content
  // still appears, just at the wrong frequencies), so this test measures
  // per-band similarity.
  describe("cross-file painting with mismatched analysis parameters", () => {
    async function paintAndReadDestBands(enableTransform: boolean) {
      // Dest: 8 bands, silence. Source: 16 bands, per-band magnitude gradient
      // = (band+1)/16. Same minFreq + bandsPerOctave, so band index == same
      // frequency in both files.
      const destSpectrogramData = createMockSpectrogramData({
        numFrames: 16,
        numBands: 8,
        pattern: "silence",
      });
      const sourceSpectrogramData = createMockSpectrogramData({
        numFrames: 16,
        numBands: 16,
        pattern: "bandGradient",
      });

      const destRawTextures = createTexturesFromSpectrogramData(destSpectrogramData);
      const sourceRawTextures = createTexturesFromSpectrogramData(sourceSpectrogramData);

      const destStrokeTextures: StrokeTextures = {
        packedDataTex: destRawTextures.packedDataTex,
        originalPackedDataTex: destRawTextures.originalPackedDataTex,
        inverseMapTex: destRawTextures.inverseMapTex,
        metadataTex: destRawTextures.metadataTex,
        placeholderTexture,
        modulatorScaleLut,
        modulator1Texture: placeholderTexture,
        modulator2Texture: placeholderTexture,
        modulator3Texture: placeholderTexture,
      };
      const sourceStrokeTextures: StrokeTextures = {
        packedDataTex: sourceRawTextures.packedDataTex,
        originalPackedDataTex: sourceRawTextures.originalPackedDataTex,
        inverseMapTex: sourceRawTextures.inverseMapTex,
        metadataTex: sourceRawTextures.metadataTex,
        placeholderTexture,
        modulatorScaleLut,
        modulator1Texture: placeholderTexture,
        modulator2Texture: placeholderTexture,
        modulator3Texture: placeholderTexture,
      };

      const destRenderer = new StrokeRenderer(gl, destSpectrogramData, destStrokeTextures, "mismatch-dest", effects);
      destRenderer.initialize();
      const sourceRenderer = new StrokeRenderer(
        gl,
        sourceSpectrogramData,
        sourceStrokeTextures,
        "mismatch-source",
        effects,
      );
      sourceRenderer.initialize();

      const sourceTex = sourceRenderer.getTextures();
      const sourceFile: SourceFileInfo = {
        id: "mismatch-source",
        filePath: "/test/mismatch-source.wav",
        spectrogramData: sourceSpectrogramData,
        textures: {
          packed: sourceTex.packed,
          inverse: sourceTex.inverse,
          metadata: sourceTex.metadata,
          original: sourceTex.original,
        },
      };

      const effectsList = [
        { id: "test-transform", effect: "transform" as const, enabled: enableTransform, params: {} },
        { id: "test-dynamics", effect: "dynamics" as const, enabled: false, params: {} },
        { id: "test-blur", effect: "blur" as const, enabled: false, params: {} },
        { id: "test-overtones", effect: "overtones" as const, enabled: false, params: {} },
        { id: "test-synthesize", effect: "synthesize" as const, enabled: false, params: {} },
      ];
      const state = createMockStateWithSteps(
        [
          {
            name: "Mismatch",
            overrides: {
              brushIntensity: 100,
              brushSizeTime: 10,
              brushSizePitch: 100,
              brushCurveTime: 100,
              brushSkewTime: -100,
              brushCurvePitch: 100,
              brushSkewPitch: -100,
              accumulate: false,
              blendMode: 0,
              sourcePositionMode: "follow",
              transformEdgeMode: 1,
              effects: effectsList,
            },
          },
        ],
        {
          filepathsBpm: {
            "/test/mismatch-source.wav": 120,
            "/test/effects-test.wav": 120,
          },
        },
      ) as State;

      const totalDuration = destSpectrogramData.numFrames / destSpectrogramData.sampleRate;
      const params: StrokeParams = {
        cursorPos: new Vector2(0, 0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 1,
        tiltX: 0,
        tiltY: 0,
      };

      destRenderer.renderStroke(params, state, sourceFile);
      const outputData = await destRenderer.getFBOData();

      const destBandMeanMag: number[] = [];
      for (let band = 0; band < destSpectrogramData.numBands; band++) {
        let sum = 0;
        let count = 0;
        for (let frame = 0; frame < destSpectrogramData.numFrames; frame++) {
          const pixel = readSpectrogramPixel(
            outputData,
            frame,
            band,
            destSpectrogramData.numFrames,
            destSpectrogramData.numBands,
            destSpectrogramData.textureWidth,
            destSpectrogramData.textureHeight,
          );
          if (pixel) {
            sum += pixel[0];
            count += 1;
          }
        }
        destBandMeanMag.push(count > 0 ? sum / count : 0);
      }

      destRenderer.dispose();
      sourceRenderer.dispose();
      destRawTextures.packedDataTex.dispose();
      destRawTextures.originalPackedDataTex.dispose();
      destRawTextures.inverseMapTex.dispose();
      destRawTextures.metadataTex.dispose();
      sourceRawTextures.packedDataTex.dispose();
      sourceRawTextures.originalPackedDataTex.dispose();
      sourceRawTextures.inverseMapTex.dispose();
      sourceRawTextures.metadataTex.dispose();

      return { destBandMeanMag, sourceBandCount: sourceSpectrogramData.numBands };
    }

    function assertFreqAlignedMatch(result: { destBandMeanMag: number[]; sourceBandCount: number }) {
      // Gaborator layout: band 0 is highest freq, last band is minFreq. Both
      // files share minFreq + bandsPerOctave, so dest band i (freq =
      // minFreq·2^((destN-1-i)/bpo)) maps to source band (sourceN - destN + i)
      // at the same freq. That source band has magnitude (sourceN-destN+i+1)/sourceN.
      const destBandCount = result.destBandMeanMag.length;
      const expectedFor = (band: number) =>
        (result.sourceBandCount - destBandCount + band + 1) / result.sourceBandCount;
      let mse = 0;
      for (let band = 0; band < destBandCount; band++) {
        const diff = result.destBandMeanMag[band] - expectedFor(band);
        mse += diff * diff;
      }
      mse /= destBandCount;
      if (mse >= 0.01) {
        const lines = result.destBandMeanMag.map((actual, band) => {
          return `  band ${band}: actual=${actual.toFixed(4)}  expected=${expectedFor(band).toFixed(4)}`;
        });
        // eslint-disable-next-line no-console
        console.log(`per-band mag (MSE=${mse.toFixed(4)}):\n${lines.join("\n")}`);
      }
      expect(mse).toBeLessThan(0.01);
    }

    it("transform paints each dest band from the source band at the same frequency", async () => {
      const result = await paintAndReadDestBands(true);
      assertFreqAlignedMatch(result);
    });

    it("passthrough (no effects) paints each dest band from the source band at the same frequency", async () => {
      const result = await paintAndReadDestBands(false);
      assertFreqAlignedMatch(result);
    });
  });

  // Passthrough (source = self, no effects, full-coverage rectangular brush at
  // 100% intensity) must be a true pixel identity: a single non-zero magnitude
  // in the input must come out at the exact same (band, frame) with the same
  // magnitude and nothing anywhere else. The mock uses a fractional-band freq
  // drift so band (N-1) sits below the configured minFreq — the realistic
  // direction of gaborator's tuning snap, which caused every bin to read from
  // the next-lower source band (displayed as a one-bin upward shift).
  describe("identity round-trip", () => {
    it("passthrough with self-source preserves a single-pixel input at the same (band, frame) with the same magnitude", async () => {
      const numBands = 8;
      const numFrames = 16;
      const spec = createMockSpectrogramData({
        numFrames,
        numBands,
        pattern: "silence",
        metadataFreqDriftBands: -0.7,
      });

      // Deposit a single non-zero pixel at a band/frame well inside the grid.
      const testBand = 3;
      const testFrame = 8;
      const testMag = 0.7;
      const pixelIndex = testBand * numFrames + testFrame;
      spec.packedData[pixelIndex * 4 + 0] = testMag;
      spec.packedData[pixelIndex * 4 + 2] = testMag;

      const rawTextures = createTexturesFromSpectrogramData(spec);
      const strokeTextures: StrokeTextures = {
        packedDataTex: rawTextures.packedDataTex,
        originalPackedDataTex: rawTextures.originalPackedDataTex,
        inverseMapTex: rawTextures.inverseMapTex,
        metadataTex: rawTextures.metadataTex,
        placeholderTexture,
        modulatorScaleLut,
        modulator1Texture: placeholderTexture,
        modulator2Texture: placeholderTexture,
        modulator3Texture: placeholderTexture,
      };
      const renderer = new StrokeRenderer(gl, spec, strokeTextures, "identity-test", effects);
      renderer.initialize();

      const rendererTextures = renderer.getTextures();
      const sourceFile: SourceFileInfo = {
        id: "identity-test",
        filePath: "/test/identity-test.wav",
        spectrogramData: spec,
        textures: {
          packed: rendererTextures.packed,
          inverse: rendererTextures.inverse,
          metadata: rendererTextures.metadata,
          original: rendererTextures.original,
        },
      };

      const effectsList = [
        { id: "test-transform", effect: "transform" as const, enabled: false, params: {} },
        { id: "test-dynamics", effect: "dynamics" as const, enabled: false, params: {} },
        { id: "test-blur", effect: "blur" as const, enabled: false, params: {} },
        { id: "test-overtones", effect: "overtones" as const, enabled: false, params: {} },
        { id: "test-synthesize", effect: "synthesize" as const, enabled: false, params: {} },
      ];
      const state = createMockStateWithSteps(
        [
          {
            name: "Identity",
            overrides: {
              brushIntensity: 100,
              brushSizeTime: 10,
              brushSizePitch: 100,
              brushCurveTime: 100,
              brushSkewTime: -100,
              brushCurvePitch: 100,
              brushSkewPitch: -100,
              accumulate: true,
              blendMode: 0,
              sourcePositionMode: "follow",
              effects: effectsList,
            },
          },
        ],
        { filepathsBpm: { "/test/identity-test.wav": 120 } },
      ) as State;

      const totalDuration = spec.numFrames / spec.sampleRate;
      const params: StrokeParams = {
        cursorPos: new Vector2(0, 0),
        preview: false,
        bpm: 120,
        totalDuration,
        viewZoomPower: 0,
        viewOffset: 0,
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 1,
        tiltX: 0,
        tiltY: 0,
      };

      renderer.renderStroke(params, state, sourceFile);
      const output = await renderer.getFBOData();

      const hitPixel = readSpectrogramPixel(
        output,
        testFrame,
        testBand,
        spec.numFrames,
        spec.numBands,
        spec.textureWidth,
        spec.textureHeight,
      );
      expect(hitPixel).not.toBeNull();
      expect(hitPixel![0]).toBeCloseTo(testMag, 2);
      expect(hitPixel![2]).toBeCloseTo(testMag, 2);

      // Every other (band, frame) in the grid must stay ~zero. A one-band
      // vertical shift would plant testMag at band (testBand±1); a one-frame
      // horizontal shift would plant it at (testFrame±1).
      const stray: Array<{ band: number; frame: number; magL: number; magR: number }> = [];
      for (let band = 0; band < spec.numBands; band++) {
        for (let frame = 0; frame < spec.numFrames; frame++) {
          if (band === testBand && frame === testFrame) continue;
          const pix = readSpectrogramPixel(
            output,
            frame,
            band,
            spec.numFrames,
            spec.numBands,
            spec.textureWidth,
            spec.textureHeight,
          );
          if (pix && (pix[0] > 0.01 || pix[2] > 0.01)) {
            stray.push({ band, frame, magL: pix[0], magR: pix[2] });
          }
        }
      }
      if (stray.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`unexpected non-zero pixels (one-bin shift would appear here):`, stray);
      }
      expect(stray).toEqual([]);

      renderer.dispose();
      rawTextures.packedDataTex.dispose();
      rawTextures.originalPackedDataTex.dispose();
      rawTextures.inverseMapTex.dispose();
      rawTextures.metadataTex.dispose();
    });
  });
});
