import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { NEUTRAL_ALGORITHM } from "../constants";
import { bakeOnsetTexture } from "../onset-map";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer } from "../stroke-renderer";

const TWO_PI = Math.PI * 2;

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { dynamicsEffect }, { blurEffect }, { synthesizeEffect }, { passThroughEffect }] =
    await Promise.all([
      import("../../effects/transform-effect"),
      import("../../effects/dynamics-effect"),
      import("../../effects/blur-effect"),
      import("../../effects/synthesize-effect"),
      import("../../effects/passthrough-effect"),
    ]);
  return {
    transform: transformEffect,
    dynamics: dynamicsEffect,
    blur: blurEffect,
    synthesize: synthesizeEffect,
    passthrough: passThroughEffect,
  };
}

describe("onset transport in the neutral transform", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let ridgeFrameFound = 0;

  const numFrames = 64;
  const numBands = 32;
  const sampleRate = 64; // 1-second file so beats map directly at bpm 60
  const bpm = 60;
  const destPath = "/test/onset-dest.wav";
  const srcPath = "/test/onset-src.wav";
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

  // Per-band deviation from the impulse relation, spread over the whole circle
  // so cross-band alignment can only come from handling it correctly.
  function deviationFor(band: number): number {
    return 1.2 * Math.sin(2.7 * band);
  }

  // An impulse at t0 whose bands each carry a fixed extra deviation — an
  // asymmetric transient. A reversal must conjugate the deviation; an aligned
  // impulse cannot tell, because its deviation is zero.
  function dispersedSpec(): SpectrogramData {
    const spec = impulseSpec();
    for (let band = 0; band < numBands; band++) {
      const idx = (band * numFrames + ridgeFrame) * 4;
      spec.packedData[idx + 1] += deviationFor(band);
      spec.packedData[idx + 3] += deviationFor(band);
    }
    return spec;
  }

  // A sustained partial in every band: magnitude everywhere, phase advancing at
  // the band's own rate, so its second difference is zero and it reads as tonal.
  function tonalSpec(): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      const freq = spec.metadata[band * 4 + 3];
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        const phase = TWO_PI * freq * (frame / sampleRate);
        spec.packedData[idx] = 1;
        spec.packedData[idx + 1] = phase;
        spec.packedData[idx + 2] = 1;
        spec.packedData[idx + 3] = phase;
      }
    }
    return spec;
  }

  // The same but with phase scattered frame to frame — band-limited noise.
  function noiseSpec(): SpectrogramData {
    const spec = tonalSpec();
    let state = 1;
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const idx = (band * numFrames + frame) * 4;
        const phase = (state / 0xffffffff) * TWO_PI * 8;
        spec.packedData[idx + 1] = phase;
        spec.packedData[idx + 3] = phase;
      }
    }
    return spec;
  }

  function shiftState(algorithm: number, shift: { beats?: number; semis?: number } = {}, scaleTime = 1): State {
    const overrides = {
      algorithm,
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      transformScaleTime: scaleTime,
      transformScalePitch: 1,
      transformShiftBeats: shift.beats ?? 0,
      transformShiftSemis: shift.semis ?? -12,
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
  async function runShift(
    algorithm: number,
    onsets: { timeSec: number; strength: number }[] = [{ timeSec: t0, strength: 1 }],
    shift: { beats?: number; semis?: number } = {},
    readFrame: number | "ridge" = ridgeFrame,
    makeSpec: () => SpectrogramData = impulseSpec,
    scaleTime = 1,
  ): Promise<{ band: number; phase: number; freq: number; mag: number }[]> {
    const srcSpec = makeSpec();
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
      displayName: "onset-src.wav",
      spectrogramData: srcSpec,
      textures: {
        packed: srcTex.packed,
        inverse: srcTex.inverse,
        metadata: srcTex.metadata,
        original: srcTex.original,
      },
      onsetTexture: bakeOnsetTexture(onsets, numFrames / sampleRate),
    };

    destRenderer.renderStroke(strokeParams(), shiftState(algorithm, shift, scaleTime), sourceFile);
    const data = await destRenderer.getFBOData();

    // "ridge" locates the frame the content actually landed on, so a fractional
    // shift can be read where it ends up rather than where it was aimed.
    let frame = readFrame === "ridge" ? 0 : readFrame;
    if (readFrame === "ridge") {
      let best = -1;
      for (let f = 0; f < numFrames; f++) {
        let total = 0;
        for (let band = 0; band < numBands; band++) total += data[(band * numFrames + f) * 4];
        if (total > best) {
          best = total;
          frame = f;
        }
      }
      ridgeFrameFound = frame;
    }

    // Relative to the ridge's own peak: a fractional time shift lands the
    // impulse between two frames, and the magnitude interpolation is
    // geometric, so against exact silence the ridge survives at a small
    // fraction of its original level even though its phase is intact.
    let peak = 0;
    for (let band = 0; band < numBands; band++) peak = Math.max(peak, data[(band * numFrames + frame) * 4]);

    const lit: { band: number; phase: number; freq: number; mag: number }[] = [];
    for (let band = 0; band < numBands; band++) {
      const idx = (band * numFrames + frame) * 4;
      const mag = data[idx];
      if (mag > peak * 0.2) {
        lit.push({ band, phase: data[idx + 1], freq: destSpec.metadata[band * 4 + 3], mag });
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

  it("the plain rule scrambles a shifted transient by scaling the unwrap offsets", async () => {
    const lit = await runShift(4);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, t0)).toBeLessThan(0.5);
  });

  it("re-aligns shifted bands to the impulse relation despite unwrap offsets", async () => {
    const lit = await runShift(NEUTRAL_ALGORITHM);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(impulseAlignment(lit, t0)).toBeGreaterThan(0.85);
  });

  it("keeps the ridge aligned through a non-integer time shift", async () => {
    // 0.1 beat at bpm 60 over a 1 s file is 6.4 frames — the shifted ridge
    // lands between frames, so the transported anchor has to follow the
    // transform's own time mapping rather than a whole number of frames.
    const shiftBeats = 0.1;
    const lit = await runShift(
      NEUTRAL_ALGORITHM,
      [{ timeSec: t0, strength: 1 }],
      { beats: shiftBeats, semis: 0 },
      "ridge",
    );

    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(ridgeFrameFound - ridgeFrame)).toBe(Math.round(shiftBeats * sampleRate));
    expect(impulseAlignment(lit, ridgeFrameFound / sampleRate)).toBeGreaterThan(0.85);
  });

  it("reverse transports the conjugated onset deviation", async () => {
    // An exact reversal is C_rev(t) = conj(C(T−t))·e^(−i·2π·f·T), so the
    // deviation carried to the mirrored onset must come out negated. A rule
    // that transports the forward deviation instead restates the attack.
    const lit = await runShift(
      NEUTRAL_ALGORITHM,
      [{ timeSec: t0, strength: 1 }],
      { semis: 0 },
      "ridge",
      dispersedSpec,
      -1,
    );

    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(ridgeFrameFound - (numFrames - 1 - ridgeFrame))).toBeLessThanOrEqual(1);

    const t1 = ridgeFrameFound / sampleRate;
    let re = 0;
    let im = 0;
    for (const { band, phase, freq } of lit) {
      const err = phase - (-TWO_PI * freq * t1 - deviationFor(band));
      re += Math.cos(err);
      im += Math.sin(err);
    }
    const alignment = Math.hypot(re, im) / lit.length;
    expect(alignment).toBeGreaterThan(0.85);
  });

  it("leaves tonal content with no onset exactly as the plain rule does", async () => {
    // Also the check that the blend keeps phase unwrapped away from onsets:
    // wrapping into [-π, π] would change these values even though it makes no
    // audible difference, and onset detection reads phase differences.
    const plain = await runShift(4, [], {}, ridgeFrame, tonalSpec);
    const neutral = await runShift(NEUTRAL_ALGORITHM, [], {}, ridgeFrame, tonalSpec);

    expect(neutral.length).toBeGreaterThanOrEqual(4);
    expect(neutral.length).toBe(plain.length);
    neutral.forEach((sample, i) => {
      expect(sample.phase).toBe(plain[i].phase);
      expect(sample.mag).toBe(plain[i].mag);
    });
  });

  it("replaces noise phase with no onset instead of scaling it", async () => {
    const plain = await runShift(4, [], {}, ridgeFrame, noiseSpec);
    const neutral = await runShift(NEUTRAL_ALGORITHM, [], {}, ridgeFrame, noiseSpec);

    expect(neutral.length).toBeGreaterThanOrEqual(4);
    expect(neutral.length).toBe(plain.length);
    const moved = neutral.filter((sample, i) => Math.abs(sample.phase - plain[i].phase) > 0.1);
    expect(moved.length).toBeGreaterThan(neutral.length * 0.7);
    // Only the phase changes — the noise keeps its shape.
    neutral.forEach((sample, i) => expect(sample.mag).toBeCloseTo(plain[i].mag, 5));
  });

  it("leaves noise alone when the move preserves its phase", async () => {
    // A whole-frame time shift with no pitch change multiplies stored phase by
    // 1, so there is no scrambled unwrap history to replace and the source's
    // own noise has to come through untouched.
    const shift = { beats: 4 / sampleRate, semis: 0 };
    const plain = await runShift(4, [], shift, ridgeFrame, noiseSpec);
    const neutral = await runShift(NEUTRAL_ALGORITHM, [], shift, ridgeFrame, noiseSpec);

    expect(neutral.length).toBeGreaterThanOrEqual(4);
    expect(neutral.length).toBe(plain.length);
    neutral.forEach((sample, i) => {
      expect(sample.phase).toBe(plain[i].phase);
      expect(sample.mag).toBe(plain[i].mag);
    });
  });
});
