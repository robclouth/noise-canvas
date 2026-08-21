import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStepStateView } from "../../store";
import { ParameterKey, SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { normalizeParameterValue } from "../../store/utils";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { buildModulatorUniforms } from "../modulator-utils";
import {
  createModContext,
  NEUTRAL_STROKE_CONTEXT,
  nestedStaticModulation,
  resolveMacroValues,
  staticModulation,
} from "../static-modulation";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Macro and stroke-context sources are constant across a dab, so the CPU folds
// them before upload. The fold has to match the shader's weighted average for
// effect parameters and its chain of sequential mixes for modulator parameters.

function stepStateWith(overrides: Record<string, unknown>): State {
  const state = createMockState(overrides as Partial<State>);
  Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
  return createStepStateView(state, 0);
}

describe("static modulation fold", () => {
  const GAIN_MIN = -80;
  const GAIN_MAX = 24;

  it("sweeps a parameter across its range from one macro at full amount", () => {
    const step = stepStateWith({ dynamicsGainDbModMacro1Amount: 100 });
    const ctx = { ...NEUTRAL_STROKE_CONTEXT, macros: [0.25, 0.5, 0.5, 0.5] };
    const { staticSum, staticWeight } = staticModulation(step, "dynamicsGainDb", GAIN_MIN, GAIN_MAX, ctx);
    expect(staticWeight).toBe(1);
    expect(staticSum).toBeCloseTo(GAIN_MIN + (GAIN_MAX - GAIN_MIN) * 0.25, 9);
  });

  it("adds a second full-amount source as a peer, so the pair averages", () => {
    const step = stepStateWith({ dynamicsGainDbModMacro1Amount: 100, dynamicsGainDbModPressure: 100 });
    const ctx = { ...NEUTRAL_STROKE_CONTEXT, pressure: 1, macros: [0, 0.5, 0.5, 0.5] };
    const { staticSum, staticWeight } = staticModulation(step, "dynamicsGainDb", GAIN_MIN, GAIN_MAX, ctx);
    expect(staticWeight).toBe(2);
    expect(staticSum / staticWeight).toBeCloseTo((GAIN_MIN + GAIN_MAX) / 2, 9);
  });

  it("mirrors the sweep for a negative amount", () => {
    const step = stepStateWith({ dynamicsGainDbModMacro1Amount: -100 });
    const atTop = staticModulation(step, "dynamicsGainDb", GAIN_MIN, GAIN_MAX, {
      ...NEUTRAL_STROKE_CONTEXT,
      macros: [1, 0.5, 0.5, 0.5],
    });
    const atBottom = staticModulation(step, "dynamicsGainDb", GAIN_MIN, GAIN_MAX, {
      ...NEUTRAL_STROKE_CONTEXT,
      macros: [0, 0.5, 0.5, 0.5],
    });
    expect(atTop.staticWeight).toBe(1);
    expect(atTop.staticSum).toBeCloseTo(GAIN_MIN, 9);
    expect(atBottom.staticSum).toBeCloseTo(GAIN_MAX, 9);
  });

  it("is the identity with nothing routed", () => {
    const step = stepStateWith({});
    const ctx = createModContext(step, NEUTRAL_STROKE_CONTEXT);
    expect(staticModulation(step, "dynamicsGainDb", GAIN_MIN, GAIN_MAX, ctx)).toEqual({
      staticSum: 0,
      staticWeight: 0,
    });
    expect(nestedStaticModulation(step, "modulator1Strength", 0, 1, ctx)).toEqual({
      staticScale: 1,
      staticOffset: 0,
    });
  });

  it("reduces a modulator parameter's sequential mixes to one affine map", () => {
    const step = stepStateWith({
      modulator1StrengthModMacro1Amount: 50,
      modulator1StrengthModMacro2Amount: 100,
    });
    const ctx = { ...NEUTRAL_STROKE_CONTEXT, macros: [0.8, 0.3, 0.5, 0.5] };
    const { staticScale, staticOffset } = nestedStaticModulation(step, "modulator1Strength", 0, 1, ctx);
    // mix(mix(x, 0.8, 0.5), 0.3, 1.0) == 0.3 for every x.
    expect(staticScale).toBeCloseTo(0, 9);
    expect(staticOffset).toBeCloseTo(0.3, 9);

    const half = stepStateWith({ modulator1StrengthModMacro1Amount: 50 });
    const one = nestedStaticModulation(half, "modulator1Strength", 0, 1, ctx);
    // mix(x, 0.8, 0.5) == 0.5 x + 0.4.
    expect(one.staticScale).toBeCloseTo(0.5, 9);
    expect(one.staticOffset).toBeCloseTo(0.4, 9);
  });

  it("sweeps a modulator's Depth across its own slider", () => {
    const step = stepStateWith({ modulator1StrengthModMacro1Amount: 100 });
    const macros = [normalizeParameterValue("modulator1Strength", 25), 0.5, 0.5, 0.5];
    const [modulator] = buildModulatorUniforms(120, 10, 36, 96, step, { ...NEUTRAL_STROKE_CONTEXT, macros });
    expect(modulator.modulatorStrength.staticScale).toBeCloseTo(0, 9);
    expect(modulator.modulatorStrength.staticOffset).toBeCloseTo(0.25, 9);
  });

  it("moves a macro knob from pen pressure", () => {
    const step = stepStateWith({ macro1ValueModPressure: 100 });
    expect(resolveMacroValues(step, { ...NEUTRAL_STROKE_CONTEXT, pressure: 0 })[0]).toBeCloseTo(0, 9);
    expect(resolveMacroValues(step, { ...NEUTRAL_STROKE_CONTEXT, pressure: 1 })[0]).toBeCloseTo(1, 9);
    expect(resolveMacroValues(step, { ...NEUTRAL_STROKE_CONTEXT, pressure: 0.5 })[0]).toBeCloseTo(0.5, 9);
    expect(resolveMacroValues(step, NEUTRAL_STROKE_CONTEXT)[1]).toBeCloseTo(0.5, 9);
  });

  it("blends a macro knob towards its pressure sweep below full amount", () => {
    const step = stepStateWith({ macro1ValueModPressure: 50 });
    // mix(50, 100, 0.5) / 100
    expect(resolveMacroValues(step, { ...NEUTRAL_STROKE_CONTEXT, pressure: 1 })[0]).toBeCloseTo(0.75, 9);
  });
});

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }, { transformEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
    import("../../effects/transform-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect, transform: transformEffect };
}

describe("static modulation on the GPU", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const sampleRate = 64;
  const bpm = 240;
  const filePath = "/test/static-mod.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    spectrogramData = createMockSpectrogramData({
      numFrames,
      numBands,
      sampleRate,
      pattern: "constant",
      constantMagnitude: 0.5,
    });
  });

  function effectState(
    effect: "dynamics" | "transform",
    effectParams: Record<string, number>,
    stepOverrides: Record<string, unknown>,
  ): State {
    const overrides = {
      effects: [{ id: `test-${effect}`, effect, enabled: true, params: effectParams }],
      brushIntensity: 100,
      brushSizeTime: 32,
      brushSizePitch: 128,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      accumulate: true,
      blendMode: 0,
      filepathsBpm: { [filePath]: bpm },
      ...stepOverrides,
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  afterEach(() => {
    gl.dispose();
  });

  const gainState = (effectParams: Record<string, number>, stepOverrides: Record<string, unknown>): State =>
    effectState("dynamics", effectParams, stepOverrides);

  async function render(
    state: State,
    pressure: number,
    data: SpectrogramData = spectrogramData,
  ): Promise<Float32Array> {
    const textures = createHarnessTextures(data);
    const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "static-mod", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "static-mod",
      filePath,
      displayName: "static-mod.wav",
      spectrogramData: data,
      textures: { packed: t.packed, inverse: t.inverse, metadata: t.metadata, original: t.original },
    };
    const params: StrokeParams = {
      cursorPos: new Vector2(0.5, 0.5),
      preview: false,
      bpm,
      totalDuration: numFrames / sampleRate,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure,
      tiltX: 0,
      tiltY: 0,
    };

    renderer.renderStroke(params, state, sourceFile);
    const pixels = await renderer.getFBOData();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return pixels;
  }

  function meanMagnitude(data: Float32Array): number {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] + data[i + 2];
      count += 2;
    }
    return sum / count;
  }

  function columnMeans(data: Float32Array): number[] {
    const out = new Array<number>(numFrames).fill(0);
    for (let f = 0; f < numFrames; f++) {
      let sum = 0;
      for (let b = 0; b < numBands; b++) sum += data[(b * numFrames + f) * 4];
      out[f] = sum / numBands;
    }
    return out;
  }

  function maxMagDifference(a: Float32Array, b: Float32Array): number {
    let maxDiff = 0;
    for (let i = 0; i < a.length; i += 4) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]), Math.abs(a[i + 2] - b[i + 2]));
    }
    return maxDiff;
  }

  it("drives Gain from pen pressure through a macro", async () => {
    const state = gainState(
      { dynamicsGainDb: 0, dynamicsGainDbModMacro1Amount: 100 },
      { ["macro1ValueModPressure" as ParameterKey]: 100 },
    );
    state.brushes[0].macroValues = [50, 50, 50, 50];

    const light = await render(state, 0);
    const hard = await render(state, 1);

    // Pressure 0 parks the macro at 0, a −80 dB cut; pressure 1 parks it at 100, a +24 dB boost.
    expect(meanMagnitude(light)).toBeLessThan(0.5 * 10 ** (-80 / 20) * 2);
    expect(meanMagnitude(hard)).toBeGreaterThan(0.5 * 10 ** (24 / 20) * 0.9);
  });

  it("plays a modulator sweep backwards at a negative amount", async () => {
    const sweep = (amount: number): State =>
      gainState(
        { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: amount },
        {
          modulator1Mode: 0,
          modulator1PatternShape: 3,
          modulator1PatternRateBeats: 4,
          modulator1PatternRateSemis: 0,
          modulator1Strength: 100,
          modulator1StereoSpread: 0,
          modulator1PhaseMode: 0,
          modulator1PhaseX: 0,
          modulator1PhaseY: 0,
        },
      );

    const up = columnMeans(await render(sweep(100), 0));
    const down = columnMeans(await render(sweep(-100), 0));
    const lastUp = up[numFrames - 1];
    const firstDown = down[0];
    expect(lastUp).toBeGreaterThan(up[0] * 100);
    expect(firstDown).toBeGreaterThan(down[numFrames - 1] * 100);
    // Neither direction leaves the −80…+24 dB range.
    expect(Math.max(lastUp, firstDown)).toBeLessThan(0.5 * 10 ** (24 / 20) * 1.05);
  });

  it("parks a log slider where the knob would through a macro", async () => {
    const gradient = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "gradient" });
    const fromSlider = effectState("transform", { transformScaleTime: 2, transformEdgeMode: 0 }, {});
    const fromMacro = effectState(
      "transform",
      { transformScaleTime: 1, transformScaleTimeModMacro1Amount: 100, transformEdgeMode: 0 },
      {},
    );
    fromMacro.brushes[0].macroValues = [normalizeParameterValue("transformScaleTime", 2) * 100, 50, 50, 50];

    const viaSlider = await render(fromSlider, 0, gradient);
    const viaMacro = await render(fromMacro, 0, gradient);
    const untouched = await render(
      effectState("transform", { transformScaleTime: 1, transformEdgeMode: 0 }, {}),
      0,
      gradient,
    );

    expect(maxMagDifference(viaSlider, untouched)).toBeGreaterThan(1e-3);
    expect(maxMagDifference(viaSlider, viaMacro)).toBeLessThan(1e-4);
  });

  it("moves a modulator's phase from a macro", async () => {
    const sweep = (macroValue: number): State => {
      const state = gainState(
        { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
        {
          modulator1Mode: 0,
          modulator1PatternShape: 0,
          modulator1PatternRateBeats: 0.5,
          modulator1PatternRateSemis: 0,
          modulator1Strength: 100,
          modulator1StereoSpread: 0,
          modulator1PhaseMode: 0,
          modulator1PhaseX: 0,
          modulator1PhaseY: 0,
          ["modulator1PhaseXModMacro1Amount" as ParameterKey]: 100,
        },
      );
      state.brushes[0].macroValues = [macroValue, 50, 50, 50];
      return state;
    };

    const atZero = await render(sweep(0), 0);
    const atHalf = await render(sweep(50), 0);
    expect(maxMagDifference(atZero, atHalf)).toBeGreaterThan(1e-3);
  });
});
