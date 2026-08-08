import { DataTexture, FloatType, RGBAFormat, Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createGL, createSpectrogramTextures } from "../../test/render-harness";
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

  function fill(magForFrame: (frame: number) => number): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        spec.packedData[idx] = magForFrame(frame);
        spec.packedData[idx + 2] = magForFrame(frame);
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

  function makeRenderer(spec: SpectrogramData, id: string): StrokeRenderer {
    const raw = createSpectrogramTextures(spec);
    const strokeTextures: StrokeTextures = {
      packedDataTex: raw.packedDataTex,
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
      algorithm: 0,
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

  async function paint(spec: SpectrogramData, state: State, cursorX: number, id: string): Promise<number[]> {
    const renderer = makeRenderer(spec, id);
    renderer.renderStroke(params(cursorX), state, sourceFileFor(renderer, spec, id));
    return magByFrame(await renderer.getFBOData(), numFrames, numBands);
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
});
