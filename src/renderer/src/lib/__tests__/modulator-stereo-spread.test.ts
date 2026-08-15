import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Stereo spread offsets each channel by a fraction of the modulator's own cycle,
// so it decorrelates at every rate. An offset measured in file UV instead
// collapses to mono whenever it spans a whole number of cycles, and does nothing
// at all to a pattern that varies only along pitch.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect };
}

interface StereoCase {
  stereoSpread: number;
  rateBeats: number;
  rateSemis: number;
}

describe("modulator stereo spread", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const sampleRate = 64; // a 1 s file
  const bpm = 240; // four beats across it
  const filePath = "/test/stereo-spread.wav";

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

  function stereoState({ stereoSpread, rateBeats, rateSemis }: StereoCase): State {
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
      modulator1PatternShape: 0, // Sine
      modulator1PatternRateBeats: rateBeats,
      modulator1PatternRateSemis: rateSemis,
      modulator1Strength: 100,
      modulator1StereoSpread: stereoSpread,
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

  /** Largest gap between the left and right magnitudes the stroke painted. */
  async function channelDivergence(strokeCase: StereoCase): Promise<number> {
    const textures = createHarnessTextures(spectrogramData);
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "stereo", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "stereo",
      filePath,
      displayName: "stereo-spread.wav",
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

    renderer.renderStroke(params, stereoState(strokeCase), sourceFile);
    const data = await renderer.getFBOData();
    renderer.dispose();
    disposeHarnessTextures(textures);

    let maxDiff = 0;
    for (let i = 0; i < data.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(data[i] - data[i + 2]));
    return maxDiff;
  }

  it("keeps both channels equal at zero spread", async () => {
    expect(await channelDivergence({ stereoSpread: 0, rateBeats: 0.5, rateSemis: 0 })).toBeLessThan(1e-5);
  });

  it("decorrelates when the spread spans whole cycles of the pattern", async () => {
    // 0.5 beats at 240 bpm is an eighth of the 1 s file, so a spread measured in
    // file UV lands both channels on the same phase at 25%, 50% and 100%.
    for (const stereoSpread of [25, 50, 100]) {
      expect(await channelDivergence({ stereoSpread, rateBeats: 0.5, rateSemis: 0 })).toBeGreaterThan(0.001);
    }
  });

  it("decorrelates a pattern that varies only along pitch", async () => {
    expect(await channelDivergence({ stereoSpread: 50, rateBeats: 0, rateSemis: 12 })).toBeGreaterThan(0.001);
  });
});
