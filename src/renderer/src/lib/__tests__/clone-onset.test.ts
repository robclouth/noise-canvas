import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { bakeOnsetTexture } from "../onset-map";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

const TWO_PI = Math.PI * 2;

// The clone effect copies a region to later positions. A copy of an attack only
// stays an attack if its carrier is corrected for how far it moved: without
// that, every band arrives with the phase it had at the original time, and the
// copies' bands no longer line up with each other.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ cloneEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/clone-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { clone: cloneEffect, passthrough: passThroughEffect };
}

describe("clone onset re-anchoring", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 64;
  const numBands = 32;
  const sampleRate = 64; // 1 s file, so a beat at bpm 60 spans it exactly
  const bpm = 60;
  const filePath = "/test/clone-onset.wav";
  const ridgeFrame = 12;
  const t0 = ridgeFrame / sampleRate;
  // A copy 17 frames later: not a whole number of the coarser bands' strides,
  // so the copies cannot land on every band's grid.
  const spaceFrames = 17;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  // An impulse at t0: every band carries a one-frame ridge at phase −2π·f·t0.
  function impulseSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      const freq = spec.metadata[band * 4 + 3];
      const idx = (band * numFrames + ridgeFrame) * 4;
      const phase = -TWO_PI * freq * t0;
      spec.packedData[idx] = 1;
      spec.packedData[idx + 1] = phase;
      spec.packedData[idx + 2] = 1;
      spec.packedData[idx + 3] = phase;
    }
    return spec;
  }

  function cloneState(): State {
    const cloneEffects = [{ id: "test-clone", effect: "clone" as const, enabled: true, params: {} }];
    const overrides = {
      effects: cloneEffects,
      // A beat spans the file at bpm 60, so beats and file fractions coincide.
      cloneSpaceBeats: spaceFrames / numFrames,
      cloneSpaceSemis: 0,
      cloneCountX: 2,
      cloneCountY: 1,
      cloneDecay: 0,
      cloneDirectionX: 0,
      cloneDirectionY: 0,
      cloneEdgeMode: 0,
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
      accumulate: true,
      blendMode: 0,
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  function strokeParams(onsetTexture: ReturnType<typeof bakeOnsetTexture>): StrokeParams {
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
      destOnsetTexture: onsetTexture,
    };
  }

  // |mean unit vector| of the deviation from the impulse relation −2π·f·T:
  // 1 = every band aligned on one instant, ~0 = scrambled.
  function impulseAlignment(lit: { phase: number; freq: number }[], onsetSec: number): number {
    let re = 0;
    let im = 0;
    for (const { phase, freq } of lit) {
      const deviation = phase - -TWO_PI * freq * onsetSec;
      re += Math.cos(deviation);
      im += Math.sin(deviation);
    }
    return Math.hypot(re, im) / Math.max(lit.length, 1);
  }

  async function runClone(withOnset: boolean): Promise<{ phase: number; freq: number; mag: number }[]> {
    const spec = impulseSpec();
    const onsetTexture = bakeOnsetTexture(
      withOnset ? [{ timeSec: t0, weight: 1, strength: 1 }] : [],
      numFrames / sampleRate,
    );
    const textures = createHarnessTextures(spec);
    const renderer = new StrokeRenderer(gl, spec, toStrokeTextures(textures), "self", effects);
    renderer.initialize();

    const tex = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "self",
      filePath,
      displayName: "clone-onset.wav",
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
      onsetTexture,
    };

    renderer.renderStroke(strokeParams(onsetTexture), cloneState(), sourceFile);
    const data = await renderer.getFBOData();

    const copyFrame = ridgeFrame + spaceFrames;
    let peak = 0;
    for (let band = 0; band < numBands; band++) peak = Math.max(peak, data[(band * numFrames + copyFrame) * 4]);

    const lit: { phase: number; freq: number; mag: number }[] = [];
    for (let band = 0; band < numBands; band++) {
      const idx = (band * numFrames + copyFrame) * 4;
      const mag = data[idx];
      if (mag > peak * 0.2) lit.push({ phase: data[idx + 1], freq: spec.metadata[band * 4 + 3], mag });
    }
    disposeHarnessTextures(textures);
    return lit;
  }

  it("lines the copy's bands up on the time it lands on", async () => {
    const lit = await runClone(true);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, (ridgeFrame + spaceFrames) / sampleRate)).toBeGreaterThan(0.85);
  });

  it("leaves the copy aligned on the original time when there is no onset", async () => {
    // Without an onset the phase is carried across untouched, which is what
    // clone has always done: the copy's bands still agree with each other, but
    // about the time the content came from rather than where it now is.
    const lit = await runClone(false);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, t0)).toBeGreaterThan(0.85);
    expect(impulseAlignment(lit, (ridgeFrame + spaceFrames) / sampleRate)).toBeLessThan(0.5);
  });
});
