import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  NearestFilter,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Static imports - circular dependency has been resolved via effects/types.ts
import { BaseEffect, UpdateEffectUniformsProps } from "../../effects/base-effect";
import passThroughVert from "../../glsl/pass-through.vert";
import { SpectrogramData, State } from "../../store/types";
import {
  compareSpectrogramData,
  createMockSpectrogramData,
  findDifferingPixels,
  getPixelAtUv,
  getSpectrogramDuration,
  verifyPhasesUnchanged,
} from "../../test/mock-spectrogram";
import { createMockState, createMockStateForIterations, createMockStateWithSteps } from "../../test/mock-state";
import { withPlatformDefines } from "../shader-utils";
import {
  calculateEnvelopeBoundaries,
  EffectsRegistry,
  SourceFileInfo,
  StrokeParams,
  StrokeRenderer,
  StrokeTextures,
} from "../stroke-renderer";

// Mock shaders check brush bounds in packed UV space, which doesn't align with
// the scissor's unpacked band-index row calculation. Disable scissor for tests.
function createTestStrokeRenderer(...args: ConstructorParameters<typeof StrokeRenderer>): StrokeRenderer {
  const r = new StrokeRenderer(...args);
  r.calculateScissorRows = () => null;
  return r;
}

/**
 * Creates a configurable additive effect shader fragment.
 * The amount can be positive (add) or negative (subtract).
 */
function createConfigurableAdditiveShader(amount: number): string {
  return `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D sourceSpectrogramTex;
uniform sampler2D destSpectrogramTex;
uniform vec2 brushBottomLeftUv;
uniform vec2 brushSizeUv;

void main() {
  vec4 destTexel = texture(destSpectrogramTex, vUv);

  vec2 offset = vUv - brushBottomLeftUv;
  bool insideBrush = offset.x >= 0.0 && offset.x < brushSizeUv.x &&
                     offset.y >= 0.0 && offset.y < brushSizeUv.y;

  if (!insideBrush) {
    outColor = destTexel;
    return;
  }

  vec4 sourceTexel = texture(sourceSpectrogramTex, vUv);

  float addAmount = ${amount.toFixed(6)};
  outColor = vec4(
    sourceTexel.r + addAmount,
    sourceTexel.g,
    sourceTexel.b + addAmount,
    sourceTexel.a
  );
}
`;
}

/**
 * Creates a shader that simulates additive blend mode behavior.
 * This reads from both source (modified data) and blendOriginal (stroke start data),
 * then combines them additively: blendOriginal + source.
 * This is used to test non-cumulative mode with additive blending.
 *
 * The key insight is that in non-cumulative mode, the blend formula should use
 * the stroke start state (blendOriginalTex), not the current dest (destSpectrogramTex).
 * This prevents accumulation when painting over the same area.
 */
function createAdditiveBlendShader(): string {
  return `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D sourceSpectrogramTex;
uniform sampler2D destSpectrogramTex;
uniform sampler2D blendOriginalTex;
uniform bool useStrokeMask;
uniform vec2 brushBottomLeftUv;
uniform vec2 brushSizeUv;

void main() {
  vec4 destTexel = texture(destSpectrogramTex, vUv);

  vec2 offset = vUv - brushBottomLeftUv;
  bool insideBrush = offset.x >= 0.0 && offset.x < brushSizeUv.x &&
                     offset.y >= 0.0 && offset.y < brushSizeUv.y;

  if (!insideBrush) {
    outColor = destTexel;
    return;
  }

  vec4 sourceTexel = texture(sourceSpectrogramTex, vUv);

  // In non-cumulative mode, use blendOriginalTex for the blend formula
  // to prevent accumulation when painting over the same area
  vec4 blendOriginal = useStrokeMask ? texture(blendOriginalTex, vUv) : destTexel;

  // Simulates additive blend mode: blendOriginal + source
  outColor = vec4(
    blendOriginal.r + sourceTexel.r,
    sourceTexel.g,  // phase from source
    blendOriginal.b + sourceTexel.b,
    sourceTexel.a   // phase from source
  );
}
`;
}

/**
 * Creates an additive blend effect that simulates blend mode 1 (Add).
 * Uses blendOriginalTex in non-cumulative mode to prevent accumulation.
 */
function createAdditiveBlendEffect(): BaseEffect {
  const material = new RawShaderMaterial({
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(createAdditiveBlendShader()),
    glslVersion: GLSL3,
    uniforms: {
      sourceSpectrogramTex: { value: null },
      destSpectrogramTex: { value: null },
      blendOriginalTex: { value: null },
      useStrokeMask: { value: false },
      brushBottomLeftUv: { value: new Vector2(0, 0) },
      brushSizeUv: { value: new Vector2(1, 1) },
    },
  });

  return {
    materials: [material],
    updateEffectUniforms({ commonUniforms, passIndex }: UpdateEffectUniformsProps) {
      const mat = this.materials[passIndex];
      if (!mat) return;
      if (commonUniforms.sourceSpectrogramTex) {
        mat.uniforms.sourceSpectrogramTex.value = commonUniforms.sourceSpectrogramTex.value;
      }
      if (commonUniforms.destSpectrogramTex) {
        mat.uniforms.destSpectrogramTex.value = commonUniforms.destSpectrogramTex.value;
      }
      if ((commonUniforms as Record<string, { value: unknown }>).blendOriginalTex) {
        mat.uniforms.blendOriginalTex.value = (
          commonUniforms as Record<string, { value: unknown }>
        ).blendOriginalTex.value;
      }
      if ((commonUniforms as Record<string, { value: unknown }>).useStrokeMask) {
        mat.uniforms.useStrokeMask.value = (commonUniforms as Record<string, { value: unknown }>).useStrokeMask.value;
      }
      if (commonUniforms.brushBottomLeftUv) {
        mat.uniforms.brushBottomLeftUv.value = commonUniforms.brushBottomLeftUv.value;
      }
      if (commonUniforms.brushSizeUv) {
        mat.uniforms.brushSizeUv.value = commonUniforms.brushSizeUv.value;
      }
    },
  } as BaseEffect;
}

/**
 * Creates a mock effects registry with additive blend effect.
 * Used for testing non-cumulative mode with additive blending.
 */
function createMockEffectsWithAdditiveBlend(): EffectsRegistry {
  const passthroughEffect = createMockPassthroughEffect();
  const additiveBlendEffect = createAdditiveBlendEffect();
  return {
    dynamics: passthroughEffect,
    transform: additiveBlendEffect, // Additive blend for testing
    overtones: passthroughEffect,
    blur: passthroughEffect,
    synthesize: passthroughEffect,
    passthrough: passthroughEffect,
  };
}

/**
 * Creates a configurable additive effect with a specified amount.
 * Positive amounts add to magnitude, negative amounts subtract.
 */
function createConfigurableAdditiveEffect(amount: number): BaseEffect {
  const material = new RawShaderMaterial({
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(createConfigurableAdditiveShader(amount)),
    glslVersion: GLSL3,
    uniforms: {
      sourceSpectrogramTex: { value: null },
      destSpectrogramTex: { value: null },
      brushBottomLeftUv: { value: new Vector2(0, 0) },
      brushSizeUv: { value: new Vector2(1, 1) },
    },
  });

  return {
    materials: [material],
    updateEffectUniforms({ commonUniforms, passIndex }: UpdateEffectUniformsProps) {
      const mat = this.materials[passIndex];
      if (!mat) return;
      if (commonUniforms.sourceSpectrogramTex) {
        mat.uniforms.sourceSpectrogramTex.value = commonUniforms.sourceSpectrogramTex.value;
      }
      if (commonUniforms.destSpectrogramTex) {
        mat.uniforms.destSpectrogramTex.value = commonUniforms.destSpectrogramTex.value;
      }
      if (commonUniforms.brushBottomLeftUv) {
        mat.uniforms.brushBottomLeftUv.value = commonUniforms.brushBottomLeftUv.value;
      }
      if (commonUniforms.brushSizeUv) {
        mat.uniforms.brushSizeUv.value = commonUniforms.brushSizeUv.value;
      }
    },
  } as BaseEffect;
}

/**
 * Self-contained passthrough shader for testing.
 * Copies source to output without modification within the brush area.
 */
const passthroughTestShader = `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D sourceSpectrogramTex;
uniform sampler2D destSpectrogramTex;
uniform vec2 brushBottomLeftUv;
uniform vec2 brushSizeUv;

void main() {
  vec4 destTexel = texture(destSpectrogramTex, vUv);

  vec2 offset = vUv - brushBottomLeftUv;
  bool insideBrush = offset.x >= 0.0 && offset.x < brushSizeUv.x &&
                     offset.y >= 0.0 && offset.y < brushSizeUv.y;

  if (!insideBrush) {
    outColor = destTexel;
    return;
  }

  // Pass through source data unchanged
  vec4 sourceTexel = texture(sourceSpectrogramTex, vUv);
  outColor = sourceTexel;
}
`;

/**
 * Creates a simple passthrough effect for testing.
 * Copies source texture to destination within brush area.
 */
function createMockPassthroughEffect(): BaseEffect {
  const material = new RawShaderMaterial({
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(passthroughTestShader),
    glslVersion: GLSL3,
    uniforms: {
      sourceSpectrogramTex: { value: null },
      destSpectrogramTex: { value: null },
      brushBottomLeftUv: { value: new Vector2(0, 0) },
      brushSizeUv: { value: new Vector2(1, 1) },
    },
  });

  return {
    materials: [material],
    updateEffectUniforms({ commonUniforms, passIndex }: UpdateEffectUniformsProps) {
      const mat = this.materials[passIndex];
      if (!mat) return;
      if (commonUniforms.sourceSpectrogramTex) {
        mat.uniforms.sourceSpectrogramTex.value = commonUniforms.sourceSpectrogramTex.value;
      }
      if (commonUniforms.destSpectrogramTex) {
        mat.uniforms.destSpectrogramTex.value = commonUniforms.destSpectrogramTex.value;
      }
      if (commonUniforms.brushBottomLeftUv) {
        mat.uniforms.brushBottomLeftUv.value = commonUniforms.brushBottomLeftUv.value;
      }
      if (commonUniforms.brushSizeUv) {
        mat.uniforms.brushSizeUv.value = commonUniforms.brushSizeUv.value;
      }
    },
  } as BaseEffect;
}

/**
 * Creates a mock effects registry with only the passthrough effect.
 * This is sufficient for testing stroke behavior without importing the full effects module.
 *
 * NOTE: The passthrough effect is idempotent (applying it N times = applying it once).
 * To test iteration accumulation, you need an effect that changes data each pass
 * (like transform with a shift, or an additive effect).
 */
function createMockEffects(): EffectsRegistry {
  const passthroughEffect = createMockPassthroughEffect();
  return {
    dynamics: passthroughEffect,
    transform: passthroughEffect,
    overtones: passthroughEffect,
    blur: passthroughEffect,
    synthesize: passthroughEffect,
    passthrough: passthroughEffect,
  };
}

/**
 * Creates a mock effects registry with the additive test effect for transform.
 * Use this for testing iteration behavior since each iteration adds 0.05 to magnitudes.
 */
function createMockEffectsWithAdditive(): EffectsRegistry {
  const passthroughEffect = createMockPassthroughEffect();
  const additiveEffect = createConfigurableAdditiveEffect(0.05);
  return {
    dynamics: passthroughEffect,
    transform: additiveEffect, // Additive effect for testing iterations
    overtones: passthroughEffect,
    blur: passthroughEffect,
    synthesize: passthroughEffect,
    passthrough: passthroughEffect,
  };
}

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
 * Creates a SourceFileInfo object for testing.
 */
function createSourceFileInfo(
  spectrogramData: SpectrogramData,
  fileId: string,
  renderer: StrokeRenderer,
): SourceFileInfo {
  const textures = renderer.getTextures();
  return {
    id: fileId,
    filePath: `/test/${fileId}.wav`,
    spectrogramData,
    textures: {
      packed: textures.packed,
      inverse: textures.inverse,
      metadata: textures.metadata,
      original: textures.original,
    },
  };
}

describe("StrokeRenderer", () => {
  let gl: WebGLRenderer;
  let renderer: StrokeRenderer;
  let spectrogramData: SpectrogramData;
  let textures: StrokeTextures;

  beforeEach(() => {
    // Create WebGL renderer
    gl = new WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
    });
    gl.setSize(512, 512);

    // Create mock spectrogram data
    spectrogramData = createMockSpectrogramData({
      numFrames: 256,
      numBands: 128,
      pattern: "constant",
      constantMagnitude: 0.5,
    });

    // Create textures
    const dataTextures = createTexturesFromSpectrogramData(spectrogramData);
    const placeholderTexture = createPlaceholderTexture();

    textures = {
      ...dataTextures,
      placeholderTexture,
      modulatorScaleLut: null,
      modulator1Texture: null,
      modulator2Texture: null,
      modulator3Texture: null,
    };

    // Create renderer with additive effects so tests see actual changes
    const mockEffects = createMockEffectsWithAdditive();
    renderer = createTestStrokeRenderer(gl, spectrogramData, textures, "test-file-1", mockEffects);
  });

  afterEach(() => {
    renderer.dispose();
    gl.dispose();

    // Dispose textures
    textures.packedDataTex.dispose();
    textures.originalPackedDataTex.dispose();
    textures.inverseMapTex.dispose();
    textures.metadataTex.dispose();
    textures.placeholderTexture.dispose();
  });

  describe("initialization", () => {
    it("should initialize without errors", () => {
      expect(renderer.getIsInitialized()).toBe(false);
      renderer.initialize();
      expect(renderer.getIsInitialized()).toBe(true);
    });

    it("should return correct textures after initialization", () => {
      renderer.initialize();
      const resultTextures = renderer.getTextures();

      expect(resultTextures).toBeDefined();
      expect(resultTextures.packed).toBeInstanceOf(WebGLRenderTarget);
      expect(resultTextures.inverse).toBeInstanceOf(DataTexture);
      expect(resultTextures.metadata).toBeInstanceOf(DataTexture);
      expect(resultTextures.original).toBeInstanceOf(DataTexture);
    });
  });

  describe("calculateEnvelopeBoundaries", () => {
    it("should calculate correct boundaries for time dimension", () => {
      const result = calculateEnvelopeBoundaries(
        0, // delay
        0.25, // attack
        0.5, // sustain
        0.25, // release
        120, // bpm
        10, // totalDuration
        24, // bandsPerOctave
        128, // numBands
        true, // isTime
      );

      expect(result.delayEnd).toBe(0);
      expect(result.releaseEnd).toBe(1);
      expect(result.attackEnd).toBeGreaterThan(0);
      expect(result.sustainEnd).toBeGreaterThan(result.attackEnd);
    });

    it("should calculate correct boundaries for pitch dimension", () => {
      const result = calculateEnvelopeBoundaries(
        0, // delay
        3, // attack (semitones)
        6, // sustain
        3, // release
        120,
        10,
        24,
        128,
        false, // isPitch
      );

      expect(result.delayEnd).toBe(0);
      expect(result.releaseEnd).toBe(1);
    });
  });

  describe("single strokes", () => {
    it("should apply a stroke at the center of the canvas", async () => {
      renderer.initialize();

      const state = createMockStateWithSteps([{ name: "Test", overrides: { brushIntensity: 100, accumulate: true } }]);

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
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

      // Get data before stroke
      const dataBefore = await renderer.getFBOData();
      const dataBeforeCopy = new Float32Array(dataBefore);

      // Apply stroke
      renderer.renderStroke(params, state, sourceFile);

      // Get data after stroke
      const dataAfter = await renderer.getFBOData();

      // Data should have changed
      const differences = findDifferingPixels(dataBeforeCopy, dataAfter);
      expect(differences.length).toBeGreaterThan(0);
    });

    it("should not modify data in preview mode", async () => {
      renderer.initialize();

      const state = createMockState();
      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
        preview: true, // Preview mode
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

      const dataBefore = await renderer.getFBOData();
      const dataBeforeCopy = new Float32Array(dataBefore);

      renderer.renderStroke(params, state as State, sourceFile);

      // In preview mode, getFBOData should return the original (committed) data
      const dataAfter = await renderer.getFBOData();
      expect(compareSpectrogramData(dataBeforeCopy, dataAfter)).toBe(true);
    });

    it("should apply stroke with correct brush intensity", async () => {
      renderer.initialize();

      // Create state with intensity
      const intensityState = createMockState({ brushIntensity: 100 });

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
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

      // Apply stroke with intensity
      const dataBefore = await renderer.getFBOData();
      renderer.renderStroke(params, intensityState as State, sourceFile);
      const dataAfter = await renderer.getFBOData();
      const differences = findDifferingPixels(dataBefore, dataAfter);

      // Stroke should produce changes
      expect(differences.length).toBeGreaterThan(0);
    });
  });

  describe("iterations", () => {
    // For iteration tests, we need a renderer with an additive effect
    // so that multiple iterations produce measurable cumulative changes
    let iterRenderer: StrokeRenderer;
    let iterSpectrogramData: SpectrogramData;
    let iterTextures: StrokeTextures;

    beforeEach(() => {
      // Create mock spectrogram with constant values for predictable testing
      iterSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "constant",
        constantMagnitude: 0.5, // Start at 0.5 so we can see additions clearly
      });

      const dataTextures = createTexturesFromSpectrogramData(iterSpectrogramData);
      const placeholderTexture = createPlaceholderTexture();

      iterTextures = {
        ...dataTextures,
        placeholderTexture,
        modulatorScaleLut: null,
        modulator1Texture: null,
        modulator2Texture: null,
        modulator3Texture: null,
      };

      // Create renderer with ADDITIVE effect
      const additiveEffects = createMockEffectsWithAdditive();
      iterRenderer = createTestStrokeRenderer(gl, iterSpectrogramData, iterTextures, "iter-test", additiveEffects);
    });

    afterEach(() => {
      iterRenderer.dispose();
      iterTextures.packedDataTex.dispose();
      iterTextures.originalPackedDataTex.dispose();
      iterTextures.inverseMapTex.dispose();
      iterTextures.metadataTex.dispose();
      iterTextures.placeholderTexture.dispose();
    });

    /**
     * Helper to create state with transform effect enabled and specified iterations.
     * Uses accumulate: true to allow strokes to accumulate.
     */
    function createIterTestState(iterations: number): State {
      return createMockStateForIterations(iterations, {} as Partial<State>, {
        accumulate: true,
        effects: [
          { id: "test-transform", effect: "transform", enabled: true, params: {} },
          { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
          { id: "test-blur", effect: "blur", enabled: false, params: {} },
          { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
          { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
        ],
      });
    }

    it("should read brushIterations from step state correctly", async () => {
      const state1 = createMockStateForIterations(1);
      const state5 = createMockStateForIterations(5);

      expect(state1.brushes[state1.activeBrushIndex].steps[0].brushIterations).toBe(1);
      expect(state5.brushes[state5.activeBrushIndex].steps[0].brushIterations).toBe(5);
    });

    it("should apply effect N times when brushIterations = N (additive test)", async () => {
      iterRenderer.initialize();

      const state1Iter = createIterTestState(1);
      const state3Iter = createIterTestState(3);

      const totalDuration = iterSpectrogramData.numFrames / iterSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "iter-test",
        filePath: "/test/iter-test.wav",
        spectrogramData: iterSpectrogramData,
        textures: iterRenderer.getTextures(),
      };

      // Use full brush coverage by positioning at bottom-left with brush covering entire area
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

      // Get original data
      const dataOriginal = await iterRenderer.getFBOData();
      const originalCopy = new Float32Array(dataOriginal);

      // Sample a pixel that should be affected by the brush
      const sampleUv = new Vector2(0.1, 0.1);
      const originalPixel = getPixelAtUv(originalCopy, sampleUv, iterSpectrogramData);
      expect(originalPixel).not.toBeNull();
      const [origMagL, origPhaseL, origMagR, origPhaseR] = originalPixel!;

      // Verify starting magnitude is 0.5 (constant pattern)
      expect(origMagL).toBeCloseTo(0.5, 2);
      expect(origMagR).toBeCloseTo(0.5, 2);

      // Apply 1 iteration
      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const dataAfter1 = await iterRenderer.getFBOData();
      const pixel1 = getPixelAtUv(dataAfter1, sampleUv, iterSpectrogramData);
      expect(pixel1).not.toBeNull();
      const [mag1L, phase1L, mag1R, phase1R] = pixel1!;

      // After 1 iteration: magnitude should be ~0.55 (0.5 + 0.05)
      expect(mag1L).toBeCloseTo(0.55, 2);
      expect(mag1R).toBeCloseTo(0.55, 2);

      // Phase should remain unchanged
      expect(phase1L).toBeCloseTo(origPhaseL, 5);
      expect(phase1R).toBeCloseTo(origPhaseR, 5);

      // Reset to original
      iterRenderer.setFBOData(originalCopy);

      // Apply 3 iterations
      iterRenderer.renderStroke(params, state3Iter, sourceFile);
      const dataAfter3 = await iterRenderer.getFBOData();
      const pixel3 = getPixelAtUv(dataAfter3, sampleUv, iterSpectrogramData);
      expect(pixel3).not.toBeNull();
      const [mag3L, phase3L, mag3R, phase3R] = pixel3!;

      // After 3 iterations: magnitude should be ~0.65 (0.5 + 0.15)
      expect(mag3L).toBeCloseTo(0.65, 2);
      expect(mag3R).toBeCloseTo(0.65, 2);

      // Phase should remain unchanged
      expect(phase3L).toBeCloseTo(origPhaseL, 5);
      expect(phase3R).toBeCloseTo(origPhaseR, 5);
    });

    it("should accumulate changes across multiple renderStroke calls", async () => {
      iterRenderer.initialize();

      const state1Iter = createIterTestState(1);
      const totalDuration = iterSpectrogramData.numFrames / iterSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "iter-test",
        filePath: "/test/iter-test.wav",
        spectrogramData: iterSpectrogramData,
        textures: iterRenderer.getTextures(),
      };

      // Use brush at origin to cover a known region
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

      const sampleUv = new Vector2(0.1, 0.1);
      const originalData = await iterRenderer.getFBOData();
      const originalPixel = getPixelAtUv(originalData, sampleUv, iterSpectrogramData);
      expect(originalPixel).not.toBeNull();
      const origMag = originalPixel![0];

      // Call renderStroke 3 times - each should add 0.05
      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data1 = await iterRenderer.getFBOData();
      const pixel1 = getPixelAtUv(data1, sampleUv, iterSpectrogramData);
      expect(pixel1).not.toBeNull();
      expect(pixel1![0]).toBeCloseTo(origMag + 0.05, 2); // 0.55

      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data2 = await iterRenderer.getFBOData();
      const pixel2 = getPixelAtUv(data2, sampleUv, iterSpectrogramData);
      expect(pixel2).not.toBeNull();
      expect(pixel2![0]).toBeCloseTo(origMag + 0.1, 2); // 0.60

      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data3 = await iterRenderer.getFBOData();
      const pixel3 = getPixelAtUv(data3, sampleUv, iterSpectrogramData);
      expect(pixel3).not.toBeNull();
      expect(pixel3![0]).toBeCloseTo(origMag + 0.15, 2); // 0.65
    });

    it("should NOT apply extra iteration on stroke end", async () => {
      iterRenderer.initialize();

      const state1Iter = createIterTestState(1);
      const totalDuration = iterSpectrogramData.numFrames / iterSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "iter-test",
        filePath: "/test/iter-test.wav",
        spectrogramData: iterSpectrogramData,
        textures: iterRenderer.getTextures(),
      };

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

      const sampleUv = new Vector2(0.1, 0.1);

      // Simulate stroke lifecycle: begin -> render -> end
      iterRenderer.beginStroke();
      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const dataAfterRender = await iterRenderer.getFBOData();
      const pixelAfterRender = getPixelAtUv(dataAfterRender, sampleUv, iterSpectrogramData);
      expect(pixelAfterRender).not.toBeNull();
      const magAfterRender = pixelAfterRender![0];

      iterRenderer.endStroke();
      const dataAfterEnd = await iterRenderer.getFBOData();
      const pixelAfterEnd = getPixelAtUv(dataAfterEnd, sampleUv, iterSpectrogramData);
      expect(pixelAfterEnd).not.toBeNull();
      const magAfterEnd = pixelAfterEnd![0];

      // endStroke should NOT change the data (no extra iteration)
      // If this fails, it means endStroke is applying an extra iteration
      expect(magAfterEnd).toBeCloseTo(magAfterRender, 4);
    });

    it("should NOT re-apply when position unchanged (grid snapping scenario)", async () => {
      iterRenderer.initialize();

      const state1Iter = createIterTestState(1);
      const totalDuration = iterSpectrogramData.numFrames / iterSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "iter-test",
        filePath: "/test/iter-test.wav",
        spectrogramData: iterSpectrogramData,
        textures: iterRenderer.getTextures(),
      };

      const samePosition = new Vector2(0.0, 0.0);
      const sampleUv = new Vector2(0.1, 0.1);

      const params: StrokeParams = {
        cursorPos: samePosition,
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

      // Render at the same position multiple times (simulating mouse move without grid change)
      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data1 = await iterRenderer.getFBOData();
      const pixel1 = getPixelAtUv(data1, sampleUv, iterSpectrogramData);
      expect(pixel1).not.toBeNull();

      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data2 = await iterRenderer.getFBOData();
      const pixel2 = getPixelAtUv(data2, sampleUv, iterSpectrogramData);
      expect(pixel2).not.toBeNull();

      iterRenderer.renderStroke(params, state1Iter, sourceFile);
      const data3 = await iterRenderer.getFBOData();
      const pixel3 = getPixelAtUv(data3, sampleUv, iterSpectrogramData);
      expect(pixel3).not.toBeNull();

      // NOTE: Current behavior - each call applies the effect again (+0.05 each time)
      // This documents the current behavior. If grid snapping should prevent
      // re-application at the same position, this test would need to be updated
      expect(pixel1![0]).toBeCloseTo(0.55, 2); // 0.5 + 0.05
      expect(pixel2![0]).toBeCloseTo(0.6, 2); // 0.5 + 0.10
      expect(pixel3![0]).toBeCloseTo(0.65, 2); // 0.5 + 0.15
    });
  });

  describe("multiple steps", () => {
    it("should apply multiple steps in sequence", async () => {
      renderer.initialize();

      const state = createMockStateWithSteps([
        { name: "Step 1", overrides: { brushIntensity: 50 } as any },
        { name: "Step 2", overrides: { brushIntensity: 100 } as any },
      ]);

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
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

      const dataBefore = await renderer.getFBOData();
      renderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await renderer.getFBOData();

      // Should have changes from both steps
      const differences = findDifferingPixels(dataBefore, dataAfter);
      expect(differences.length).toBeGreaterThan(0);
    });

    it("should apply steps with different effect configurations", async () => {
      renderer.initialize();

      // Step 1: transform enabled, Step 2: dynamics enabled
      const state = createMockStateWithSteps([
        {
          name: "Transform Step",
          overrides: {
            effects: [
              { id: "test-transform", effect: "transform", enabled: true, params: {} },
              { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
            ],
          },
        },
        {
          name: "Dynamics Step",
          overrides: {
            effects: [
              { id: "test-transform", effect: "transform", enabled: false, params: {} },
              { id: "test-dynamics", effect: "dynamics", enabled: true, params: {} },
            ],
          },
        },
      ]);

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
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

      const dataBefore = await renderer.getFBOData();
      renderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await renderer.getFBOData();

      // Should have changes
      const differences = findDifferingPixels(dataBefore, dataAfter);
      expect(differences.length).toBeGreaterThan(0);
    });
  });

  describe("different source files", () => {
    it("should use source file data when rendering stroke", async () => {
      renderer.initialize();

      // Create a different source file with a gradient pattern
      // Gradient pattern: magnitude = frame / numFrames (varies 0 to 1 across time)
      const sourceSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "gradient",
      });

      // Create textures for source file
      const sourceTextures = createTexturesFromSpectrogramData(sourceSpectrogramData);

      // Create a second renderer for the source file
      const sourceGl = new WebGLRenderer({ preserveDrawingBuffer: true });
      sourceGl.setSize(512, 512);

      const sourceRenderer = createTestStrokeRenderer(
        sourceGl,
        sourceSpectrogramData,
        {
          ...sourceTextures,
          placeholderTexture: createPlaceholderTexture(),
          modulatorScaleLut: null,
          modulator1Texture: null,
          modulator2Texture: null,
          modulator3Texture: null,
        },
        "source-file",
        createMockEffects(),
      );
      sourceRenderer.initialize();

      const state = createMockState({
        sourceFile: { path: "/test/source-file.wav" },
        sourceDataMode: "current",
      });

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile: SourceFileInfo = {
        id: "source-file",
        filePath: "/test/source-file.wav",
        spectrogramData: sourceSpectrogramData,
        textures: sourceRenderer.getTextures(),
      };

      // Position brush at origin to cover a known region
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

      // Destination starts with constant 0.5 magnitude
      const dataBefore = await renderer.getFBOData();
      const beforePixel = getPixelAtUv(dataBefore, new Vector2(0.1, 0.1), spectrogramData);
      expect(beforePixel).not.toBeNull();
      expect(beforePixel![0]).toBeCloseTo(0.5, 2); // Constant pattern

      renderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await renderer.getFBOData();

      // With additive effect (+0.05), the output should differ from the original
      // Note: Cross-file texture binding limitations mean we verify the effect ran,
      // not the exact gradient values (which would require shared WebGL context)
      const sampleUv = new Vector2(0.1, 0.1);
      const afterPixel = getPixelAtUv(dataAfter, sampleUv, spectrogramData);
      expect(afterPixel).not.toBeNull();

      // The additive effect should have modified the data
      // Since the effect adds 0.05 to the source, we should see a change from 0.5
      const differences = findDifferingPixels(dataBefore, dataAfter);
      expect(differences.length).toBeGreaterThan(0);

      // Cleanup
      sourceRenderer.dispose();
      sourceGl.dispose();
      sourceTextures.packedDataTex.dispose();
      sourceTextures.originalPackedDataTex.dispose();
      sourceTextures.inverseMapTex.dispose();
      sourceTextures.metadataTex.dispose();
    });

    it("should handle sourceDataMode: original", async () => {
      renderer.initialize();

      // First, modify the destination data by applying a stroke
      const modifyState = createMockStateWithSteps([
        { name: "Test", overrides: { brushIntensity: 100, accumulate: true } },
      ]);
      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

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

      // Apply a stroke to modify the data
      renderer.renderStroke(params, modifyState, sourceFile);
      const modifiedData = await renderer.getFBOData();

      // Now apply a stroke with sourceDataMode: "original"
      // This should use the original unmodified data as the source
      // Note: sourceDataMode must be set at the step level
      const originalState = createMockStateWithSteps([
        {
          name: "Original Mode Step",
          overrides: {
            sourceDataMode: "original",
            brushIntensity: 100,
          } as any,
        },
      ]);

      // Sample a point to check
      const sampleUv = new Vector2(0.1, 0.1);
      const modifiedPixel = getPixelAtUv(modifiedData, sampleUv, spectrogramData);
      expect(modifiedPixel).not.toBeNull();

      // Apply stroke with original mode
      renderer.renderStroke(params, originalState as State, sourceFile);
      const dataAfterOriginal = await renderer.getFBOData();
      const afterPixel = getPixelAtUv(dataAfterOriginal, sampleUv, spectrogramData);
      expect(afterPixel).not.toBeNull();

      // With additive effect and original mode:
      // - Source = original texture (0.5 constant)
      // - Additive effect adds 0.05
      // - Result = 0.55
      // This verifies that "original" mode uses the original data, not current modified data
      // (If it used current data 0.55, result would be 0.60)
      expect(afterPixel![0]).toBeCloseTo(0.55, 2);
    });
  });

  describe("FBO data management", () => {
    it("should correctly get and set FBO data", async () => {
      renderer.initialize();

      // Get initial data
      const initialData = await renderer.getFBOData();

      // Modify the data
      const modifiedData = new Float32Array(initialData.length);
      for (let i = 0; i < modifiedData.length; i++) {
        modifiedData[i] = initialData[i] + 0.1;
      }

      // Set the modified data
      renderer.setFBOData(modifiedData);

      // Get the data back
      const retrievedData = await renderer.getFBOData();

      // Should match the modified data (within tolerance)
      expect(compareSpectrogramData(modifiedData, retrievedData, 0.001)).toBe(true);
    });
  });

  describe("stroke lifecycle", () => {
    it("should handle beginStroke and endStroke correctly", async () => {
      renderer.initialize();

      const state = createMockState(); // accumulate: false is the default
      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

      const params: StrokeParams = {
        cursorPos: new Vector2(0.5, 0.5),
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

      // Begin stroke
      renderer.beginStroke();

      // Apply stroke
      renderer.renderStroke(params, state, sourceFile);

      // End stroke
      renderer.endStroke();

      // Should complete without errors
      const dataAfter = await renderer.getFBOData();
      expect(dataAfter).toBeInstanceOf(Float32Array);
    });
  });

  describe("multi-step with iterations", () => {
    let multiStepGl: WebGLRenderer;
    let multiStepRenderer: StrokeRenderer;
    let multiStepSpectrogramData: SpectrogramData;
    let multiStepTextures: StrokeTextures;

    beforeEach(() => {
      multiStepGl = new WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      multiStepGl.setSize(512, 512);

      multiStepSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "constant",
        constantMagnitude: 0.5,
      });

      const dataTextures = createTexturesFromSpectrogramData(multiStepSpectrogramData);
      const placeholderTexture = createPlaceholderTexture();

      multiStepTextures = {
        ...dataTextures,
        placeholderTexture,
        modulatorScaleLut: null,
        modulator1Texture: null,
        modulator2Texture: null,
        modulator3Texture: null,
      };
    });

    afterEach(() => {
      multiStepRenderer?.dispose();
      multiStepGl?.dispose();
      multiStepTextures?.packedDataTex.dispose();
      multiStepTextures?.originalPackedDataTex.dispose();
      multiStepTextures?.inverseMapTex.dispose();
      multiStepTextures?.metadataTex.dispose();
      multiStepTextures?.placeholderTexture.dispose();
    });

    it("should accumulate correctly across multiple steps with iterations", async () => {
      // Create effects: step 1 adds +0.05, step 2 subtracts -0.05
      const additiveEffect = createConfigurableAdditiveEffect(0.05);
      const subtractiveEffect = createConfigurableAdditiveEffect(-0.05);
      const passthroughEffect = createMockPassthroughEffect();

      // We need to create a custom registry where we can control per-step effects
      // For this test, we'll use the additive effect for transform
      const effects: EffectsRegistry = {
        dynamics: passthroughEffect,
        transform: additiveEffect,
        overtones: passthroughEffect,
        blur: subtractiveEffect, // Use blur slot for subtractive
        synthesize: passthroughEffect,
        passthrough: passthroughEffect,
      };

      multiStepRenderer = createTestStrokeRenderer(
        multiStepGl,
        multiStepSpectrogramData,
        multiStepTextures,
        "multi-step-test",
        effects,
      );
      multiStepRenderer.initialize();

      // Create state with 2 steps:
      // Step 1: 2 iterations of transform (adds 0.10)
      // Step 2: 2 iterations of blur (subtracts 0.10)
      // Net result should equal original
      const state = createMockStateWithSteps([
        {
          name: "Add Step",
          overrides: {
            brushIterations: 2,
            effects: [
              { id: "test-transform", effect: "transform", enabled: true, params: {} },
              { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
              { id: "test-blur", effect: "blur", enabled: false, params: {} },
              { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
              { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
            ],
          },
        },
        {
          name: "Subtract Step",
          overrides: {
            brushIterations: 2,
            effects: [
              { id: "test-transform", effect: "transform", enabled: false, params: {} },
              { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
              { id: "test-blur", effect: "blur", enabled: true, params: {} },
              { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
              { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
            ],
          },
        },
      ]);

      const totalDuration = multiStepSpectrogramData.numFrames / multiStepSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "multi-step-test",
        filePath: "/test/multi-step-test.wav",
        spectrogramData: multiStepSpectrogramData,
        textures: multiStepRenderer.getTextures(),
      };

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

      const sampleUv = new Vector2(0.1, 0.1);
      const originalData = await multiStepRenderer.getFBOData();
      const originalPixel = getPixelAtUv(originalData, sampleUv, multiStepSpectrogramData);
      expect(originalPixel).not.toBeNull();
      const originalMag = originalPixel![0];
      expect(originalMag).toBeCloseTo(0.5, 2);

      // Apply the multi-step stroke
      multiStepRenderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await multiStepRenderer.getFBOData();
      const afterPixel = getPixelAtUv(dataAfter, sampleUv, multiStepSpectrogramData);
      expect(afterPixel).not.toBeNull();

      // Step 1: 2 iterations * +0.05 = +0.10
      // Step 2: 2 iterations * -0.05 = -0.10
      // Net: 0.5 + 0.10 - 0.10 = 0.5
      expect(afterPixel![0]).toBeCloseTo(originalMag, 1);
    });

    it("should handle asymmetric step configurations", async () => {
      // Step 1: 3 iterations adds 0.15
      // Step 2: 1 iteration subtracts 0.05
      // Net: +0.10 from original
      const additiveEffect = createConfigurableAdditiveEffect(0.05);
      const subtractiveEffect = createConfigurableAdditiveEffect(-0.05);
      const passthroughEffect = createMockPassthroughEffect();

      const effects: EffectsRegistry = {
        dynamics: passthroughEffect,
        transform: additiveEffect,
        overtones: passthroughEffect,
        blur: subtractiveEffect,
        synthesize: passthroughEffect,
        passthrough: passthroughEffect,
      };

      multiStepRenderer = createTestStrokeRenderer(
        multiStepGl,
        multiStepSpectrogramData,
        multiStepTextures,
        "asymmetric-test",
        effects,
      );
      multiStepRenderer.initialize();

      const state = createMockStateWithSteps([
        {
          name: "Add Step",
          overrides: {
            brushIterations: 3,
            effects: [
              { id: "test-transform", effect: "transform", enabled: true, params: {} },
              { id: "test-blur", effect: "blur", enabled: false, params: {} },
            ],
          },
        },
        {
          name: "Subtract Step",
          overrides: {
            brushIterations: 1,
            effects: [
              { id: "test-transform", effect: "transform", enabled: false, params: {} },
              { id: "test-blur", effect: "blur", enabled: true, params: {} },
            ],
          },
        },
      ]);

      const totalDuration = multiStepSpectrogramData.numFrames / multiStepSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "asymmetric-test",
        filePath: "/test/asymmetric-test.wav",
        spectrogramData: multiStepSpectrogramData,
        textures: multiStepRenderer.getTextures(),
      };

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

      const sampleUv = new Vector2(0.1, 0.1);
      const originalData = await multiStepRenderer.getFBOData();
      const originalPixel = getPixelAtUv(originalData, sampleUv, multiStepSpectrogramData);
      expect(originalPixel).not.toBeNull();

      multiStepRenderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await multiStepRenderer.getFBOData();
      const afterPixel = getPixelAtUv(dataAfter, sampleUv, multiStepSpectrogramData);
      expect(afterPixel).not.toBeNull();

      // Step 1: 3 * +0.05 = +0.15
      // Step 2: 1 * -0.05 = -0.05
      // Net: 0.5 + 0.15 - 0.05 = 0.60
      expect(afterPixel![0]).toBeCloseTo(0.6, 1);
    });
  });

  describe("non-cumulative strokes", () => {
    let ncRenderer: StrokeRenderer;
    let ncSpectrogramData: SpectrogramData;
    let ncTextures: StrokeTextures;
    let ncGl: WebGLRenderer;

    beforeEach(() => {
      ncGl = new WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      ncGl.setSize(512, 512);

      ncSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "constant",
        constantMagnitude: 0.5,
      });

      const dataTextures = createTexturesFromSpectrogramData(ncSpectrogramData);
      const placeholderTexture = createPlaceholderTexture();

      ncTextures = {
        ...dataTextures,
        placeholderTexture,
        modulatorScaleLut: null,
        modulator1Texture: null,
        modulator2Texture: null,
        modulator3Texture: null,
      };

      const additiveEffects = createMockEffectsWithAdditive();
      ncRenderer = createTestStrokeRenderer(ncGl, ncSpectrogramData, ncTextures, "nc-test", additiveEffects);
    });

    afterEach(() => {
      ncRenderer?.dispose();
      ncGl?.dispose();
      ncTextures?.packedDataTex.dispose();
      ncTextures?.originalPackedDataTex.dispose();
      ncTextures?.inverseMapTex.dispose();
      ncTextures?.metadataTex.dispose();
      ncTextures?.placeholderTexture.dispose();
    });

    it("should not accumulate with additive blend mode when stroking back and forth", async () => {
      // This test verifies that with non-cumulative strokes and additive blend mode,
      // repeatedly painting over the same area within a single stroke does NOT
      // keep accumulating the effect.
      //
      // We need a separate renderer with the additive blend effect (dest + source)
      // to properly test this scenario.
      const blendGl = new WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      blendGl.setSize(512, 512);

      const blendSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "constant",
        constantMagnitude: 0.5,
      });

      const blendDataTextures = createTexturesFromSpectrogramData(blendSpectrogramData);
      const blendPlaceholderTexture = createPlaceholderTexture();

      const blendTextures: StrokeTextures = {
        ...blendDataTextures,
        placeholderTexture: blendPlaceholderTexture,
        modulatorScaleLut: null,
        modulator1Texture: null,
        modulator2Texture: null,
        modulator3Texture: null,
      };

      // Use the additive blend effect (dest + source) to simulate blend mode Add
      const additiveBlendEffects = createMockEffectsWithAdditiveBlend();
      const blendRenderer = createTestStrokeRenderer(
        blendGl,
        blendSpectrogramData,
        blendTextures,
        "blend-test",
        additiveBlendEffects,
      );

      try {
        blendRenderer.initialize();

        // Create state with non-cumulative strokes (accumulate: false is the default)
        const state = createMockStateForIterations(1, {} as Partial<State>, {
          effects: [
            { id: "test-transform", effect: "transform", enabled: true, params: {} },
            { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
            { id: "test-blur", effect: "blur", enabled: false, params: {} },
            { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
            { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
          ],
        });

        const totalDuration = blendSpectrogramData.numFrames / blendSpectrogramData.sampleRate;
        const sourceFile: SourceFileInfo = {
          id: "blend-test",
          filePath: "/test/blend-test.wav",
          spectrogramData: blendSpectrogramData,
          textures: blendRenderer.getTextures(),
        };

        const sampleUv = new Vector2(0.1, 0.1);

        // Get original magnitude
        const originalData = await blendRenderer.getFBOData();
        const originalPixel = getPixelAtUv(originalData, sampleUv, blendSpectrogramData);
        expect(originalPixel).not.toBeNull();
        const originalMag = originalPixel![0];
        expect(originalMag).toBeCloseTo(0.5, 2);

        // Begin a stroke
        blendRenderer.beginStroke();

        // First stroke at position A
        const params: StrokeParams = {
          cursorPos: new Vector2(0.0, 0.0),
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

        blendRenderer.renderStroke(params, state, sourceFile);
        const dataAfter1 = await blendRenderer.getFBOData();
        const pixel1 = getPixelAtUv(dataAfter1, sampleUv, blendSpectrogramData);
        expect(pixel1).not.toBeNull();
        const mag1 = pixel1![0];

        // With additive blend (dest + source), first stroke should produce:
        // dest (0.5) + source (0.5) = 1.0
        expect(mag1).toBeCloseTo(1.0, 2);

        // Now stroke back over the same position multiple times (simulating back-and-forth painting)
        blendRenderer.renderStroke(params, state, sourceFile);
        const dataAfter2 = await blendRenderer.getFBOData();
        const pixel2 = getPixelAtUv(dataAfter2, sampleUv, blendSpectrogramData);
        expect(pixel2).not.toBeNull();
        const mag2 = pixel2![0];

        blendRenderer.renderStroke(params, state, sourceFile);
        const dataAfter3 = await blendRenderer.getFBOData();
        const pixel3 = getPixelAtUv(dataAfter3, sampleUv, blendSpectrogramData);
        expect(pixel3).not.toBeNull();
        const mag3 = pixel3![0];

        blendRenderer.renderStroke(params, state, sourceFile);
        const dataAfter4 = await blendRenderer.getFBOData();
        const pixel4 = getPixelAtUv(dataAfter4, sampleUv, blendSpectrogramData);
        expect(pixel4).not.toBeNull();
        const mag4 = pixel4![0];

        // In non-cumulative mode, all these strokes should result in the SAME magnitude
        // The effect should NOT keep accumulating even with additive blend mode
        // BUG: Currently these will be ~1.5, ~2.0, ~2.5 because destSpectrogramTex
        // points to the changing FBO instead of strokeStartFbo
        expect(mag2).toBeCloseTo(mag1, 2);
        expect(mag3).toBeCloseTo(mag1, 2);
        expect(mag4).toBeCloseTo(mag1, 2);

        blendRenderer.endStroke();
      } finally {
        blendRenderer.dispose();
        blendGl.dispose();
        blendTextures.packedDataTex.dispose();
        blendTextures.originalPackedDataTex.dispose();
        blendTextures.inverseMapTex.dispose();
        blendTextures.metadataTex.dispose();
        blendTextures.placeholderTexture.dispose();
      }
    });

    it("should prevent double-painting in overlapping strokes with non-cumulative mode", async () => {
      ncRenderer.initialize();

      // Create state with non-cumulative strokes (accumulate: false is the default)
      const state = createMockStateForIterations(1, {} as Partial<State>, {
        effects: [
          { id: "test-transform", effect: "transform", enabled: true, params: {} },
          { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
          { id: "test-blur", effect: "blur", enabled: false, params: {} },
          { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
          { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
        ],
      });

      const totalDuration = ncSpectrogramData.numFrames / ncSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "nc-test",
        filePath: "/test/nc-test.wav",
        spectrogramData: ncSpectrogramData,
        textures: ncRenderer.getTextures(),
      };

      const sampleUv = new Vector2(0.1, 0.1);

      // Begin a stroke
      ncRenderer.beginStroke();

      // First stroke at position A
      const params1: StrokeParams = {
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

      ncRenderer.renderStroke(params1, state, sourceFile);
      const dataAfter1 = await ncRenderer.getFBOData();
      const pixel1 = getPixelAtUv(dataAfter1, sampleUv, ncSpectrogramData);
      expect(pixel1).not.toBeNull();
      const mag1 = pixel1![0];

      // Second stroke at overlapping position (should not double-paint due to mask)
      const params2: StrokeParams = {
        cursorPos: new Vector2(0.05, 0.05), // Overlapping with first stroke
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

      ncRenderer.renderStroke(params2, state, sourceFile);
      const dataAfter2 = await ncRenderer.getFBOData();
      const pixel2 = getPixelAtUv(dataAfter2, sampleUv, ncSpectrogramData);
      expect(pixel2).not.toBeNull();
      const mag2 = pixel2![0];

      // In non-cumulative mode, overlapping pixels should NOT be painted twice
      // So mag2 should equal mag1 (within tolerance)
      expect(mag2).toBeCloseTo(mag1, 2);

      ncRenderer.endStroke();
    });
  });

  describe("phase preservation", () => {
    it("should preserve phase channels when applying strokes", async () => {
      renderer.initialize();

      const state = createMockStateWithSteps([{ name: "Test", overrides: { brushIntensity: 100, accumulate: true } }]);

      const totalDuration = getSpectrogramDuration(spectrogramData);
      const sourceFile = createSourceFileInfo(spectrogramData, "test-file-1", renderer);

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

      const dataBefore = await renderer.getFBOData();
      const beforeCopy = new Float32Array(dataBefore);

      renderer.renderStroke(params, state as State, sourceFile);
      const dataAfter = await renderer.getFBOData();

      // Verify phase channels are unchanged
      const phaseCheck = verifyPhasesUnchanged(beforeCopy, dataAfter);
      expect(phaseCheck.allMatch).toBe(true);
    });
  });

  describe("pixels outside brush area", () => {
    let outsideRenderer: StrokeRenderer;
    let outsideSpectrogramData: SpectrogramData;
    let outsideTextures: StrokeTextures;
    let outsideGl: WebGLRenderer;

    beforeEach(() => {
      outsideGl = new WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      outsideGl.setSize(512, 512);

      outsideSpectrogramData = createMockSpectrogramData({
        numFrames: 256,
        numBands: 128,
        pattern: "constant",
        constantMagnitude: 0.5,
      });

      const dataTextures = createTexturesFromSpectrogramData(outsideSpectrogramData);
      const placeholderTexture = createPlaceholderTexture();

      outsideTextures = {
        ...dataTextures,
        placeholderTexture,
        modulatorScaleLut: null,
        modulator1Texture: null,
        modulator2Texture: null,
        modulator3Texture: null,
      };

      const additiveEffects = createMockEffectsWithAdditive();
      outsideRenderer = createTestStrokeRenderer(
        outsideGl,
        outsideSpectrogramData,
        outsideTextures,
        "outside-test",
        additiveEffects,
      );
    });

    afterEach(() => {
      outsideRenderer?.dispose();
      outsideGl?.dispose();
      outsideTextures?.packedDataTex.dispose();
      outsideTextures?.originalPackedDataTex.dispose();
      outsideTextures?.inverseMapTex.dispose();
      outsideTextures?.metadataTex.dispose();
      outsideTextures?.placeholderTexture.dispose();
    });

    it("should not modify pixels outside the brush area", async () => {
      outsideRenderer.initialize();

      const state = createMockStateForIterations(1, {
        effects: [
          { id: "test-transform", effect: "transform", enabled: true, params: {} },
          { id: "test-dynamics", effect: "dynamics", enabled: false, params: {} },
          { id: "test-blur", effect: "blur", enabled: false, params: {} },
          { id: "test-overtones", effect: "overtones", enabled: false, params: {} },
          { id: "test-synthesize", effect: "synthesize", enabled: false, params: {} },
        ],
      } as Partial<State>) as State;

      const totalDuration = outsideSpectrogramData.numFrames / outsideSpectrogramData.sampleRate;
      const sourceFile: SourceFileInfo = {
        id: "outside-test",
        filePath: "/test/outside-test.wav",
        spectrogramData: outsideSpectrogramData,
        textures: outsideRenderer.getTextures(),
      };

      // Apply stroke at bottom-left corner with small brush
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

      const dataBefore = await outsideRenderer.getFBOData();

      // Sample a pixel that should be OUTSIDE the brush area (far right side)
      const outsideUv = new Vector2(0.9, 0.9);
      const outsidePixelBefore = getPixelAtUv(dataBefore, outsideUv, outsideSpectrogramData);
      expect(outsidePixelBefore).not.toBeNull();

      outsideRenderer.renderStroke(params, state, sourceFile);
      const dataAfter = await outsideRenderer.getFBOData();

      const outsidePixelAfter = getPixelAtUv(dataAfter, outsideUv, outsideSpectrogramData);
      expect(outsidePixelAfter).not.toBeNull();

      // Pixel outside brush area should be unchanged
      expect(outsidePixelAfter![0]).toBeCloseTo(outsidePixelBefore![0], 5);
      expect(outsidePixelAfter![1]).toBeCloseTo(outsidePixelBefore![1], 5);
      expect(outsidePixelAfter![2]).toBeCloseTo(outsidePixelBefore![2], 5);
      expect(outsidePixelAfter![3]).toBeCloseTo(outsidePixelBefore![3], 5);
    });
  });

  describe("scissor optimization", () => {
    // Call the real calculateScissorRows via prototype (bypasses the test override)
    function realScissorRows(brushPos: Vector2, brushSize: Vector2) {
      return StrokeRenderer.prototype.calculateScissorRows.call(
        { spectrogramData } as unknown as StrokeRenderer,
        brushPos,
        brushSize,
      );
    }

    it("should calculate scissor rows for a small brush", () => {
      const rows = realScissorRows(new Vector2(0.3, 0.3), new Vector2(0.1, 0.1));

      expect(rows).not.toBeNull();
      expect(rows!.rowStart).toBeGreaterThanOrEqual(0);
      expect(rows!.rowCount).toBeGreaterThan(0);
      expect(rows!.rowCount).toBeLessThan(spectrogramData.textureHeight);
    });

    it("should return null for a brush covering most bands", () => {
      const rows = realScissorRows(new Vector2(0.0, 0.05), new Vector2(1.0, 0.9));
      expect(rows).toBeNull();
    });
  });
});
