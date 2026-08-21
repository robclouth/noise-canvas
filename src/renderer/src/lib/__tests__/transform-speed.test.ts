import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Speed is a varispeed: it divides the time scale and raises the pitch by the
// same ratio, so it must land exactly where those two controls land by hand.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { transform: transformEffect, passthrough: passThroughEffect };
}

describe("transform speed", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 64;
  const numBands = 32;
  const sampleRate = 64; // a 1 s file
  const bpm = 60;
  const filePath = "/test/transform-speed.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  /** One loud band holding one loud frame, so both axes are readable in the result. */
  function markedSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        const mag = band === numBands / 2 ? 1 : 0.1;
        spec.packedData[idx] = frame === numFrames / 4 ? mag : mag * 0.25;
        spec.packedData[idx + 2] = spec.packedData[idx];
      }
    }
    return spec;
  }

  function transformState(params: Record<string, number>): State {
    const overrides = {
      effects: [{ id: "test-transform", effect: "transform" as const, enabled: true, params: {} }],
      transformShiftBeats: 0,
      transformShiftSemis: 0,
      transformScaleTime: 1,
      transformScalePitch: 1,
      transformSpeed: 1,
      transformRotation: 0,
      transformEdgeMode: 1,
      transformOriginTime: 0,
      transformOriginPitch: 0,
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      filepathsBpm: { [filePath]: bpm },
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizeTime: 1,
      brushSizePitch: 128,
      snapPitch: false,
      accumulate: true,
      blendMode: 0,
      algorithm: 0,
      ...params,
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  function strokeParams(): StrokeParams {
    return {
      cursorPos: new Vector2(0, 0),
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
  }

  async function render(params: Record<string, number>): Promise<Float32Array> {
    const spec = markedSpec();
    const textures = createHarnessTextures(spec);
    const renderer = new StrokeRenderer(gl, spec, toStrokeTextures(textures), "self", effects);
    renderer.initialize();
    const tex = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "self",
      filePath,
      displayName: "transform-speed.wav",
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };
    renderer.renderStroke(strokeParams(), transformState(params), sourceFile);
    const data = await renderer.getFBOData();
    renderer.dispose();
    disposeHarnessTextures(textures);
    return data;
  }

  function difference(a: Float32Array, b: Float32Array): number {
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    return worst;
  }

  it.each([
    [2, 0.5, 12],
    [0.5, 2, -12],
  ])("at %sx matches a scale of %s with a shift of %s semitones", async (speed, scaleTime, shiftSemis) => {
    const bySpeed = await render({ transformSpeed: speed });
    const byHand = await render({ transformScaleTime: scaleTime, transformShiftSemis: shiftSemis });
    expect(difference(bySpeed, byHand)).toBeLessThan(1e-5);
  });

  it("leaves the sound alone at 1x", async () => {
    const played = await render({ transformSpeed: 1 });
    const untouched = await render({});
    expect(difference(played, untouched)).toBe(0);
  });
});
