import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { denormalizeParameterValue } from "../../store/utils";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

// Modulating Gap ↔ has to sweep the knob's own log-bipolar beat arc. Sweeping
// the raw file-UV range instead lands copies seconds away, or on top of the
// original, depending on file length.

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ cloneEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/clone-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { clone: cloneEffect, passthrough: passThroughEffect };
}

describe("repeat gap modulation", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 128;
  const numBands = 16;
  const sampleRate = 128; // a 1 s file
  const bpm = 240; // one beat spans a quarter of it
  const filePath = "/test/clone-gap-mod.wav";
  const ridgeFrame = 8;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  function impulseSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      const idx = (band * numFrames + ridgeFrame) * 4;
      spec.packedData[idx] = 1;
      spec.packedData[idx + 2] = 1;
    }
    return spec;
  }

  function cloneState(macroValue: number): State {
    const overrides = {
      effects: [{ id: "test-clone", effect: "clone" as const, enabled: true, params: {} }],
      cloneSpaceBeats: 0.25,
      cloneSpaceBeatsModMacro1Amount: 100,
      cloneSpaceSemis: 0,
      cloneCountX: 1,
      cloneCountY: 0,
      cloneDecay: 0,
      cloneDirectionX: 0,
      cloneEdgeMode: 1,
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
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    state.brushes[0].macroValues = [macroValue, 50, 50, 50];
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

  /** Frame the copy lands on, taken as the loudest frame after the original. */
  async function copyFrame(macroValue: number): Promise<number> {
    const spec = impulseSpec();
    const textures = createHarnessTextures(spec);
    const renderer = new StrokeRenderer(gl, spec, toStrokeTextures(textures), "self", effects);
    renderer.initialize();

    const tex = renderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "self",
      filePath,
      displayName: "clone-gap-mod.wav",
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };

    renderer.renderStroke(strokeParams(), cloneState(macroValue), sourceFile);
    const data = await renderer.getFBOData();
    disposeHarnessTextures(textures);

    let best = -1;
    let bestMag = 0;
    for (let frame = ridgeFrame + 1; frame < numFrames; frame++) {
      let mag = 0;
      for (let band = 0; band < numBands; band++) mag += data[(band * numFrames + frame) * 4];
      if (mag > bestMag) {
        bestMag = mag;
        best = frame;
      }
    }
    return best;
  }

  /** Where the knob itself would put the copy at this macro position. */
  function knobFrame(macroValue: number): number {
    const beats = denormalizeParameterValue("cloneSpaceBeats", macroValue / 100);
    return ridgeFrame + beats * (60 / bpm) * sampleRate;
  }

  it.each([60, 65, 70])("puts the copy where the knob would at macro %i%%", async (macroValue) => {
    expect(await copyFrame(macroValue)).toBeCloseTo(knobFrame(macroValue), -0.5);
  });

  it("holds the copy on the original at the arc's centre", async () => {
    expect(knobFrame(50)).toBeCloseTo(ridgeFrame, 6);
  });
});
