import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EffectType } from "../../effects/types";
import type { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { metadataTextureRows } from "../band-layout";
import { packedFold, padToFold } from "../constants";
import { strokeReach, type ReachContext } from "../effect-reach";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { BRUSH_SIZE_PITCH_FULL } from "../utils";

// A short file at a low sample rate, so a beat is a large, round number of
// frames and a whole scan of impulse positions stays cheap.
const NUM_FRAMES = 1024;
const NUM_BANDS = 16;
const SAMPLE_RATE = 256;
const BPM = 120;
const SECONDS = NUM_FRAMES / SAMPLE_RATE;
const FRAMES_PER_BEAT = (60 / BPM) * SAMPLE_RATE;

// The dab covers a beat in the middle of the file, so an impulse has room on
// both sides.
const BRUSH_BEATS = 1;
const BRUSH_FRAMES = BRUSH_BEATS * FRAMES_PER_BEAT;
const BRUSH_START_FRAME = 384;
const BRUSH_END_FRAME = BRUSH_START_FRAME + BRUSH_FRAMES;

// Impulse positions are stepped rather than searched: a reach is not always
// monotonic in distance, and the furthest hit is what matters.
const PROBE_STEP_FRAMES = 8;

function createTextures(data: SpectrogramData): {
  packedDataTex: DataTexture;
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
} {
  const { packedData, inverseMap, metadata, texels, numBands } = data;
  const { width, height } = packedFold(texels);

  const packedDataTex = new DataTexture(padToFold(packedData!, texels, 4), width, height, RGBAFormat, FloatType);
  packedDataTex.internalFormat = "RGBA32F";
  packedDataTex.minFilter = NearestFilter;
  packedDataTex.magFilter = NearestFilter;
  packedDataTex.wrapS = ClampToEdgeWrapping;
  packedDataTex.wrapT = ClampToEdgeWrapping;
  packedDataTex.needsUpdate = true;

  const originalPackedDataTex = packedDataTex.clone();
  originalPackedDataTex.needsUpdate = true;

  const inverseMapTex = new DataTexture(padToFold(inverseMap!, texels, 2), width, height, RGFormat, FloatType);
  inverseMapTex.internalFormat = "RG32F";
  inverseMapTex.minFilter = NearestFilter;
  inverseMapTex.magFilter = NearestFilter;
  inverseMapTex.wrapS = ClampToEdgeWrapping;
  inverseMapTex.wrapT = ClampToEdgeWrapping;
  inverseMapTex.needsUpdate = true;

  const metadataTex = new DataTexture(metadataTextureRows({ numBands, metadata }), numBands, 1, RGBAFormat, FloatType);
  metadataTex.internalFormat = "RGBA32F";
  metadataTex.minFilter = NearestFilter;
  metadataTex.magFilter = NearestFilter;
  metadataTex.wrapS = ClampToEdgeWrapping;
  metadataTex.wrapT = ClampToEdgeWrapping;
  metadataTex.needsUpdate = true;

  return { packedDataTex, originalPackedDataTex, inverseMapTex, metadataTex };
}

function placeholder(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

function modulatorScaleLut(): DataTexture {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = i / 255;
    data[i * 4 + 1] = i / 255;
    data[i * 4 + 2] = i / 255;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

// Content fills the dab, so an effect that reads the file to decide what to do
// with what it paints on has something to move, right out to the dab's edges,
// where its reads leave the dab.
const CARRIER_START = BRUSH_START_FRAME;
const CARRIER_END = BRUSH_END_FRAME;

/** A settled, frame-dependent magnitude, so neighbouring bins never match. */
function carrierMagnitude(frame: number): number {
  const noise = Math.sin(frame * 12.9898) * 43758.5453;
  return 0.15 + 0.7 * (noise - Math.floor(noise));
}

/** Energy across every band, over [from, to) frames. */
function putEnergy(data: SpectrogramData, from: number, to: number, magnitude?: number): void {
  const packed = data.packedData!;
  for (let band = 0; band < data.numBands; band++) {
    for (let frame = from; frame < to; frame++) {
      const pixel = band * data.numFrames + frame;
      const mag = magnitude ?? carrierMagnitude(frame);
      packed[pixel * 4] = mag;
      packed[pixel * 4 + 1] = 0.5;
      packed[pixel * 4 + 2] = mag;
      packed[pixel * 4 + 3] = 0.5;
    }
  }
}

/** The state of a brush whose only effect is the one under measurement. */
function stateFor(effect: EffectType, params: Record<string, number>): State {
  const effects = [{ id: `probe-${effect}`, effect, enabled: true, params }];
  const step = {
    effects,
    brushSizeTime: BRUSH_BEATS,
    brushSizePitch: BRUSH_SIZE_PITCH_FULL,
    brushCurveTime: 0,
    brushSkewTime: 0,
    brushCurvePitch: 0,
    brushSkewPitch: 0,
    brushIntensity: 100,
    gridSizeBeats: 8,
    gridSizeSemis: 12,
  };
  const state = createMockState({ filepathsBpm: { "/test/reach.wav": BPM }, ...step });
  const steps = state.brushes[state.activeBrushIndex]?.steps;
  if (steps?.[0]) Object.assign(steps[0] as unknown as Record<string, unknown>, step);
  return state;
}

describe("what a gated effect really reads", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let placeholderTex: DataTexture;
  let scaleLut: DataTexture;

  beforeEach(async () => {
    const [attract, blur, convolve, evolve, sort, transmute, passthrough] = await Promise.all([
      import("../../effects/attract-effect"),
      import("../../effects/blur-effect"),
      import("../../effects/convolve-effect"),
      import("../../effects/evolve-effect"),
      import("../../effects/sort-effect"),
      import("../../effects/transmute-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = {
      attract: attract.attractEffect,
      blur: blur.blurEffect,
      convolve: convolve.convolveEffect,
      evolve: evolve.evolveEffect,
      sort: sort.sortEffect,
      transmute: transmute.transmuteEffect,
      passthrough: passthrough.passThroughEffect,
    };
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    placeholderTex = placeholder();
    scaleLut = modulatorScaleLut();
  });

  afterEach(() => {
    placeholderTex.dispose();
    scaleLut.dispose();
    gl.dispose();
  });

  /** Paints the dab on silence, with an impulse at `frame` when one is asked for. */
  async function paint(state: State, frame: number | null): Promise<Float32Array> {
    const data = createMockSpectrogramData({
      numFrames: NUM_FRAMES,
      numBands: NUM_BANDS,
      sampleRate: SAMPLE_RATE,
      pattern: "silence",
    });
    putEnergy(data, CARRIER_START, CARRIER_END);
    if (frame !== null) putEnergy(data, frame, frame + 1, 1);
    const textures = createTextures(data);
    const strokeTextures: StrokeTextures = {
      originalPackedDataTex: textures.originalPackedDataTex,
      inverseMapTex: textures.inverseMapTex,
      metadataTex: textures.metadataTex,
      placeholderTexture: placeholderTex,
      modulatorScaleLut: scaleLut,
      modulator1Texture: placeholderTex,
      modulator2Texture: placeholderTex,
      modulator3Texture: placeholderTex,
    };
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "reach", effects);
    renderer.initialize();
    const rendererTextures = renderer.getTextures();
    const source: SourceFileInfo = {
      id: "reach",
      filePath: "/test/reach.wav",
      displayName: "reach.wav",
      spectrogramData: data,
      textures: {
        packed: rendererTextures.packed,
        inverse: rendererTextures.inverse,
        metadata: rendererTextures.metadata,
        original: rendererTextures.original,
      },
    };
    const params: StrokeParams = {
      cursorPos: new Vector2(BRUSH_START_FRAME / NUM_FRAMES, 0),
      preview: false,
      bpm: BPM,
      totalDuration: SECONDS,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };
    renderer.renderStroke(params, state, source);
    const out = await renderer.getFBOData();
    renderer.dispose();
    for (const tex of Object.values(textures)) tex.dispose();
    return out;
  }

  /**
   * True when the dab's own pixels came out differently. The two runs differ
   * only in the impulse, and each is one deterministic render, so any
   * difference at all is a read of it.
   */
  function dabChanged(a: Float32Array, b: Float32Array): boolean {
    for (let band = 0; band < NUM_BANDS; band++) {
      for (let frame = BRUSH_START_FRAME; frame < BRUSH_END_FRAME; frame++) {
        const i = (band * NUM_FRAMES + frame) * 4;
        for (let c = 0; c < 4; c++) if (a[i + c] !== b[i + c]) return true;
      }
    }
    return false;
  }

  /**
   * The furthest an impulse can sit outside the dab and still change it, in
   * frames, measured on each side. `limit` bounds the scan. The first bin
   * beside the dab is always tried, because a read one bin wide falls between
   * the steps of any coarser scan.
   */
  async function measureReach(
    state: State,
    limitFrames: number,
    step = PROBE_STEP_FRAMES,
  ): Promise<{ before: number; after: number }> {
    const plain = await paint(state, null);
    const distances = [1];
    for (let d = step; d <= limitFrames; d += step) distances.push(d);
    let before = 0;
    let after = 0;
    for (const d of distances) {
      const low = BRUSH_START_FRAME - d;
      const high = BRUSH_END_FRAME - 1 + d;
      if (low >= 0 && dabChanged(plain, await paint(state, low))) before = d;
      if (high < NUM_FRAMES && dabChanged(plain, await paint(state, high))) after = d;
    }
    return { before, after };
  }

  // The context `effect-reach.ts` measures its formulas against, for the
  // brush and the file this harness paints.
  const reachContext: ReachContext = {
    bpm: BPM,
    fileSeconds: SECONDS,
    canvasSeconds: SECONDS,
    bandsPerOctave: 24,
    numBands: NUM_BANDS,
  };

  it("finds the smear a blur declares, so the measurement can be believed", async () => {
    const state = stateFor("blur", { blurAmountTime: 25, blurNoiseTime: 0, blurEdgeMode: 1, blurOrigin: 1 });
    const declared = strokeReach(state, reachContext);
    const declaredFrames = declared.after * SAMPLE_RATE;
    expect(declaredFrames).toBeCloseTo(FRAMES_PER_BEAT, 3);

    // The taps run [-radius, radius - 1], so the smear reaches one tap less
    // forward than back, and the furthest impulse a nearest read lands on
    // sits a probe step inside each.
    const back = declaredFrames;
    const forward = (declaredFrames * 7) / 8;
    const measured = await measureReach(state, Math.round(declaredFrames) + 4 * PROBE_STEP_FRAMES);
    expect(measured.before).toBeLessThanOrEqual(back);
    expect(measured.before).toBeGreaterThan(back - 2 * PROBE_STEP_FRAMES);
    expect(measured.after).toBeLessThanOrEqual(forward);
    expect(measured.after).toBeGreaterThan(forward - 2 * PROBE_STEP_FRAMES);
  });

  it("moves a band by the beats Transmute is given, and no further", async () => {
    // Time is the one route that reads elsewhere: the drive moves the read by
    // up to the amount, in beats, either side of the bin it writes.
    const at = async (beats: number): Promise<number> => {
      const state = stateFor("transmute", {
        transmuteFrom: 0,
        transmuteTo: 2,
        transmuteAmount: beats,
        transmuteCurve: 1,
      });
      const measured = await measureReach(state, Math.round(beats * FRAMES_PER_BEAT) + PROBE_STEP_FRAMES);
      return Math.max(measured.before, measured.after);
    };
    const one = await at(1);
    const two = await at(2);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(FRAMES_PER_BEAT);
    expect(two).toBeLessThanOrEqual(2 * FRAMES_PER_BEAT);
    expect(two).toBeGreaterThanOrEqual(2 * one - 2 * PROBE_STEP_FRAMES);
  });

  it("gathers about the beats Attract is smoothed over", async () => {
    // The gather moves only content the brush covers, so the file is read no
    // further than the kernel reaches past the brush's own edge.
    const at = async (beats: number): Promise<number> => {
      const state = stateFor("attract", {
        attractMap: 0,
        attractAmountX: 100,
        attractAmountY: 0,
        attractSmoothX: beats,
        attractSmoothY: 1,
      });
      const measured = await measureReach(state, Math.round(2 * beats * FRAMES_PER_BEAT));
      return Math.max(measured.before, measured.after);
    };
    const quarter = await at(0.25);
    const half = await at(0.5);
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThanOrEqual(0.25 * FRAMES_PER_BEAT);
    expect(half).toBeLessThanOrEqual(0.5 * FRAMES_PER_BEAT);
    expect(half).toBeGreaterThan(quarter);
  });

  it("reads a quarter of the canvas away when Evolve flows", async () => {
    // Evolve's offsets are fractions of the canvas, and the advection follows
    // the magnitude gradient, so how far it reads depends on the sound as well
    // as on the settings. This is why a window cannot serve it.
    const state = stateFor("evolve", {
      evolveScaleX: 100,
      evolveScaleY: 0,
      evolveFlow: 100,
      evolveDriftX: 100,
      evolveDriftY: 0,
      evolveSpread: 100,
      evolveGrow: 0,
      evolveSwirl: 0,
      evolveDecay: 0,
      evolveEdgeMode: 1,
    });
    const measured = await measureReach(state, Math.round(NUM_FRAMES / 3), 3 * PROBE_STEP_FRAMES);
    expect(measured.before).toBeGreaterThan(NUM_FRAMES / 8);
    expect(measured.after).toBeGreaterThan(NUM_FRAMES / 8);
  });

  it("reads the head of the file when Convolve has no impulse response of its own", async () => {
    // With no file picked, the impulse response is the canvas itself, read
    // from its first frame: tap k takes IR frame k whatever the dab covers.
    const state = stateFor("convolve", {
      convolveIrSize: 64,
      convolveIrRate: 1,
      convolveIrTimeOffset: 0,
      convolveGainDb: 0,
      convolveIrPitchShift: 0,
      convolveEdgeMode: 1,
    });
    const plain = await paint(state, null);
    expect(dabChanged(plain, await paint(state, 8))).toBe(true);
    // The far end of the file is past every tap, so the read has an end.
    expect(dabChanged(plain, await paint(state, NUM_FRAMES - 8))).toBe(false);
  });

  it("reads nothing outside the dab when it sorts", async () => {
    const state = stateFor("sort", { sortDirection: 2, sortOrder: 0, sortBy: 0, sortStereoMode: 0 });
    const off = stateFor("passthrough", {});
    // A sort that changed nothing would read nothing for a dull reason.
    expect(dabChanged(await paint(state, null), await paint(off, null))).toBe(true);
    // Every pass swaps a bin with the one beside it, and only when that one is
    // inside the brush too, so the dab reads only itself.
    expect(await measureReach(state, 4 * PROBE_STEP_FRAMES)).toEqual({ before: 0, after: 0 });
  });
});
