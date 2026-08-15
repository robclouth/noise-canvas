import { DataTexture, FloatType, RGBAFormat, Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createConstantQMockSpectrogramData, createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createGL, createSpectrogramTextures } from "../../test/render-harness";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "../utils";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

function createPlaceholderTexture(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { transform: transformEffect, passthrough: passThroughEffect };
}

// Magnitude (L channel) per time frame, averaged over bands. The fixtures below
// are band-independent, so this collapses the canvas to one number per frame.
function magByFrame(data: Float32Array, numFrames: number, numBands: number): number[] {
  const out: number[] = [];
  for (let frame = 0; frame < numFrames; frame++) {
    let sum = 0;
    for (let band = 0; band < numBands; band++) {
      sum += data[(band * numFrames + frame) * 4];
    }
    out.push(sum / numBands);
  }
  return out;
}

// Magnitude (L channel) per band, averaged over time — the pitch-axis mirror of
// magByFrame, for fixtures that are constant along time.
function magByBand(data: Float32Array, numFrames: number, numBands: number): number[] {
  const out: number[] = [];
  for (let band = 0; band < numBands; band++) {
    let sum = 0;
    for (let frame = 0; frame < numFrames; frame++) {
      sum += data[(band * numFrames + frame) * 4];
    }
    out.push(sum / numFrames);
  }
  return out;
}

describe("brush wrap mode", () => {
  let gl: WebGLRenderer;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;
  const disposables: StrokeRenderer[] = [];

  const numFrames = 16;
  const numBands = 8;
  const sampleRate = 16; // 1 second file, so at bpm 60 one beat == the whole file
  const bpm = 60;
  const filePath = "/test/wrap.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = createGL(64, 64);
    placeholderTexture = createPlaceholderTexture();
    modulatorScaleLut = createPlaceholderTexture();
  });

  afterEach(() => {
    for (const r of disposables.splice(0)) r.dispose();
    gl.dispose();
    placeholderTexture.dispose();
    modulatorScaleLut.dispose();
  });

  function fill(mag: (frame: number, band: number) => number): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        spec.packedData[idx] = mag(frame, band);
        spec.packedData[idx + 2] = mag(frame, band);
      }
    }
    return spec;
  }

  // Constant magnitude: any correct read anywhere in the file returns 0.5, so a
  // deviation means the sample was dropped rather than relocated.
  const flat = () => fill(() => 0.5);

  // Magnitude 2^(frame/numFrames). The shader interpolates magnitude in log
  // space, so an exponential ramp reads back as exactly 2^uv at any UV — which
  // makes the read POSITION recoverable from the output magnitude.
  const logRamp = () => fill((frame) => Math.pow(2, frame / numFrames));

  // One distinct magnitude per band, constant along time. The pitch axis is
  // point-sampled by band index, so the output band's value names the source
  // band it read from.
  const bandLadder = () => fill((_frame, band) => (band + 1) / numBands);

  function makeRenderer(spec: SpectrogramData, id: string): StrokeRenderer {
    const raw = createSpectrogramTextures(spec);
    const strokeTextures: StrokeTextures = {
      originalPackedDataTex: raw.originalPackedDataTex,
      inverseMapTex: raw.inverseMapTex,
      metadataTex: raw.metadataTex,
      placeholderTexture,
      modulatorScaleLut,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const renderer = new StrokeRenderer(gl, spec, strokeTextures, id, effects);
    renderer.initialize();
    disposables.push(renderer);
    return renderer;
  }

  function sourceFileFor(renderer: StrokeRenderer, spec: SpectrogramData, id: string): SourceFileInfo {
    const tex = renderer.getTextures();
    return {
      id,
      filePath,
      displayName: filePath,
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };
  }

  function stateFor(overrides: Partial<State> & Record<string, unknown>): State {
    const base = {
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      transformScaleTime: 1,
      transformScalePitch: 1,
      transformShiftBeats: 0,
      transformShiftSemis: 0,
      transformRotation: 0,
      filepathsBpm: { [filePath]: bpm },
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizePitch: 128, // full pitch, so only the time axis is under test
      accumulate: true,
      blendMode: 0,
      algorithm: 4,
      effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
      ...overrides,
    };
    const state = createMockState(base as Partial<State>);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, base);
    return state;
  }

  function params(cursorX: number): StrokeParams {
    return {
      cursorPos: new Vector2(cursorX, 0),
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

  async function paintRaw(spec: SpectrogramData, state: State, cursorX: number, id: string): Promise<Float32Array> {
    const renderer = makeRenderer(spec, id);
    renderer.renderStroke(params(cursorX), state, sourceFileFor(renderer, spec, id));
    return renderer.getFBOData();
  }

  async function paint(spec: SpectrogramData, state: State, cursorX: number, id: string): Promise<number[]> {
    return magByFrame(await paintRaw(spec, state, cursorX, id), numFrames, numBands);
  }

  // Brush at x=0.75 spanning 0.5 UV runs off the right edge; with time wrap its
  // second half lands on frames 0..3. Those frames are inside the brush (the
  // envelope already wraps), so the effect must paint them like any other.
  const WRAPPED_HALF = [0, 1, 2, 3];
  const UNWRAPPED_HALF = [12, 13, 14, 15];

  it("Cut edge mode keeps the wrapped half of the brush", async () => {
    const state = stateFor({ brushSizeTime: 0.5, brushWrapMode: 1, transformEdgeMode: 0 });
    const out = await paint(flat(), state, 0.75, "cut");

    for (const f of [...UNWRAPPED_HALF, ...WRAPPED_HALF]) {
      expect(out[f], `frame ${f}`).toBeCloseTo(0.5, 3);
    }
  });

  it("Bleed edge mode reads across the file edge when time wraps", async () => {
    // Brush covers frames 2..4; a half-beat shift moves every read to before the
    // file start, so with time wrap they must come from the file's tail.
    const brush = { brushSizeTime: 0.2, transformShiftBeats: 0.5, transformEdgeMode: 1 };
    const wrapped = await paint(flat(), stateFor({ ...brush, brushWrapMode: 1 }), 0.1, "bleed-wrap");
    const unwrapped = await paint(flat(), stateFor({ ...brush, brushWrapMode: 0 }), 0.1, "bleed-off");

    for (const f of [2, 3, 4]) {
      expect(wrapped[f], `wrapped frame ${f}`).toBeCloseTo(0.5, 3);
      // Wrap Off must still zero-pad past the file edge.
      expect(unwrapped[f], `unwrapped frame ${f}`).toBeLessThan(0.01);
    }
  });

  it("time scaling stays anchored to the brush across the wrap seam", async () => {
    // Brush at x=0.6 spanning 0.6 UV wraps frames 0..2 back to the start.
    // Scale 2 halves the brush-local read offset, so a fragment at brush-local
    // position L reads 0.6 + L/2 — including on the wrapped side.
    const state = stateFor({ brushSizeTime: 0.6, brushWrapMode: 1, transformEdgeMode: 1, transformScaleTime: 2 });
    const out = await paint(logRamp(), state, 0.6, "scale");

    for (const frame of [0, 1, 2, 10, 11, 12, 13, 14, 15]) {
      const destUv = frame / numFrames;
      const local = (((destUv - 0.6) % 1) + 1) % 1;
      const expected = Math.pow(2, 0.6 + local / 2);
      expect(out[frame], `frame ${frame}`).toBeCloseTo(expected, 2);
    }
  });

  // The mock analyses at 24 bands/octave, so one semitone is two bands. Shifting
  // the ladder must rotate it — bands pushed past one end reappear at the other
  // — rather than smearing the edge band across everything beyond it.
  it.each([1, -1])("pitch shift of %i semitones wraps past the end band", async (semis) => {
    const state = stateFor({
      brushSizeTime: 1, // one beat == the whole file
      brushWrapMode: 2, // Pitch
      transformEdgeMode: 1,
      transformShiftSemis: semis,
    });
    const out = magByBand(await paintRaw(bandLadder(), state, 0, `pitch-wrap-${semis}`), numFrames, numBands);

    const bandsPerSemitone = 24 / 12;
    for (let band = 0; band < numBands; band++) {
      const sourceBand = (((band + semis * bandsPerSemitone) % numBands) + numBands) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });

  // Full mode anchors the brush to 0 and sizes it to the whole canvas on that
  // axis, so the brush covers exactly one loop. A shift must still wrap.
  it("time shift wraps under a Full-width brush", async () => {
    const state = stateFor({
      brushSizeTime: BRUSH_SIZE_TIME_FULL,
      brushSizePitch: 12,
      brushWrapMode: 1, // Time
      transformEdgeMode: 1,
      transformShiftBeats: 0.5,
    });
    const out = await paint(logRamp(), state, 0.5, "full-time");

    for (let frame = 0; frame < numFrames; frame++) {
      const read = (((frame / numFrames - 0.5) % 1) + 1) % 1;
      expect(out[frame], `frame ${frame}`).toBeCloseTo(Math.pow(2, read), 2);
    }
  });

  it("pitch shift wraps under a Full-height brush", async () => {
    const state = stateFor({
      brushSizeTime: 1,
      brushSizePitch: BRUSH_SIZE_PITCH_FULL,
      brushWrapMode: 2, // Pitch
      transformEdgeMode: 1,
      transformShiftSemis: 1,
    });
    const out = magByBand(await paintRaw(bandLadder(), state, 0, "full-pitch"), numFrames, numBands);

    for (let band = 0; band < numBands; band++) {
      const sourceBand = (band + 2) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });

  // Edge mode governs reads that leave the BRUSH. A Full-height brush spans the
  // whole canvas, so nothing a pitch shift reads is ever outside it — every edge
  // mode must leave the canvas wrap alone and produce the same rotation.
  it.each([0, 1, 2, 3, 4, 5])("pitch shift wraps under a Full-height brush with edge mode %i", async (edgeMode) => {
    const state = stateFor({
      brushSizeTime: 1,
      brushSizePitch: BRUSH_SIZE_PITCH_FULL,
      brushWrapMode: 2,
      transformEdgeMode: edgeMode,
      transformShiftSemis: 1,
    });
    const out = magByBand(await paintRaw(bandLadder(), state, 0, `edge-${edgeMode}`), numFrames, numBands);

    for (let band = 0; band < numBands; band++) {
      const sourceBand = (band + 2) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });

  // Edge mode Wrap folds a read back inside the BRUSH, so under a Full-height
  // brush it folds at the canvas edge — the same rotation the canvas wrap gives,
  // with or without Wrap mode on. Under a smaller brush it would cycle over that
  // brush's much shorter pitch span instead.
  it("Wrap edge mode cycles over the whole canvas when the brush is Full-height", async () => {
    const state = stateFor({
      brushSizeTime: 1,
      brushSizePitch: BRUSH_SIZE_PITCH_FULL,
      brushWrapMode: 0, // Off — the brush edge is the canvas edge, so Wrap still cycles
      transformEdgeMode: 2,
      transformShiftSemis: 1,
    });
    const out = magByBand(await paintRaw(bandLadder(), state, 0, "edge-wrap-nocanvas"), numFrames, numBands);

    for (let band = 0; band < numBands; band++) {
      const sourceBand = (band + 2) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });

  // Every warp algorithm reads the source through the same dest→source map, so
  // the wrap must hold for all of them — the app defaults to Neutral (6), not 0.
  it.each([0, 1, 2, 3, 4, 6])("pitch shift wraps under a Full-height brush with algorithm %i", async (algorithm) => {
    const state = stateFor({
      brushSizeTime: 1,
      brushSizePitch: BRUSH_SIZE_PITCH_FULL,
      brushWrapMode: 2,
      transformEdgeMode: 1,
      transformShiftSemis: 1,
      algorithm,
    });
    const out = magByBand(await paintRaw(bandLadder(), state, 0, `algo-${algorithm}`), numFrames, numBands);

    for (let band = 0; band < numBands; band++) {
      const sourceBand = (band + 2) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });

  // Gaborator packs each octave at half the time resolution of the one above, so
  // bands differ in length and stride. Rebuild the Full-height pitch-wrap case on
  // that layout, where a wrapped read lands in a band whose time grid is a
  // different power of two from the one it was read for.
  describe("dyadic band layout", () => {
    // 12 bands/octave over 4 octaves => one semitone is exactly one band.
    const cqSampleRate = 64;
    const cqBands = 48;
    const cqShiftSemis = cqBands / 2;

    function cqLadder(): SpectrogramData {
      const spec = createConstantQMockSpectrogramData({
        durationSeconds: 1,
        sampleRate: cqSampleRate,
        bandsPerOctave: 12,
        minFreq: 2,
      });
      const { bandOffsets, bandLengths } = spec.synthesisMetadata;
      spec.packedData.fill(0);
      for (let band = 0; band < spec.numBands; band++) {
        for (let k = 0; k < bandLengths[band]; k++) {
          const idx = (bandOffsets[band] + k) * 4;
          spec.packedData[idx] = (band + 1) / spec.numBands;
          spec.packedData[idx + 2] = (band + 1) / spec.numBands;
        }
      }
      return spec;
    }

    // Average each band's own packed run, which is shorter for lower octaves.
    function cqMagByBand(data: Float32Array, spec: SpectrogramData): number[] {
      const { bandOffsets, bandLengths } = spec.synthesisMetadata;
      const out: number[] = [];
      for (let band = 0; band < spec.numBands; band++) {
        let sum = 0;
        for (let k = 0; k < bandLengths[band]; k++) sum += data[(bandOffsets[band] + k) * 4];
        out.push(sum / bandLengths[band]);
      }
      return out;
    }

    it.each([2, 4])("pitch shift wraps under a Full-height brush with edge mode %i", async (edgeMode) => {
      const spec = cqLadder();
      const state = stateFor({
        brushSizeTime: 1,
        brushSizePitch: BRUSH_SIZE_PITCH_FULL,
        brushWrapMode: 2,
        transformEdgeMode: edgeMode,
        transformShiftSemis: cqShiftSemis,
      });
      const renderer = makeRenderer(spec, `cq-edge-${edgeMode}`);
      renderer.renderStroke(
        { ...params(0), totalDuration: spec.numFrames / spec.sampleRate },
        state,
        sourceFileFor(renderer, spec, `cq-edge-${edgeMode}`),
      );
      const out = cqMagByBand(await renderer.getFBOData(), spec);

      for (let band = 0; band < spec.numBands; band++) {
        const sourceBand = (band + cqShiftSemis) % spec.numBands;
        expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / spec.numBands, 3);
      }
    });
  });

  it("Time & Pitch wrap shifts both axes under a Full brush", async () => {
    const state = stateFor({
      brushSizeTime: BRUSH_SIZE_TIME_FULL,
      brushSizePitch: BRUSH_SIZE_PITCH_FULL,
      brushWrapMode: 3, // Time & Pitch
      transformEdgeMode: 1,
      transformShiftBeats: 0.5,
      transformShiftSemis: 1,
    });
    const raw = await paintRaw(bandLadder(), state, 0.5, "full-both");

    // Content is constant along time, so the time shift must leave the ladder
    // intact while the pitch shift rotates it by two bands.
    const out = magByBand(raw, numFrames, numBands);
    for (let band = 0; band < numBands; band++) {
      const sourceBand = (band + 2) % numBands;
      expect(out[band], `band ${band}`).toBeCloseTo((sourceBand + 1) / numBands, 3);
    }
  });
});
