import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Effect parameters and their modulation amounts live on the effect item, not
// on the step, and still have to drive the modulator precompute pass.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { cloneEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/clone-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, clone: cloneEffect, passthrough: passThroughEffect };
}

describe("effect parameter modulation", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const sampleRate = 64; // a 1 s file
  const bpm = 240; // four beats across it
  const filePath = "/test/effect-param-mod.wav";

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

  afterEach(() => {
    gl.dispose();
  });

  function gainModState(phaseX: number, withRepeat: boolean): State {
    const effectItems = [
      ...(withRepeat
        ? [
            {
              id: "test-clone",
              effect: "clone" as const,
              enabled: true,
              params: { cloneCountX: 0, cloneCountY: 2, cloneSpaceSemis: 4, cloneDecay: 0 },
            },
          ]
        : []),
      {
        id: "test-dynamics",
        effect: "dynamics" as const,
        enabled: true,
        params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
      },
    ];
    const overrides = {
      effects: effectItems,
      modulator1Mode: 0, // Pattern
      modulator1PatternShape: 0, // Sine
      modulator1PatternRateBeats: 0.5,
      modulator1PatternRateSemis: 0,
      modulator1Strength: 100,
      modulator1StereoSpread: 0,
      modulator1PhaseMode: 0,
      modulator1PhaseX: phaseX,
      modulator1PhaseY: 0,
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
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  async function renderGainMod(phaseX: number, withRepeat: boolean): Promise<Float32Array> {
    const textures = createHarnessTextures(spectrogramData);
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "mod-test", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "mod-test",
      filePath,
      displayName: "effect-param-mod.wav",
      spectrogramData,
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
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };

    renderer.renderStroke(params, gainModState(phaseX, withRepeat), sourceFile);
    const data = await renderer.getFBOData();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return data;
  }

  function maxMagDifference(a: Float32Array, b: Float32Array): number {
    let maxDiff = 0;
    for (let i = 0; i < a.length; i += 4) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]), Math.abs(a[i + 2] - b[i + 2]));
    }
    return maxDiff;
  }

  it("sweeps Gain from a modulator when the amount lives on the effect item", async () => {
    const atZero = await renderGainMod(0, false);
    const atHalf = await renderGainMod(50, false);
    expect(maxMagDifference(atZero, atHalf)).toBeGreaterThan(1e-3);
  });

  it("sweeps Gain from a modulator with a repeat effect ahead of it", async () => {
    const atZero = await renderGainMod(0, true);
    const atHalf = await renderGainMod(50, true);
    expect(maxMagDifference(atZero, atHalf)).toBeGreaterThan(1e-3);
  });
});
