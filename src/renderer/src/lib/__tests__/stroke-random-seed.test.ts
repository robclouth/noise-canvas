import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// The Random source reads a noise field at the cursor, so the dabs of one
// gesture differ from each other. Each committed gesture also moves the field
// on, so repeating a gesture that always lands in the same place — Fill Grid
// on a fixed grid — is not a repeat of the same values.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect };
}

describe("stroke random seed", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const sampleRate = 64;
  const bpm = 240;
  const filePath = "/test/stroke-random-seed.wav";

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

  function randomDrivenState(): State {
    const overrides = {
      effects: [
        {
          id: "test-dynamics",
          effect: "dynamics" as const,
          enabled: true,
          params: { dynamicsGainDb: 0, dynamicsGainDbModRandom: 100 },
        },
      ],
      brushIntensity: 100,
      brushSizeTime: 32,
      brushSizePitch: 128,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      sourcePositionMode: "follow",
      // Each gesture reads the file as it was opened, so what is left on the
      // canvas is the last gesture's gain rather than a stack of them.
      sourceDataMode: "original",
      accumulate: true,
      blendMode: 0,
      filepathsBpm: { [filePath]: bpm },
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  /** The magnitudes left after `gestures` strokes, each painted in the same place. */
  async function paintGestures(gestures: number): Promise<Float32Array> {
    const textures = createHarnessTextures(spectrogramData);
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "seed", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "seed",
      filePath,
      displayName: "stroke-random-seed.wav",
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

    const state = randomDrivenState();
    for (let i = 0; i < gestures; i++) {
      renderer.beginStroke();
      renderer.renderStroke(params, state, sourceFile);
      renderer.endStroke();
    }

    const data = (await renderer.getFBOData()).slice();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return data;
  }

  /**
   * Largest gap between two renders, in dB. The modulator drives a gain in dB,
   * so a gap read there tracks the random value itself rather than shrinking
   * with it the way a magnitude does.
   */
  function divergenceDb(a: Float32Array, b: Float32Array): number {
    const db = (magnitude: number) => 20 * Math.log10(Math.max(magnitude, 1e-9));
    let maxDiff = 0;
    for (let i = 0; i < a.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(db(a[i]) - db(b[i])));
    return maxDiff;
  }

  it("repeats the same values while the gesture is the same one", async () => {
    expect(divergenceDb(await paintGestures(1), await paintGestures(1))).toBe(0);
  });

  it("draws different values once a gesture has been committed", async () => {
    const first = await paintGestures(1);
    // The gain spans 104 dB, so a whole dB is about 1% of the source's range.
    for (const gestures of [2, 3, 4, 5]) {
      expect(divergenceDb(first, await paintGestures(gestures))).toBeGreaterThan(1);
    }
  });
});
