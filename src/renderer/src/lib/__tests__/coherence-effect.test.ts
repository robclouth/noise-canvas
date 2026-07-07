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

function createTextures(spectrogramData: SpectrogramData) {
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
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = i / 255;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ coherenceEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/coherence-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { coherence: coherenceEffect, passthrough: passThroughEffect };
}

function createStateWithCoherence(chainAfterPassthrough = false): State {
  const effects = [
    ...(chainAfterPassthrough
      ? [{ id: "test-passthrough", effect: "passthrough" as const, enabled: true, params: {} }]
      : []),
    { id: "test-coherence", effect: "coherence" as const, enabled: true, params: {} },
  ];
  const state = createMockState({
    effects,
    filepathsBpm: { "/test/coherence-test.wav": 120 },
  });
  // Full-axis footprint with a flat rectangular envelope so the blend weight
  // is 1 across every tested pixel. Brush params are includeInStep, so they
  // must be set on the active step — the global values are ignored. Curve is
  // in percent units (100 -> curve 1.0 -> hard rectangle). Coherence is pinned
  // to strict-repair semantics (full strictness, no attack) so the ridge-model
  // assertions hold exactly; the attack test overrides these.
  const brushParams = {
    brushSizeTime: 32,
    brushSizePitch: 128,
    brushCurveTime: 100,
    brushCurvePitch: 100,
    coherenceStrictness: 100,
    coherenceAttack: 0,
  };
  Object.assign(state, brushParams);
  const activeSteps = state.brushes[state.activeBrushIndex]?.steps;
  if (activeSteps && activeSteps[0]) {
    Object.assign(activeSteps[0] as Record<string, unknown>, { effects, ...brushParams });
  }
  return state;
}

// Paints a stationary partial: a Gaussian magnitude ridge across bands over a
// flat floor, constant in time, with deterministic incoherent phases. Ridge
// width mirrors the shader's COH_ATOM_SIGMA_BANDS so skirts sit exactly on the
// predicted atom profile and lock at full weight; the floor sits far above the
// predicted skirt beyond ±2 bands, so it must keep the canvas phase untouched.
const ATOM_SIGMA_BANDS = 1.3;

function junkPhaseAt(band: number, frame: number): number {
  return Math.sin(band * 12.9898 + frame * 78.233) * Math.PI;
}

function paintRidge(spectrogramData: SpectrogramData, ridgeBand: number): void {
  const { numFrames, numBands, packedData } = spectrogramData;
  for (let band = 0; band < numBands; band++) {
    const arg = (band - ridgeBand) / ATOM_SIGMA_BANDS;
    const mag = Math.max(Math.exp(-arg * arg), 0.05);
    for (let frame = 0; frame < numFrames; frame++) {
      const base = (band * numFrames + frame) * 4;
      packedData[base] = mag;
      packedData[base + 1] = junkPhaseAt(band, frame);
      packedData[base + 2] = mag;
      packedData[base + 3] = junkPhaseAt(band, frame);
    }
  }
}

describe("Coherence effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTextures>;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    spectrogramData = createMockSpectrogramData({ numFrames: 32, numBands: 12, pattern: "silence" });
    paintRidge(spectrogramData, 6);
    textures = createTextures(spectrogramData);
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
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "coherence-test", effects);
    renderer.initialize();
    return renderer;
  }

  function createSourceFile(renderer: StrokeRenderer): SourceFileInfo {
    const t = renderer.getTextures();
    return {
      id: "coherence-test",
      filePath: "/test/coherence-test.wav",
      displayName: "coherence-test.wav",
      spectrogramData,
      textures: { packed: t.packed, inverse: t.inverse, metadata: t.metadata, original: t.original },
    };
  }

  const strokeParams: StrokeParams = {
    cursorPos: new Vector2(0.5, 0.5),
    preview: false,
    bpm: 120,
    totalDuration: 32 / 44100,
    viewZoomPower: 0,
    viewOffset: 0,
    viewZoomPowerY: 0,
    viewOffsetY: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
  };

  it("preserves magnitude exactly (phase-only effect) and produces no NaNs", async () => {
    const renderer = createRenderer();
    const before = await renderer.getFBOData();
    renderer.renderStroke(strokeParams, createStateWithCoherence(), createSourceFile(renderer));
    const after = await renderer.getFBOData();

    let maxMagDelta = 0;
    for (let i = 0; i < after.length; i += 4) {
      expect(Number.isFinite(after[i])).toBe(true); // magL
      expect(Number.isFinite(after[i + 1])).toBe(true); // phaseL
      expect(Number.isFinite(after[i + 2])).toBe(true); // magR
      expect(Number.isFinite(after[i + 3])).toBe(true); // phaseR
      maxMagDelta = Math.max(maxMagDelta, Math.abs(after[i] - before[i]), Math.abs(after[i + 2] - before[i + 2]));
    }
    expect(maxMagDelta).toBeLessThan(1e-4);

    renderer.dispose();
  });

  it("rewrites phase in the painted region", async () => {
    const renderer = createRenderer();
    const before = await renderer.getFBOData();
    renderer.renderStroke(strokeParams, createStateWithCoherence(), createSourceFile(renderer));
    const after = await renderer.getFBOData();

    let changedPhaseCount = 0;
    for (let i = 0; i < after.length; i += 4) {
      const magL = after[i];
      if (magL < 1e-3) continue; // skip silent bins the effect intentionally leaves alone
      if (Math.abs(after[i + 1] - before[i + 1]) > 1e-3) changedPhaseCount++;
    }
    expect(changedPhaseCount).toBeGreaterThan(0);

    renderer.dispose();
  });
});

describe("Coherence vertical lock", () => {
  const NUM_FRAMES = 256;
  const NUM_BANDS = 48;
  const SAMPLE_RATE = 8000;
  const RIDGE_BAND = 24;

  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: ReturnType<typeof createTextures>;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);

    spectrogramData = createMockSpectrogramData({
      numFrames: NUM_FRAMES,
      numBands: NUM_BANDS,
      sampleRate: SAMPLE_RATE,
      minFreq: 20,
      bandsPerOctave: 12,
      pattern: "silence",
    });
    paintRidge(spectrogramData, RIDGE_BAND);

    textures = createTextures(spectrogramData);
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

  async function runStrokeAndAssertLock(chainAfterPassthrough: boolean): Promise<void> {
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
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "coherence-lock-test", effects);
    renderer.initialize();

    const rendererTextures = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "coherence-lock-test",
      filePath: "/test/coherence-lock-test.wav",
      displayName: "coherence-lock-test.wav",
      spectrogramData,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };

    const state = createStateWithCoherence(chainAfterPassthrough);

    renderer.renderStroke(
      {
        cursorPos: new Vector2(0.5, 0.5),
        preview: false,
        bpm: 120,
        totalDuration: NUM_FRAMES / SAMPLE_RATE,
        viewZoomPower: 0,
        viewOffset: 0,
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
      },
      state,
      sourceFile,
    );
    const after = await renderer.getFBOData();

    const wrapToPi = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    const phaseAt = (band: number, frame: number) => after[(band * NUM_FRAMES + frame) * 4 + 1];
    const freqOf = (band: number) => spectrogramData.metadata[band * 4 + 3];

    // The ridge band's own gradient is zero (symmetric neighbours), so its
    // integrated phase must stay constant over time.
    for (let frame = 40; frame < 200; frame += 10) {
      expect(Math.abs(wrapToPi(phaseAt(RIDGE_BAND, frame) - phaseAt(RIDGE_BAND, 40)))).toBeLessThan(0.05);
    }

    // Each skirt band must advance relative to the ridge at exactly the
    // Gaussian-atom carrier rate 2π·(f_ridge − f_band)/sampleRate per frame.
    for (const skirtBand of [RIDGE_BAND - 1, RIDGE_BAND + 1]) {
      const expectedStep = (2 * Math.PI * (freqOf(RIDGE_BAND) - freqOf(skirtBand))) / SAMPLE_RATE;
      let stepSum = 0;
      let stepCount = 0;
      for (let frame = 40; frame < 200; frame++) {
        const d0 = phaseAt(skirtBand, frame) - phaseAt(RIDGE_BAND, frame);
        const d1 = phaseAt(skirtBand, frame + 1) - phaseAt(RIDGE_BAND, frame + 1);
        stepSum += wrapToPi(d1 - d0);
        stepCount++;
      }
      const meanStep = stepSum / stepCount;
      expect(Math.abs(meanStep - expectedStep)).toBeLessThan(Math.abs(expectedStep) * 0.1 + 1e-4);
    }

    // Floor bands have no confident ridge-atom model, so the blend must keep
    // the canvas phase untouched — re-phasing them is what re-tunes broadband
    // content against the ridges (comb) or folds it into them (vocoder).
    // Solo only: the chained passthrough effect is not phase-identity, so the
    // canvas coherence receives there no longer equals the painted junk.
    if (!chainAfterPassthrough) {
      for (const floorBand of [RIDGE_BAND + 3, RIDGE_BAND + 4, RIDGE_BAND - 3, RIDGE_BAND - 4]) {
        for (let frame = 60; frame < 200; frame += 20) {
          expect(Math.abs(wrapToPi(phaseAt(floorBand, frame) - junkPhaseAt(floorBand, frame)))).toBeLessThan(1e-3);
        }
      }
    }

    renderer.dispose();
  }

  it("locks skirt bands to the ridge's phase advance", async () => {
    await runStrokeAndAssertLock(false);
  });

  // When another effect precedes coherence in the chain, coherence's input is
  // a ping-pong temp FBO. Binding it as coherenceCanvasTex on scan passes that
  // render into the same FBO forms a WebGL feedback loop and drops the draws —
  // this run fails loudly if that regresses.
  it("keeps working when chained after another effect", async () => {
    await runStrokeAndAssertLock(true);
  });

  it("aligns painted onsets to the impulse phase convention", async () => {
    // A broadband magnitude step at EDGE_FRAME with junk phases: with full
    // Attack, every band's phase just after the edge must equal the impulse
    // convention −2π·f·T_edge, so the painted edge resynthesises as one
    // aligned onset.
    const EDGE_FRAME = 100;
    for (let band = 0; band < NUM_BANDS; band++) {
      for (let frame = 0; frame < NUM_FRAMES; frame++) {
        const base = (band * NUM_FRAMES + frame) * 4;
        const mag = frame < EDGE_FRAME ? 0.05 : 1.0;
        spectrogramData.packedData[base] = mag;
        spectrogramData.packedData[base + 1] = junkPhaseAt(band, frame);
        spectrogramData.packedData[base + 2] = mag;
        spectrogramData.packedData[base + 3] = junkPhaseAt(band, frame);
      }
    }
    const onsetTextures = createTextures(spectrogramData);
    const strokeTextures: StrokeTextures = {
      packedDataTex: onsetTextures.packedDataTex,
      originalPackedDataTex: onsetTextures.originalPackedDataTex,
      inverseMapTex: onsetTextures.inverseMapTex,
      metadataTex: onsetTextures.metadataTex,
      placeholderTexture,
      modulatorScaleLut,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const renderer = new StrokeRenderer(gl, spectrogramData, strokeTextures, "coherence-attack-test", effects);
    renderer.initialize();

    const rendererTextures = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "coherence-attack-test",
      filePath: "/test/coherence-lock-test.wav",
      displayName: "coherence-attack-test.wav",
      spectrogramData,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };

    const state = createStateWithCoherence();
    const coherenceParams = { coherenceAttack: 100, coherenceStrictness: 100 };
    Object.assign(state, coherenceParams);
    const steps = state.brushes[state.activeBrushIndex]?.steps;
    if (steps && steps[0]) Object.assign(steps[0] as Record<string, unknown>, coherenceParams);

    renderer.renderStroke(
      {
        cursorPos: new Vector2(0.5, 0.5),
        preview: false,
        bpm: 120,
        totalDuration: NUM_FRAMES / SAMPLE_RATE,
        viewZoomPower: 0,
        viewOffset: 0,
        viewZoomPowerY: 0,
        viewOffsetY: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
      },
      state,
      sourceFile,
    );
    const after = await renderer.getFBOData();

    const wrapToPi = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    const tEdge = EDGE_FRAME / SAMPLE_RATE;
    for (const band of [10, 24, 40]) {
      const freq = spectrogramData.metadata[band * 4 + 3];
      const expected = -2 * Math.PI * freq * tEdge;
      for (const frame of [EDGE_FRAME + 1, EDGE_FRAME + 3, EDGE_FRAME + 5]) {
        const phase = after[(band * NUM_FRAMES + frame) * 4 + 1];
        expect(Math.abs(wrapToPi(phase - expected))).toBeLessThan(0.02);
      }
    }

    renderer.dispose();
    onsetTextures.packedDataTex.dispose();
    onsetTextures.originalPackedDataTex.dispose();
    onsetTextures.inverseMapTex.dispose();
    onsetTextures.metadataTex.dispose();
  });
});
