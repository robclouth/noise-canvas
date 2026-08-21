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

import { EffectType } from "../../effects/types";
import { NEUTRAL_ALGORITHM } from "../constants";
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

type ChainItem = { id: string; effect: EffectType; params: Record<string, number> };

function createChainState(chain: ChainItem[]): State {
  const effects = chain.map((item) => ({ ...item, enabled: true }));
  const state = createMockState({
    effects,
    algorithm: NEUTRAL_ALGORITHM,
    filepathsBpm: { "/test/transmute-test.wav": 120 },
  });
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    const step = activeSteps[0] as unknown as Record<string, unknown>;
    step.effects = effects;
    step.algorithm = NEUTRAL_ALGORITHM;
  }
  return state;
}

/**
 * Magnitude and unwrapped phase as the analysis produces them: quiet
 * coefficients and a phase that accumulates along time to thousands of radians.
 */
function fillRunningPhase(spectrogramData: SpectrogramData, phaseScale = 1): void {
  const { packedData, numFrames, numBands } = spectrogramData;
  for (let band = 0; band < numBands; band++) {
    for (let frame = 0; frame < numFrames; frame++) {
      const i = (band * numFrames + frame) * 4;
      const mag = 0.02 + 0.04 * (0.5 + 0.5 * Math.sin((band / numBands) * Math.PI * 3 + frame * 0.03));
      const phase = (frame * 0.7 + band * 1.3) * phaseScale;
      packedData[i] = mag;
      packedData[i + 1] = phase;
      packedData[i + 2] = mag * 0.8;
      packedData[i + 3] = phase * 0.97;
    }
  }
}

describe("Transmute effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTexturesFromSpectrogramData>;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    const [{ transmuteEffect }, { transformEffect }, { passThroughEffect }] = await Promise.all([
      import("../../effects/transmute-effect"),
      import("../../effects/transform-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { transmute: transmuteEffect, transform: transformEffect, passthrough: passThroughEffect };

    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);

    spectrogramData = createMockSpectrogramData({
      numFrames: 128,
      numBands: 32,
      sampleRate: 1000,
      pattern: "constant",
      constantMagnitude: 0.05,
    });
    fillRunningPhase(spectrogramData);

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
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "transmute-test", effects);
    renderer.initialize();
    return renderer;
  }

  function createSourceFile(renderer: StrokeRenderer): SourceFileInfo {
    const rendererTextures = renderer.getTextures();
    return {
      id: "transmute-test",
      filePath: "/test/transmute-test.wav",
      displayName: "transmute-test.wav",
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

  async function runChain(chain: ChainItem[]): Promise<{ before: Float32Array; after: Float32Array }> {
    const renderer = createRenderer();
    const sourceFile = createSourceFile(renderer);
    const before = await renderer.getFBOData();
    renderer.renderStroke(strokeParams(), createChainState(chain), sourceFile);
    const after = await renderer.getFBOData();
    renderer.dispose();
    return { before: before.slice(), after: after.slice() };
  }

  /** Worst per-pixel complex error, relative to the loudest input magnitude. */
  function relativeError(before: Float32Array, after: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < before.length; i += 4) peak = Math.max(peak, before[i], before[i + 2]);
    let worst = 0;
    for (let i = 0; i < before.length; i += 4) {
      for (const c of [0, 2]) {
        const dx = before[i + c] * Math.cos(before[i + c + 1]) - after[i + c] * Math.cos(after[i + c + 1]);
        const dy = before[i + c] * Math.sin(before[i + c + 1]) - after[i + c] * Math.sin(after[i + c + 1]);
        worst = Math.max(worst, Math.hypot(dx, dy));
      }
    }
    return worst / Math.max(peak, 1e-12);
  }

  function peakMagnitude(data: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, data[i], data[i + 2]);
    return peak;
  }

  const swap = (id: string): ChainItem => ({
    id,
    effect: "transmute",
    params: { transmuteMode: 0, transmuteAmount: 1, transmuteCurve: 1 },
  });

  const neutralTransform: ChainItem = { id: "neutral", effect: "transform", params: {} };

  /** A brush that fits inside the file, so its envelope tapers over real data. */
  function smallBrushState(chain: ChainItem[]): State {
    const state = createChainState(chain);
    const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
    step.brushSizeTime = 0.25;
    step.brushSizePitch = 6;
    return state;
  }

  it("keeps the level when the pass between the swaps reads outside them", async () => {
    // Anything that moves content — a shift, a collapsed scale, an edge mode
    // that bleeds — reaches pixels the first swap never covered, which still
    // carry a full unwrapped phase. Reading that back as a level is what filled
    // the brush with a solid band.
    const middles: Array<[string, Record<string, number>]> = [
      ["neutral", {}],
      ["scales at zero", { transformScaleTime: 0, transformScalePitch: 0 }],
      ["shifted a beat", { transformShiftBeats: 0.25 }],
    ];
    for (const [name, params] of middles) {
      const state = smallBrushState([swap("in"), { id: "mid", effect: "transform", params }, swap("out")]);
      const renderer = createRenderer();
      const sourceFile = createSourceFile(renderer);
      const before = (await renderer.getFBOData()).slice();
      renderer.renderStroke(strokeParams(), state, sourceFile);
      const after = (await renderer.getFBOData()).slice();
      renderer.dispose();

      expect(peakMagnitude(after), name).toBeCloseTo(peakMagnitude(before), 5);
    }
  });

  it("puts the pair back when a second swap undoes the first", async () => {
    const bookends = await runChain([swap("in"), neutralTransform, swap("out")]);

    // 1e-4 of the loudest input bin is 80 dB down on it.
    expect(relativeError(bookends.before, bookends.after)).toBeLessThan(1e-4);
    expect(peakMagnitude(bookends.after)).toBeCloseTo(peakMagnitude(bookends.before), 4);
  });

  it("keeps the level exact and the phase within a degree when the phase has run far from zero", async () => {
    fillRunningPhase(spectrogramData, 1000);
    textures.packedDataTex.needsUpdate = true;
    textures.originalPackedDataTex.needsUpdate = true;

    // The level comes straight back off the stroke-start snapshot, so it is
    // exact. The phase is rebuilt around that snapshot's whole turns, and at
    // tens of thousands of radians one float32 step is already 0.008 rad, so it
    // lands a step or two off.
    const pair = await runChain([swap("in"), swap("out")]);
    let worstLevel = 0;
    let worstAngle = 0;
    for (let i = 0; i < pair.before.length; i += 4) {
      for (const c of [0, 2]) {
        worstLevel = Math.max(worstLevel, Math.abs(pair.before[i + c] - pair.after[i + c]));
        const delta = pair.after[i + c + 1] - pair.before[i + c + 1];
        worstAngle = Math.max(worstAngle, Math.abs(delta - Math.round(delta / (2 * Math.PI)) * 2 * Math.PI));
      }
    }
    expect(worstLevel).toBe(0);
    expect(worstAngle).toBeLessThan(0.02);
  });

  it("keeps the swapped phase image inside the level window", async () => {
    const swapped = await runChain([swap("only")]);
    expect(peakMagnitude(swapped.after)).toBeLessThanOrEqual(1.0);
  });

  it("changes the sound in every mode at its default settings", async () => {
    // Phase Multiply is the identity at amount 1 by construction; the rest have
    // to do something audible without being asked twice.
    for (const mode of [2, 3, 4, 5]) {
      const run = await runChain([{ id: `m${mode}`, effect: "transmute", params: { transmuteMode: mode } }]);
      expect(relativeError(run.before, run.after), `mode ${mode}`).toBeGreaterThan(0.5);
    }
  });

  it("multiplies the phase without collapsing the level", async () => {
    const doubled = await runChain([
      { id: "mul", effect: "transmute", params: { transmuteMode: 1, transmuteAmount: 2 } },
    ]);
    expect(relativeError(doubled.before, doubled.after)).toBeGreaterThan(0.5);
    expect(peakMagnitude(doubled.after)).toBeCloseTo(peakMagnitude(doubled.before), 4);
  });
});
