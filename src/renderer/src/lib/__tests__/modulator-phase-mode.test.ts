import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { BRUSH_SPAN_BEATS_VALUE, BRUSH_SPAN_SEMIS_VALUE } from "../constants";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Brush phase mode moves a pattern's origin onto the brush and nothing else: a
// rate spans the same size in either phase mode. Each case below places the
// brush so its bottom-left corner falls on a cycle boundary of the canvas-mode
// pattern it is measured against, which leaves the two fields identical when
// the spans match — and different as soon as one of them is rescaled.

const SAWTOOTH = 3;

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect };
}

interface PhaseCase {
  phaseMode: number;
  rateBeats: number;
  rateSemis: number;
  brushSizeTime: number;
  brushSizePitch: number;
  cursor: Vector2;
}

describe("modulator phase mode", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let spectrogramData: SpectrogramData;

  const numFrames = 64;
  const numBands = 16;
  const bandsPerOctave = 24; // two bands to a semitone, so 4 semitones span half the file
  const sampleRate = 64; // a 1 s file
  const bpm = 240; // four beats across it
  const filePath = "/test/modulator-phase-mode.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    spectrogramData = createMockSpectrogramData({
      numFrames,
      numBands,
      bandsPerOctave,
      sampleRate,
      pattern: "constant",
      constantMagnitude: 0.5,
    });
  });

  afterEach(() => {
    gl.dispose();
  });

  function phaseState(phaseCase: PhaseCase): State {
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
      modulator1PatternShape: SAWTOOTH,
      modulator1PatternRateBeats: phaseCase.rateBeats,
      modulator1PatternRateSemis: phaseCase.rateSemis,
      modulator1Strength: 100,
      modulator1Steps: 0,
      modulator1StereoSpread: 0,
      modulator1PhaseMode: phaseCase.phaseMode,
      modulator1PhaseX: 0,
      modulator1PhaseY: 0,
      brushIntensity: 100,
      brushSizeTime: phaseCase.brushSizeTime,
      brushSizePitch: phaseCase.brushSizePitch,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushAnchorMode: 0, // corner-anchored, so the cursor is the brush's bottom-left
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
  async function paint(phaseCase: PhaseCase): Promise<Float32Array> {
    const textures = createHarnessTextures(spectrogramData);
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "phase", effects);
    renderer.initialize();

    const t = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "phase",
      filePath,
      displayName: "modulator-phase-mode.wav",
      spectrogramData,
      textures: { packed: t.packed, inverse: t.inverse, metadata: t.metadata, original: t.original },
    };
    const params: StrokeParams = {
      cursorPos: phaseCase.cursor,
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

    renderer.renderStroke(params, phaseState(phaseCase), sourceFile);
    const data = (await renderer.getFBOData()).slice();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return data;
  }

  /** How many magnitudes the two strokes disagree on. */
  function differences(a: Float32Array, b: Float32Array): number {
    let count = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 1e-4) count++;
    }
    return count;
  }

  describe("along time", () => {
    // Two beats of a four-beat file: the brush spans half of it, from 0.5.
    const brush = { brushSizeTime: 2, brushSizePitch: 128, cursor: new Vector2(0.5, 0.5) };

    it("runs one cycle across the brush at the Brush rate", async () => {
      const linked = await paint({ phaseMode: 1, rateBeats: BRUSH_SPAN_BEATS_VALUE, rateSemis: 0, ...brush });
      const typed = await paint({ phaseMode: 0, rateBeats: 2, rateSemis: 0, ...brush });
      expect(differences(linked, typed)).toBe(0);
    });

    it("does not squeeze the cycle into a fraction of the brush", async () => {
      const linked = await paint({ phaseMode: 1, rateBeats: BRUSH_SPAN_BEATS_VALUE, rateSemis: 0, ...brush });
      const half = await paint({ phaseMode: 0, rateBeats: 1, rateSemis: 0, ...brush });
      expect(differences(linked, half)).toBeGreaterThan(100);
    });

    it("keeps a typed rate at its own size", async () => {
      const onBrush = await paint({ phaseMode: 1, rateBeats: 1, rateSemis: 0, ...brush });
      const onCanvas = await paint({ phaseMode: 0, rateBeats: 1, rateSemis: 0, ...brush });
      expect(differences(onBrush, onCanvas)).toBe(0);
    });
  });

  describe("along pitch", () => {
    // Four semitones at 24 bands to the octave: half of the sixteen bands, from 0.5.
    const brush = { brushSizeTime: 32, brushSizePitch: 4, cursor: new Vector2(0.5, 0.5) };

    it("runs one cycle across the brush at the Brush rate", async () => {
      const linked = await paint({ phaseMode: 1, rateBeats: 0, rateSemis: BRUSH_SPAN_SEMIS_VALUE, ...brush });
      const typed = await paint({ phaseMode: 0, rateBeats: 0, rateSemis: 4, ...brush });
      expect(differences(linked, typed)).toBe(0);
    });

    it("does not squeeze the cycle into a fraction of the brush", async () => {
      const linked = await paint({ phaseMode: 1, rateBeats: 0, rateSemis: BRUSH_SPAN_SEMIS_VALUE, ...brush });
      const half = await paint({ phaseMode: 0, rateBeats: 0, rateSemis: 2, ...brush });
      expect(differences(linked, half)).toBeGreaterThan(100);
    });

    it("keeps a typed rate at its own size", async () => {
      const onBrush = await paint({ phaseMode: 1, rateBeats: 0, rateSemis: 2, ...brush });
      const onCanvas = await paint({ phaseMode: 0, rateBeats: 0, rateSemis: 2, ...brush });
      expect(differences(onBrush, onCanvas)).toBe(0);
    });
  });
});
