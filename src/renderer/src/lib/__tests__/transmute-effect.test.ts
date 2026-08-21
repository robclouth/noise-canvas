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

  const PART = { mag: 0, phase: 1, time: 2, pitch: 3, pan: 4 } as const;
  type Part = keyof typeof PART;
  const PARTS = Object.keys(PART) as Part[];

  const route = (id: string, from: Part, to: Part, params: Record<string, number> = {}): ChainItem => ({
    id,
    effect: "transmute",
    params: { transmuteFrom: PART[from], transmuteTo: PART[to], transmuteAmount: 1, transmuteCurve: 1, ...params },
  });

  /** Phase→Magnitude opens the swap, Magnitude→Phase closes it. */
  const openSwap = (id: string): ChainItem => route(id, "phase", "mag");
  const closeSwap = (id: string): ChainItem => route(id, "mag", "phase");

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
      const state = smallBrushState([openSwap("in"), { id: "mid", effect: "transform", params }, closeSwap("out")]);
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
    const bookends = await runChain([openSwap("in"), neutralTransform, closeSwap("out")]);

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
    const pair = await runChain([openSwap("in"), closeSwap("out")]);
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

  it("is the identity on the routes from a part to itself, and moves everything else", async () => {
    // Time → Time and Pitch → Pitch are stretches, not identities: a band at
    // the edge of the brush reads from a beat or a semitone away.
    const identities = new Set(["mag-mag", "phase-phase", "pan-pan"]);
    for (const from of PARTS) {
      for (const to of PARTS) {
        const run = await runChain([route(`${from}-${to}`, from, to)]);
        const change = relativeError(run.before, run.after);
        if (identities.has(`${from}-${to}`)) expect(change, `${from}→${to}`).toBeLessThan(1e-4);
        else expect(change, `${from}→${to}`).toBeGreaterThan(0.3);
      }
    }
  });

  it("turns the spectrum inside out when Magnitude→Magnitude runs a negative curve", async () => {
    const inverted = await runChain([route("neg", "mag", "mag", { transmuteCurve: -1 })]);
    let loudest = 0;
    let quietest = 0;
    for (let i = 0; i < inverted.before.length; i += 4) {
      if (inverted.before[i] > inverted.before[loudest]) loudest = i;
      if (inverted.before[i] < inverted.before[quietest]) quietest = i;
    }
    expect(inverted.after[loudest]).toBeLessThan(inverted.after[quietest]);
  });

  it("moves content when a route reaches into time or pitch", async () => {
    // A displacement route reads each bin from somewhere else, so the level
    // pattern has to change while the loudest bin stays a real level.
    for (const to of ["time", "pitch"] as const) {
      for (const from of ["mag", "phase"] as const) {
        const run = await runChain([route(`${from}-${to}`, from, to, { transmuteAmount: 4 })]);
        let moved = 0;
        for (let i = 0; i < run.before.length; i += 4) {
          if (Math.abs(run.before[i] - run.after[i]) > 1e-4) moved++;
        }
        expect(moved, `${from}→${to}`).toBeGreaterThan(0);
        expect(peakMagnitude(run.after), `${from}→${to}`).toBeLessThanOrEqual(peakMagnitude(run.before) * 1.01);
      }
    }
  });

  it("sweeps the sound across the speakers when time drives pan", async () => {
    // Time is read as the position inside the brush, so the brush has to sit
    // inside the file for its edges to land on frames: a quarter beat at 120
    // is 125 of the mock's 128 frames, and six semitones its bottom 12 bands.
    const { numFrames } = spectrogramData;
    const state = smallBrushState([route("sweep", "time", "pan")]);
    const renderer = createRenderer();
    const sourceFile = createSourceFile(renderer);
    const before = (await renderer.getFBOData()).slice();
    renderer.renderStroke(strokeParams(), state, sourceFile);
    const after = (await renderer.getFBOData()).slice();
    renderer.dispose();

    const band = 25;
    const place = (frame: number): number => {
      const i = (band * numFrames + frame) * 4;
      return after[i + 2] / (after[i] + after[i + 2]);
    };
    expect(place(2)).toBeLessThan(0.1);
    expect(place(120)).toBeGreaterThan(0.9);
    // The band's energy went nowhere; it was only split.
    const i = (band * numFrames + 60) * 4;
    expect(after[i] + after[i + 2]).toBeCloseTo(before[i] + before[i + 2], 5);
  });

  it("moves the sound the same way as the Transform for the same distance", async () => {
    // The mock's pan is the same in every bin, so Pan → Time is one flat move
    // of 2 × (pan − ½) × Amount beats. Transform shifting that far has to land
    // on the same pixels, away from the edges where their edge rules differ.
    const { numFrames, numBands } = spectrogramData;
    const pan = 0.8 / 1.8;
    const beats = (pan - 0.5) * 2;
    const viaRoute = await runChain([route("pan-time", "pan", "time", { transmuteAmount: 1 })]);
    const viaTransform = await runChain([{ id: "shift", effect: "transform", params: { transformShiftBeats: beats } }]);

    // The sound moves earlier here, so the last frames of the row read past
    // the end of the file and are left out.
    const shiftFrames = Math.round(-beats * 0.5 * 1000);
    let worst = 0;
    for (let band = 0; band < numBands; band++) {
      for (let frame = 2; frame < numFrames - shiftFrames - 2; frame++) {
        const i = (band * numFrames + frame) * 4;
        worst = Math.max(worst, Math.abs(viaRoute.after[i] - viaTransform.after[i]));
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });
});
