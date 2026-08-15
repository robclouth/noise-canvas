import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { C0_HZ } from "../scale-snap";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ cloneEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/clone-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { clone: cloneEffect, passthrough: passThroughEffect };
}

describe("repeat scale snapping and decay", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 64;
  const numBands = 32;
  const sampleRate = 64;
  const bpm = 60;
  const filePath = "/test/clone-scale-snap.wav";
  // One band per semitone, with the bottom band exactly on C2, so absolute
  // pitch classes line up with band indices.
  const bandsPerOctave = 12;
  const minFreq = C0_HZ * 4;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  // A steady tone on the lowest-pitch band. Storage band 0 is the highest
  // frequency, so the bottom of the pitch axis is storage band numBands-1.
  function toneSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({
      numFrames,
      numBands,
      sampleRate,
      bandsPerOctave,
      minFreq,
      pattern: "silence",
    });
    const bottomBand = numBands - 1;
    for (let frame = 0; frame < numFrames; frame++) {
      const idx = (bottomBand * numFrames + frame) * 4;
      spec.packedData[idx] = 1;
      spec.packedData[idx + 2] = 1;
    }
    return spec;
  }

  function cloneState(overrides: Record<string, unknown>): State {
    const cloneEffects = [{ id: "test-clone", effect: "clone" as const, enabled: true, params: {} }];
    const base = {
      effects: cloneEffects,
      cloneSpaceBeats: 0,
      cloneCountX: 0,
      cloneDecay: 0,
      cloneDirectionY: 0,
      cloneEdgeMode: 1,
      scaleTonic: "C",
      scaleType: "major",
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      filepathsBpm: { [filePath]: bpm },
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizeTime: 32,
      brushSizePitch: 128,
      accumulate: true,
      blendMode: 0,
      ...overrides,
    };
    const state = createMockState(base);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, base);
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

  // Magnitude at each semitone above the tone, read at a mid-file frame.
  async function runClone(overrides: Record<string, unknown>): Promise<number[]> {
    const spec = toneSpec();
    const textures = createHarnessTextures(spec);
    const renderer = new StrokeRenderer(gl, spec, toStrokeTextures(textures), "self", effects);
    renderer.initialize();

    const tex = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "self",
      filePath,
      displayName: "clone-scale-snap.wav",
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };

    renderer.renderStroke(strokeParams(), cloneState(overrides), sourceFile);
    const data = await renderer.getFBOData();
    disposeHarnessTextures(textures);

    const frame = Math.floor(numFrames / 2);
    const mags: number[] = [];
    for (let semis = 0; semis < numBands; semis++) {
      const band = numBands - 1 - semis;
      mags.push(data[(band * numFrames + frame) * 4]);
    }
    return mags;
  }

  it("lands every copy on a scale note instead of the raw step", async () => {
    // Gap 3 st from C in C major: raw steps 3, 6, 9 snap to E (+4), G (+7), A (+9).
    const mags = await runClone({
      cloneCountY: 3,
      cloneSpaceSemis: 3,
      cloneShapeY: "scale",
    });

    expect(mags[0]).toBeGreaterThan(0.3);
    for (const semis of [4, 7, 9]) {
      expect(mags[semis], `copy at +${semis}`).toBeGreaterThan(0.3);
    }
    for (const semis of [3, 6]) {
      expect(mags[semis], `raw step at +${semis}`).toBeLessThan(0.05);
    }
  });

  it("fades copies by decibels along the decay", async () => {
    // Decay 50% puts the outermost copy 30 dB down; halfway is -15 dB.
    const mags = await runClone({
      cloneCountY: 2,
      cloneSpaceSemis: 12,
      cloneShapeY: "even",
      cloneDecay: 50,
    });

    expect(mags[0]).toBeGreaterThan(0.3);
    expect(mags[12] / mags[0]).toBeCloseTo(Math.pow(10, -15 / 20), 1);
    expect(mags[24] / mags[0]).toBeCloseTo(Math.pow(10, -30 / 20), 1);
  });

  it("mutes every copy past the first at full decay", async () => {
    const mags = await runClone({
      cloneCountY: 2,
      cloneSpaceSemis: 12,
      cloneShapeY: "even",
      cloneDecay: 100,
    });

    expect(mags[0]).toBeGreaterThan(0.3);
    expect(mags[12]).toBeLessThan(0.01);
    expect(mags[24]).toBeLessThan(0.01);
  });
});
