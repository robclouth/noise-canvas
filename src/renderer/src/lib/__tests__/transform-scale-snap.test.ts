import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { C0_HZ } from "../scale-snap";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// The brush covers the whole file, so its low edge sits on the file's lowest
// band. That band is put on C4, so a shift snapped in C major pentatonic
// (C D E G A) lands on known scale notes.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { transform: transformEffect, passthrough: passThroughEffect };
}

describe("transform shift scale snap", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 64;
  const numBands = 48;
  const sampleRate = 64;
  const bpm = 60;
  const filePath = "/test/transform-scale-snap.wav";
  const minFreq = C0_HZ * Math.pow(2, 4);

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  /** A spectrum whose bands all differ, so any pitch move shows in the result. */
  function rampSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, minFreq, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        spec.packedData[idx] = 0.05 + band / numBands;
        spec.packedData[idx + 2] = spec.packedData[idx];
      }
    }
    return spec;
  }

  function transformState(params: Record<string, number | boolean | string>): State {
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
      gridSizeSemis: 1,
      scaleTonic: "C",
      scaleType: "major pentatonic",
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

  async function render(params: Record<string, number | boolean | string>): Promise<Float32Array> {
    const spec = rampSpec();
    const textures = createHarnessTextures(spec);
    const renderer = new StrokeRenderer(gl, spec, toStrokeTextures(textures), "self", effects);
    renderer.initialize();
    const tex = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "self",
      filePath,
      displayName: "transform-scale-snap.wav",
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

  const snapped = { snapPitch: true, gridSizeSemis: 0 };

  it.each([
    [3, 4],
    [2, 2],
    [5, 4],
    [6, 7],
    [1, 2],
    [-1, -3],
  ])("a shift of %s semitones from C lands on %s", async (shift, landed) => {
    const bySnap = await render({ ...snapped, transformShiftSemis: shift });
    const byHand = await render({ transformShiftSemis: landed });
    expect(difference(bySnap, byHand)).toBeLessThan(1e-5);
  });

  it("moves one scale note when the nearest note is the start note", async () => {
    const onThird = { ...snapped, scaleTonic: "G#" };
    const bySnap = await render({ ...onThird, transformShiftSemis: 1 });
    const byHand = await render({ transformShiftSemis: 3 });
    expect(difference(bySnap, byHand)).toBeLessThan(1e-5);
  });

  it("leaves the shift alone when pitch snap is off", async () => {
    const unsnapped = await render({ gridSizeSemis: 0, transformShiftSemis: 3 });
    const byHand = await render({ transformShiftSemis: 3 });
    expect(difference(unsnapped, byHand)).toBe(0);
  });
});
