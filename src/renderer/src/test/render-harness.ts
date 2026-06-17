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
import type { EffectType } from "../effects/types";
import type { SpectrogramData, State } from "../store/types";
import { createMockState } from "./mock-state";
import type { SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../lib/stroke-renderer";

/**
 * Shared rendering harness for tests that need a real WebGL StrokeRenderer
 * driven by the production effect shaders. Mirrors the texture-upload and
 * state-construction glue used in effects.test.ts so perf and correctness
 * suites build identical renderer setups.
 */

export interface HarnessTextures {
  packedDataTex: DataTexture;
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
  placeholderTexture: DataTexture;
  modulatorScaleLut: DataTexture;
}

/** Uploads packed spectrogram data into the GPU textures the renderer samples from. */
export function createSpectrogramTextures(spectrogramData: SpectrogramData): {
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
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
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

/** Builds the full texture set, including placeholders and the modulator LUT. */
export function createHarnessTextures(spectrogramData: SpectrogramData): HarnessTextures {
  const spec = createSpectrogramTextures(spectrogramData);
  return {
    ...spec,
    placeholderTexture: createPlaceholderTexture(),
    modulatorScaleLut: createModulatorScaleLut(),
  };
}

/** Assembles the StrokeTextures the renderer constructor expects. */
export function toStrokeTextures(t: HarnessTextures): StrokeTextures {
  return {
    packedDataTex: t.packedDataTex,
    originalPackedDataTex: t.originalPackedDataTex,
    inverseMapTex: t.inverseMapTex,
    metadataTex: t.metadataTex,
    placeholderTexture: t.placeholderTexture,
    modulatorScaleLut: t.modulatorScaleLut,
    modulator1Texture: t.placeholderTexture,
    modulator2Texture: t.placeholderTexture,
    modulator3Texture: t.placeholderTexture,
  };
}

export function disposeHarnessTextures(t: HarnessTextures): void {
  t.packedDataTex.dispose();
  t.originalPackedDataTex.dispose();
  t.inverseMapTex.dispose();
  t.metadataTex.dispose();
  t.placeholderTexture.dispose();
  t.modulatorScaleLut.dispose();
}

const HARNESS_FILE_PATH = "/test/harness.wav";

/**
 * Builds a State with the given effects enabled (in registry order) on the
 * active brush's first step, mirroring createStateForEffect in effects.test.ts.
 */
export interface EffectStateOptions {
  /** Brush time footprint in beats, stamped onto the active step. */
  brushSizeTime?: number;
  /** Brush pitch footprint in semitones, stamped onto the active step. */
  brushSizePitch?: number;
  overrides?: Partial<State>;
}

export function createStateForEffects(enabled: EffectType[], options: EffectStateOptions = {}): State {
  const { brushSizeTime, brushSizePitch, overrides = {} } = options;
  const effectItems = enabled.map((effect) => ({
    id: `perf-${effect}`,
    effect,
    enabled: true,
    params: {} as Record<string, unknown>,
  }));

  const state = createMockState({
    effects: effectItems,
    filepathsBpm: { [HARNESS_FILE_PATH]: 120 },
    ...(brushSizeTime !== undefined ? { brushSizeTime } : {}),
    ...(brushSizePitch !== undefined ? { brushSizePitch } : {}),
    ...overrides,
  });

  // Step fields take precedence over state-level ones (step?.x ?? state.x), so
  // brush size and effects must be written onto the step to take effect.
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    const step = activeSteps[0] as Record<string, unknown>;
    step.effects = effectItems;
    if (brushSizeTime !== undefined) step.brushSizeTime = brushSizeTime;
    if (brushSizePitch !== undefined) step.brushSizePitch = brushSizePitch;
  }

  return state;
}

/** Source info pointing the renderer at its own textures (same-file painting). */
export function createSourceFile(renderer: StrokeRenderer, spectrogramData: SpectrogramData): SourceFileInfo {
  const t = renderer.getTextures();
  return {
    id: "harness",
    filePath: HARNESS_FILE_PATH,
    displayName: "harness.wav",
    spectrogramData,
    textures: { packed: t.packed, inverse: t.inverse, metadata: t.metadata, original: t.original },
  };
}

/**
 * Builds StrokeParams for a stroke at a UV position. totalDuration is sized so
 * the default 1-beat brush covers a realistic fraction of the texture rather
 * than the whole width.
 */
export function makeStrokeParams(
  cursorPos: Vector2,
  spectrogramData: SpectrogramData,
  overrides: Partial<StrokeParams> = {},
): StrokeParams {
  return {
    cursorPos,
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
    ...overrides,
  };
}

/** Real WebGL2 renderer with ANGLE under headless Chromium. */
export function createGL(width = 256, height = 256): WebGLRenderer {
  const gl = new WebGLRenderer({ antialias: false });
  gl.setSize(width, height);
  return gl;
}
