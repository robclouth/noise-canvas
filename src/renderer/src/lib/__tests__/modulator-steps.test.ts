import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Steps snaps a modulator's output to evenly spaced levels. A pattern with both
// rates at Off holds one output for the whole canvas, so painting those
// constants gives the levels a stepped pattern is allowed to land on, measured
// through the same brush and effect chain as the stepped stroke itself.

const SINE = 0; // holds 0.5 with both rates Off
const SAWTOOTH = 3; // holds 0.0 with both rates Off
const PULSE = 4; // holds 1.0 with both rates Off

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect };
}

interface StepsCase {
  shape: number;
  rateBeats: number;
  steps: number;
}

describe("modulator steps", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const sampleRate = 64; // a 1 s file
  const bpm = 240; // four beats across it
  const filePath = "/test/modulator-steps.wav";

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

  function stepsState({ shape, rateBeats, steps }: StepsCase): State {
    const overrides = {
      effects: [
        {
          id: "test-dynamics",
          effect: "dynamics" as const,
          enabled: true,
          params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
        },
      ],
      modulator1Mode: 0, // Pattern
      modulator1PatternShape: shape,
      modulator1PatternRateBeats: rateBeats,
      modulator1PatternRateSemis: 0,
      modulator1Strength: 100,
      modulator1Steps: steps,
      modulator1StereoSpread: 0,
      modulator1PhaseMode: 0,
      modulator1PhaseX: 0,
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

  /** The magnitudes one stroke leaves behind. */
  async function paint(strokeCase: StepsCase): Promise<Float32Array> {
    const textures = createHarnessTextures(spectrogramData);
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "steps", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "steps",
      filePath,
      displayName: "modulator-steps.wav",
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

    renderer.renderStroke(params, stepsState(strokeCase), sourceFile);
    const data = (await renderer.getFBOData()).slice();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return data;
  }

  /**
   * How each pixel of `painted` sits against the constant levels: the index of
   * the level it matches, or -1 where it matches none. Pixels the brush barely
   * reaches, where the levels themselves are within `0.05` of each other, are
   * left out — there is nothing to tell apart there.
   */
  function classify(painted: Float32Array, levels: Float32Array[]): number[] {
    const found: number[] = [];
    for (let i = 0; i < painted.length; i += 4) {
      const at = levels.map((level) => level[i]);
      if (Math.max(...at) - Math.min(...at) < 0.05) continue;
      found.push(at.findIndex((value) => Math.abs(value - painted[i]) < 1e-4));
    }
    return found;
  }

  it("lands only on the levels it is given, and reaches every one", async () => {
    const levels = [
      await paint({ shape: SAWTOOTH, rateBeats: 0, steps: 0 }),
      await paint({ shape: SINE, rateBeats: 0, steps: 0 }),
      await paint({ shape: PULSE, rateBeats: 0, steps: 0 }),
    ];

    const found = classify(await paint({ shape: SAWTOOTH, rateBeats: 0.5, steps: 3 }), levels);
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((level) => level === -1)).toEqual([]);
    for (const level of [0, 1, 2]) expect(found.filter((at) => at === level).length).toBeGreaterThan(0);
  });

  it("skips the middle level at two steps", async () => {
    const levels = [
      await paint({ shape: SAWTOOTH, rateBeats: 0, steps: 0 }),
      await paint({ shape: SINE, rateBeats: 0, steps: 0 }),
      await paint({ shape: PULSE, rateBeats: 0, steps: 0 }),
    ];

    const found = classify(await paint({ shape: SAWTOOTH, rateBeats: 0.5, steps: 2 }), levels);
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((level) => level === -1)).toEqual([]);
    expect(found.filter((level) => level === 1)).toEqual([]);
  });

  it("sweeps between the levels while Steps is off", async () => {
    const levels = [
      await paint({ shape: SAWTOOTH, rateBeats: 0, steps: 0 }),
      await paint({ shape: SINE, rateBeats: 0, steps: 0 }),
      await paint({ shape: PULSE, rateBeats: 0, steps: 0 }),
    ];

    const found = classify(await paint({ shape: SAWTOOTH, rateBeats: 0.5, steps: 0 }), levels);
    expect(found.filter((level) => level === -1).length).toBeGreaterThan(found.length / 2);
  });
});
