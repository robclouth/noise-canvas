import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { PUNCHY_ALGORITHM } from "../constants";
import { bakeOnsetTexture } from "../onset-map";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

const TWO_PI = Math.PI * 2;

async function loadEffects(): Promise<EffectsRegistry> {
  const [
    { transformEffect },
    { dynamicsEffect },
    { blurEffect },
    { overtonesEffect },
    { synthesizeEffect },
    { passThroughEffect },
  ] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/blur-effect"),
    import("../../effects/overtones-effect"),
    import("../../effects/synthesize-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return {
    transform: transformEffect,
    dynamics: dynamicsEffect,
    blur: blurEffect,
    overtones: overtonesEffect,
    synthesize: synthesizeEffect,
    passthrough: passThroughEffect,
  };
}

describe("transform punchy algorithm", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;

  const numFrames = 64;
  const numBands = 32;
  const sampleRate = 64; // 1-second file so beats map directly at bpm 60
  const bpm = 60;
  const destPath = "/test/punchy-dest.wav";
  const srcPath = "/test/punchy-src.wav";
  // Frame 33 = 515.625 ms — deliberately not millisecond-aligned, so the
  // detector's sub-bin refinement (not grid luck) must supply the anchor time.
  const ridgeFrame = 33;
  const t0 = ridgeFrame / sampleRate;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  // An impulse at t0 in the Gaborator global convention: every band carries a
  // one-frame ridge with phase −2π·f·t0, plus a per-band whole-cycle offset
  // 2π·(band+1) mimicking real unwrapped-phase storage. The offset is invisible
  // mod 2π, so an additive phase rule must cancel it — while a rule that scales
  // phase by freqRatio 0.5 (a −12 semi shift) turns it into π·(band+1), an
  // alternating 0/π scatter that destroys cross-band alignment.
  function impulseSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      const freq = spec.metadata[band * 4 + 3];
      const idx = (band * numFrames + ridgeFrame) * 4;
      const phase = -TWO_PI * freq * t0 + TWO_PI * (band + 1);
      spec.packedData[idx] = 1;
      spec.packedData[idx + 1] = phase;
      spec.packedData[idx + 2] = 1;
      spec.packedData[idx + 3] = phase;
    }
    return spec;
  }

  function shiftState(algorithm: number): State {
    const overrides = {
      algorithm,
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      transformScaleTime: 1,
      transformScalePitch: 1,
      transformShiftBeats: 0,
      transformShiftSemis: -12,
      transformRotation: 0,
      transformEdgeMode: 0,
      filepathsBpm: { [srcPath]: bpm, [destPath]: bpm },
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizeTime: 1, // 1 beat @ bpm 60 over a 1 s file = full width
      brushSizePitch: 128, // full pitch range
      accumulate: true,
      blendMode: 0,
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

  // Paints the shifted impulse onto a silent dest and returns, for every dest
  // band that received magnitude at the ridge frame, the band's stored phase
  // and metadata frequency.
  async function runShift(algorithm: number): Promise<{ phase: number; freq: number; mag: number }[]> {
    const srcSpec = impulseSpec();
    const destSpec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    const srcTextures = createHarnessTextures(srcSpec);
    const destTextures = createHarnessTextures(destSpec);
    const srcRenderer = new StrokeRenderer(gl, srcSpec, toStrokeTextures(srcTextures), "src", effects);
    srcRenderer.initialize();
    const destRenderer = new StrokeRenderer(gl, destSpec, toStrokeTextures(destTextures), "dest", effects);
    destRenderer.initialize();

    const srcTex = srcRenderer.getTextures();
    const sourceFile: SourceFileInfo = {
      id: "src",
      filePath: srcPath,
      displayName: "punchy-src.wav",
      spectrogramData: srcSpec,
      textures: {
        packed: srcTex.packed,
        inverse: srcTex.inverse,
        metadata: srcTex.metadata,
        original: srcTex.original,
      },
      onsetTexture: bakeOnsetTexture([{ timeSec: t0, strength: 1 }], numFrames / sampleRate),
    };

    destRenderer.renderStroke(strokeParams(), shiftState(algorithm), sourceFile);
    const data = await destRenderer.getFBOData();

    const lit: { phase: number; freq: number; mag: number }[] = [];
    for (let band = 0; band < numBands; band++) {
      const idx = (band * numFrames + ridgeFrame) * 4;
      const mag = data[idx];
      if (mag > 0.2) {
        lit.push({ phase: data[idx + 1], freq: destSpec.metadata[band * 4 + 3], mag });
      }
    }
    disposeHarnessTextures(srcTextures);
    disposeHarnessTextures(destTextures);
    return lit;
  }

  // |mean unit vector| of the deviation from the impulse relation −2π·f·T:
  // 1 = perfectly aligned across bands, ~0 = scrambled.
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

  it("punchy re-aligns shifted bands to the impulse relation despite unwrap offsets", async () => {
    const lit = await runShift(PUNCHY_ALGORITHM);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, t0)).toBeGreaterThan(0.85);
  });

  it("neutral scrambles the same content by scaling the unwrap offsets", async () => {
    const lit = await runShift(4);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, t0)).toBeLessThan(0.5);
  });
});
