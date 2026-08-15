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

import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData, readSpectrogramPixel } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

/**
 * Phase behaviour of the default paste (passthrough effect, Neutral warp)
 * when the source file's analysis geometry differs from the destination's.
 *
 * The physics under test: a component at true frequency f₀ stored in a band
 * with centre f_c carries residual phase φ(t) = φ₀ + 2π(f₀ − f_c)·t, and the
 * synthesis adds the band carrier back. A paste that moves content to a band
 * with a different centre must re-anchor that residual against the new
 * carrier — additively — and must not treat the band-grid offset as a pitch
 * shift or as a time stretch.
 */

const TWO_PI = Math.PI * 2;

function wrapPhase(p: number): number {
  return ((((p + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function createTexturesFromSpectrogramData(spectrogramData: SpectrogramData): {
  packedDataTex: DataTexture;
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
} {
  const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

  const packedDataTex = new DataTexture(packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
  packedDataTex.internalFormat = "RGBA32F";
  packedDataTex.minFilter = NearestFilter;
  packedDataTex.magFilter = NearestFilter;
  packedDataTex.wrapS = ClampToEdgeWrapping;
  packedDataTex.wrapT = ClampToEdgeWrapping;
  packedDataTex.needsUpdate = true;

  const originalPackedDataTex = packedDataTex.clone();
  originalPackedDataTex.needsUpdate = true;

  const inverseMapTex = new DataTexture(inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
  inverseMapTex.internalFormat = "RG32F";
  inverseMapTex.minFilter = NearestFilter;
  inverseMapTex.magFilter = NearestFilter;
  inverseMapTex.wrapS = ClampToEdgeWrapping;
  inverseMapTex.wrapT = ClampToEdgeWrapping;
  inverseMapTex.needsUpdate = true;

  const metadataTex = new DataTexture(metadata, numBands, 1, RGBAFormat, FloatType);
  metadataTex.internalFormat = "RGBA32F";
  metadataTex.minFilter = NearestFilter;
  metadataTex.magFilter = NearestFilter;
  metadataTex.wrapS = ClampToEdgeWrapping;
  metadataTex.wrapT = ClampToEdgeWrapping;
  metadataTex.needsUpdate = true;

  return { packedDataTex, originalPackedDataTex, inverseMapTex, metadataTex };
}

function createPlaceholderTexture(): DataTexture {
  const data = new Float32Array(4);
  const tex = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

function createModulatorScaleLut(): DataTexture {
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

async function loadEffects(): Promise<EffectsRegistry> {
  const [
    { transformEffect },
    { dynamicsEffect },
    { blurEffect },
    { cloneEffect },
    { synthesizeEffect },
    { passThroughEffect },
  ] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/blur-effect"),
    import("../../effects/clone-effect"),
    import("../../effects/synthesize-effect"),
    import("../../effects/passthrough-effect"),
  ]);

  return {
    transform: transformEffect,
    dynamics: dynamicsEffect,
    blur: blurEffect,
    clone: cloneEffect,
    synthesize: synthesizeEffect,
    passthrough: passThroughEffect,
  };
}

/** Band centre frequency in the mock layout, indexed from the BOTTOM (0 = lowest). */
function bandFreqFromBottom(spec: SpectrogramData, bandFromBottom: number): number {
  return spec.minFreq * Math.pow(2, bandFromBottom / spec.bandsPerOctave);
}

/** Mock/gaborator band array index (0 = highest band) for a from-bottom index. */
function bandIndexFromTop(spec: SpectrogramData, bandFromBottom: number): number {
  return spec.numBands - 1 - bandFromBottom;
}

/** Dest time in seconds for frame m, matching the shader's UV → seconds path. */
function frameTimeSec(spec: SpectrogramData, frame: number): number {
  return (frame / spec.numFrames) * ((spec.numFrames - 1) / spec.sampleRate);
}

describe("cross-file paste phase handling", () => {
  let gl: WebGLRenderer;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;
  const disposables: Array<{ dispose(): void }> = [];

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    placeholderTexture = createPlaceholderTexture();
    modulatorScaleLut = createModulatorScaleLut();
  });

  afterEach(() => {
    for (const d of disposables.splice(0)) {
      d.dispose();
    }
    placeholderTexture.dispose();
    modulatorScaleLut.dispose();
    gl.dispose();
  });

  function makeRenderer(spec: SpectrogramData, id: string): StrokeRenderer {
    const raw = createTexturesFromSpectrogramData(spec);
    disposables.push(raw.packedDataTex, raw.originalPackedDataTex, raw.inverseMapTex, raw.metadataTex);
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

  function makeSourceFile(
    renderer: StrokeRenderer,
    spec: SpectrogramData,
    id: string,
    filePath: string,
  ): SourceFileInfo {
    const tex = renderer.getTextures();
    return {
      id,
      filePath,
      displayName: filePath,
      spectrogramData: spec,
      textures: {
        packed: tex.packed,
        inverse: tex.inverse,
        metadata: tex.metadata,
        original: tex.original,
      },
    };
  }

  function pasteState(filepathsBpm: Record<string, number>): State {
    return createMockStateWithSteps(
      [
        {
          name: "Paste",
          overrides: {
            brushIntensity: 100,
            brushSizeTime: 10,
            brushSizePitch: 100,
            brushCurveTime: 100,
            brushSkewTime: -100,
            brushCurvePitch: 100,
            brushSkewPitch: -100,
            accumulate: false,
            blendMode: 0,
            algorithm: 6,
            sourcePositionMode: "follow",
            effects: [
              { id: "test-transform", effect: "transform" as const, enabled: false, params: {} },
              { id: "test-dynamics", effect: "dynamics" as const, enabled: false, params: {} },
              { id: "test-blur", effect: "blur" as const, enabled: false, params: {} },
              { id: "test-synthesize", effect: "synthesize" as const, enabled: false, params: {} },
            ],
          },
        },
      ],
      { filepathsBpm },
    ) as State;
  }

  function pasteParams(totalDuration: number): StrokeParams {
    return {
      cursorPos: new Vector2(0, 0),
      preview: false,
      bpm: 120,
      totalDuration,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 1,
      tiltX: 0,
      tiltY: 0,
    };
  }

  function readPixel(data: Float32Array, spec: SpectrogramData, frame: number, bandFromTop: number) {
    return readSpectrogramPixel(
      data,
      frame,
      bandFromTop,
      spec.numFrames,
      spec.numBands,
      spec.textureWidth,
      spec.textureHeight,
    );
  }

  it("keeps a tone at its true frequency when the band layouts differ", async () => {
    // Source at 24 bands/octave, dest at 36: dest band centres fall up to a
    // third of a source band away from the centres they read. One source band
    // holds a tone at its own centre: magnitude 1, constant phase PHI0 — the
    // residual of a tone AT the centre is zero, so constant phase is exact.
    const sampleRate = 4410;
    const numFrames = 4410;
    const destSpec = createMockSpectrogramData({
      numFrames,
      numBands: 36,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 36,
      pattern: "silence",
    });
    const sourceSpec = createMockSpectrogramData({
      numFrames,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 24,
      pattern: "silence",
    });

    const PHI0 = 20.0;
    const toneBandFromBottom = 11;
    const toneBandFromTop = bandIndexFromTop(sourceSpec, toneBandFromBottom);
    for (let frame = 0; frame < sourceSpec.numFrames; frame++) {
      const base = (toneBandFromTop * sourceSpec.numFrames + frame) * 4;
      sourceSpec.packedData[base] = 1.0;
      sourceSpec.packedData[base + 1] = PHI0;
      sourceSpec.packedData[base + 2] = 1.0;
      sourceSpec.packedData[base + 3] = PHI0;
    }

    const destRenderer = makeRenderer(destSpec, "xres-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "xres-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "xres-source", "/test/xres-source.wav");

    const state = pasteState({ "/test/xres-dest.wav": 120, "/test/xres-source.wav": 120 });
    destRenderer.renderStroke(pasteParams(destSpec.numFrames / destSpec.sampleRate), state, sourceFile);
    const output = await destRenderer.getFBOData();

    // Every dest band whose nearest source band is the tone band must carry
    // the tone: full magnitude, and phase advancing at 2π(f_tone − f_dest)·t —
    // the tone's own frequency re-anchored against the dest band's centre.
    const toneFreq = bandFreqFromBottom(sourceSpec, toneBandFromBottom);
    let checkedBands = 0;
    let misalignedBands = 0;
    for (let destFromBottom = 0; destFromBottom < destSpec.numBands; destFromBottom++) {
      const destFreq = bandFreqFromBottom(destSpec, destFromBottom);
      const srcIdx = sourceSpec.bandsPerOctave * Math.log2(destFreq / sourceSpec.minFreq);
      if (Math.round(srcIdx) !== toneBandFromBottom) continue;
      checkedBands++;
      if (Math.abs(srcIdx - Math.round(srcIdx)) > 1e-3) misalignedBands++;

      const bandFromTop = bandIndexFromTop(destSpec, destFromBottom);
      for (let frame = 200; frame <= 4200; frame += 500) {
        const pixel = readPixel(output, destSpec, frame, bandFromTop);
        expect(pixel).not.toBeNull();
        if (!pixel) continue;
        expect(pixel[0]).toBeGreaterThan(0.5);
        const expected = PHI0 + TWO_PI * (toneFreq - destFreq) * frameTimeSec(destSpec, frame);
        expect(Math.abs(wrapPhase(pixel[1] - expected))).toBeLessThan(0.05);
        expect(Math.abs(wrapPhase(pixel[3] - expected))).toBeLessThan(0.05);
      }
    }
    // The layout pair must actually exercise the mismatch, or the test proves nothing.
    expect(checkedBands).toBeGreaterThan(0);
    expect(misalignedBands).toBeGreaterThan(0);
  });

  it("does not stretch phase when the files have different lengths at equal tempo", async () => {
    // Same layout, source half the dest's length, both at 120 bpm. One dest
    // second maps to one source second, so the paste is 1:1 in time and the
    // stored phase must come through unscaled. The beat-based UV conversion
    // (sourceTimeScale = 2 here) must not masquerade as a 2× time stretch.
    const sampleRate = 4410;
    const destSpec = createMockSpectrogramData({
      numFrames: 4410,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 24,
      pattern: "silence",
    });
    const sourceSpec = createMockSpectrogramData({
      numFrames: 2205,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 24,
      pattern: "silence",
    });

    // Tonal content in every band: linear phase ramp, constant magnitude.
    const phaseAt = (frame: number) => 0.3 + 0.02 * frame;
    for (let band = 0; band < sourceSpec.numBands; band++) {
      for (let frame = 0; frame < sourceSpec.numFrames; frame++) {
        const base = (band * sourceSpec.numFrames + frame) * 4;
        sourceSpec.packedData[base] = 0.8;
        sourceSpec.packedData[base + 1] = phaseAt(frame);
        sourceSpec.packedData[base + 2] = 0.8;
        sourceSpec.packedData[base + 3] = phaseAt(frame);
      }
    }

    const destRenderer = makeRenderer(destSpec, "xlen-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "xlen-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "xlen-source", "/test/xlen-source.wav");

    const state = pasteState({ "/test/xlen-dest.wav": 120, "/test/xlen-source.wav": 120 });
    destRenderer.renderStroke(pasteParams(destSpec.numFrames / destSpec.sampleRate), state, sourceFile);
    const output = await destRenderer.getFBOData();

    // First half of the dest: dest frame m reads source frame m. Phase must
    // match the source ramp; the old rule multiplied it by 2.
    for (let bandFromTop = 2; bandFromTop < destSpec.numBands - 2; bandFromTop += 4) {
      for (let frame = 100; frame <= 2100; frame += 200) {
        const pixel = readPixel(output, destSpec, frame, bandFromTop);
        expect(pixel).not.toBeNull();
        if (!pixel) continue;
        expect(pixel[0]).toBeGreaterThan(0.4);
        expect(Math.abs(wrapPhase(pixel[1] - phaseAt(frame)))).toBeLessThan(0.05);
        expect(Math.abs(wrapPhase(pixel[3] - phaseAt(frame)))).toBeLessThan(0.05);
      }
    }
  });

  it("keeps a Fixed-tracking source static across different band layouts", async () => {
    // Source at 12 bands/octave, dest at 60, both spanning the same two
    // octaves. Fixed tracking compensates cursor movement with the slope of
    // the freq-preserving band map — which is NOT the band-count ratio when
    // the resolutions differ. Painting the same Fixed stroke at two different
    // pitch positions must deposit the same source content under the brush.
    const sampleRate = 44100;
    const numFrames = 256;
    const makeDest = () =>
      createMockSpectrogramData({
        numFrames,
        numBands: 120,
        sampleRate,
        minFreq: 20,
        bandsPerOctave: 60,
        pattern: "silence",
      });
    const sourceSpec = createMockSpectrogramData({
      numFrames,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 12,
      pattern: "bandGradient",
    });

    const sourceRenderer = makeRenderer(sourceSpec, "fixed-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "fixed-source", "/test/fixed-source.wav");
    const bpmMap = { "/test/fixed-dest.wav": 120, "/test/fixed-source.wav": 120 };

    function fixedState(): State {
      const state = pasteState(bpmMap);
      const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
      step.sourcePositionMode = "fixed";
      step.brushSizePitch = 6;
      return state;
    }

    async function paintAt(cursorY: number): Promise<Float32Array> {
      const destSpec = makeDest();
      const destRenderer = makeRenderer(destSpec, `fixed-dest-${cursorY}`);
      const params = pasteParams(destSpec.numFrames / destSpec.sampleRate);
      params.cursorPos = new Vector2(0, cursorY);
      destRenderer.renderStroke(params, fixedState(), sourceFile);
      return destRenderer.getFBOData();
    }

    // Cursor positions a whole number of dest bands apart, so the two brush
    // footprints tile the same band offsets. They sit low on the pitch axis to
    // keep every read inside the source: an off-scale read clamps to the edge
    // band, and two clamped reads compare equal even when the offsets differ.
    const cursorA = 0.025;
    const cursorB = 0.05;
    const outputA = await paintAt(cursorA);
    const outputB = await paintAt(cursorB);
    const bandShift = Math.round((cursorB - cursorA) * 120);

    const destSpec = makeDest();
    const frame = 128;
    let comparedBands = 0;
    let solidBands = 0;
    for (let bandFromBottomA = 8; bandFromBottomA <= 30; bandFromBottomA++) {
      const bandFromTopA = 120 - 1 - bandFromBottomA;
      const bandFromTopB = 120 - 1 - (bandFromBottomA + bandShift);
      const pixelA = readPixel(outputA, destSpec, frame, bandFromTopA);
      const pixelB = readPixel(outputB, destSpec, frame, bandFromTopB);
      expect(pixelA).not.toBeNull();
      expect(pixelB).not.toBeNull();
      if (!pixelA || !pixelB) continue;
      // The brush-local content must match between the two strokes: the source
      // read is static. The cross-resolution resampler attenuates duplicated
      // sub-bands toward zero away from the content's measured frequency, so
      // magnitude is only required on the aligned duplicates, counted below.
      expect(Math.abs(pixelA[0] - pixelB[0])).toBeLessThan(1e-3);
      expect(Math.abs(pixelA[2] - pixelB[2])).toBeLessThan(1e-3);
      if (pixelA[0] > 0.05) solidBands++;
      comparedBands++;
    }
    expect(comparedBands).toBeGreaterThan(20);
    expect(solidBands).toBeGreaterThan(3);
  });

  it("keeps later Fixed-source strokes phase-coherent on one canvas", async () => {
    // Consecutive strokes on the SAME dest canvas, Fixed source, cross
    // resolution. The first stroke reads the source at zero time offset; every
    // later stroke reads it offset by the cursor's travel. A pasted tone must
    // come out as the same tone in every stamp — delayed by the offset, and
    // fully overriding earlier stamps where strokes overlap (Mix at 100%).
    const sampleRate = 4096;
    const numFrames = 4096;
    const destSpec = createMockSpectrogramData({
      numFrames,
      numBands: 120,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 60,
      pattern: "silence",
    });
    const sourceSpec = createMockSpectrogramData({
      numFrames,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 12,
      pattern: "silence",
    });

    const PHI0 = 20.0;
    const toneBandFromBottom = 16;
    const toneBandFromTop = bandIndexFromTop(sourceSpec, toneBandFromBottom);
    for (let frame = 0; frame < sourceSpec.numFrames; frame++) {
      const base = (toneBandFromTop * sourceSpec.numFrames + frame) * 4;
      sourceSpec.packedData[base] = 1.0;
      sourceSpec.packedData[base + 1] = PHI0;
      sourceSpec.packedData[base + 2] = 1.0;
      sourceSpec.packedData[base + 3] = PHI0;
    }

    const destRenderer = makeRenderer(destSpec, "seq-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "seq-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "seq-source", "/test/seq-source.wav");

    function fixedState(): State {
      const state = pasteState({ "/test/seq-dest.wav": 120, "/test/seq-source.wav": 120 });
      const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
      step.sourcePositionMode = "fixed";
      step.brushSizeTime = 0.5;
      return state;
    }

    // Stroke A at the source's own position, B disjoint half a file later,
    // C overlapping A — painted last, so Mix must replace A's content.
    for (const cursorX of [0, 0.5, 0.15]) {
      destRenderer.beginStroke();
      const params = pasteParams(destSpec.numFrames / destSpec.sampleRate);
      params.cursorPos = new Vector2(cursorX, 0);
      destRenderer.renderStroke(params, fixedState(), sourceFile);
      destRenderer.endStroke();
    }
    const output = await destRenderer.getFBOData();

    const toneFreq = bandFreqFromBottom(sourceSpec, toneBandFromBottom);
    const expectedPhase = (frame: number, destFromBottom: number, cursorX: number) => {
      const tD = frameTimeSec(destSpec, frame);
      const tS = frameTimeSec(sourceSpec, frame - cursorX * numFrames);
      const fDest = bandFreqFromBottom(destSpec, destFromBottom);
      return PHI0 + TWO_PI * toneFreq * (tS - tD) + TWO_PI * (toneFreq - fDest) * tD;
    };

    const stamps: Array<{ cursorX: number; frames: number[] }> = [
      { cursorX: 0, frames: [200, 350, 500] },
      { cursorX: 0.5, frames: [2150, 2500, 2900] },
      { cursorX: 0.15, frames: [700, 1000, 1300, 1550] },
    ];
    const alignedFromBottom = toneBandFromBottom * 5;
    for (const { cursorX, frames } of stamps) {
      for (const destFromBottom of [alignedFromBottom - 1, alignedFromBottom, alignedFromBottom + 1]) {
        const bandFromTop = bandIndexFromTop(destSpec, destFromBottom);
        for (const frame of frames) {
          const pixel = readPixel(output, destSpec, frame, bandFromTop);
          expect(pixel).not.toBeNull();
          if (!pixel) continue;
          if (destFromBottom === alignedFromBottom) {
            expect(pixel[0]).toBeGreaterThan(0.8);
          } else {
            // One dest band off the tone: the resampler's atom response e⁻¹.
            expect(pixel[0]).toBeGreaterThan(0.2);
            expect(pixel[0]).toBeLessThan(0.6);
          }
          const expected = expectedPhase(frame, destFromBottom, cursorX);
          expect(Math.abs(wrapPhase(pixel[1] - expected))).toBeLessThan(0.05);
          expect(Math.abs(wrapPhase(pixel[3] - expected))).toBeLessThan(0.05);
        }
      }
    }
  });

  it("splits noise energy across duplicated sub-bands and decorrelates them", async () => {
    // Source at 12 bpo with random per-bin phases: the resampler must read it
    // as noise, scale each of the ~5 duplicates to 1.65/sqrt(5) of the source
    // magnitude, and give each dest band its own phase.
    const sampleRate = 44100;
    const numFrames = 256;
    const destSpec = createMockSpectrogramData({
      numFrames,
      numBands: 120,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 60,
      pattern: "silence",
    });
    const sourceSpec = createMockSpectrogramData({
      numFrames,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 12,
      pattern: "silence",
    });
    for (let band = 0; band < sourceSpec.numBands; band++) {
      for (let frame = 0; frame < sourceSpec.numFrames; frame++) {
        const base = (band * sourceSpec.numFrames + frame) * 4;
        const phase = Math.random() * TWO_PI;
        sourceSpec.packedData[base] = 0.6;
        sourceSpec.packedData[base + 1] = phase;
        sourceSpec.packedData[base + 2] = 0.6;
        sourceSpec.packedData[base + 3] = phase;
      }
    }

    const destRenderer = makeRenderer(destSpec, "xnoise-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "xnoise-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "xnoise-source", "/test/xnoise-source.wav");
    const state = pasteState({ "/test/xnoise-dest.wav": 120, "/test/xnoise-source.wav": 120 });
    destRenderer.renderStroke(pasteParams(destSpec.numFrames / destSpec.sampleRate), state, sourceFile);
    const output = await destRenderer.getFBOData();

    const expectedMag = 0.6 * (1.65 / Math.sqrt(5));
    const frame = 128;
    for (let bandFromBottom = 20; bandFromBottom <= 100; bandFromBottom += 20) {
      const pixel = readPixel(output, destSpec, frame, 120 - 1 - bandFromBottom);
      expect(pixel).not.toBeNull();
      if (!pixel) continue;
      expect(pixel[0]).toBeGreaterThan(expectedMag * 0.75);
      expect(pixel[0]).toBeLessThan(expectedMag * 1.25);
    }
    // Five consecutive dest bands read the same source band; their phases must
    // not be a single copied value.
    let maxDiff = 0;
    const phases: number[] = [];
    for (let bandFromBottom = 50; bandFromBottom < 55; bandFromBottom++) {
      const pixel = readPixel(output, destSpec, frame, 120 - 1 - bandFromBottom);
      if (pixel) phases.push(pixel[1]);
    }
    for (let a = 0; a < phases.length; a++) {
      for (let b = a + 1; b < phases.length; b++) {
        maxDiff = Math.max(maxDiff, Math.abs(wrapPhase(phases[a] - phases[b])));
      }
    }
    expect(phases.length).toBe(5);
    expect(maxDiff).toBeGreaterThan(0.5);
  });

  it("projects covered fine bands into a coarse band when downsampling", async () => {
    // Dest at 12 bpo reads a 60 bpo source. A single loud fine band must land
    // as sqrt(1/pi)·w·mag with its own phase; flat noise across the fine bands
    // must sum in power.
    const sampleRate = 44100;
    const numFrames = 256;
    const destSpec = createMockSpectrogramData({
      numFrames,
      numBands: 24,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 12,
      pattern: "silence",
    });
    const sourceSpec = createMockSpectrogramData({
      numFrames,
      numBands: 120,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 60,
      pattern: "silence",
    });

    // Tone-like: one fine band, nearest to a mid dest band's centre.
    const destBandFromBottom = 12;
    const destFreq = bandFreqFromBottom(destSpec, destBandFromBottom);
    const toneFromBottom = Math.round(sourceSpec.bandsPerOctave * Math.log2(destFreq / sourceSpec.minFreq));
    const TONE_PHI = 0.3;
    for (let frame = 0; frame < numFrames; frame++) {
      const base = (bandIndexFromTop(sourceSpec, toneFromBottom) * numFrames + frame) * 4;
      sourceSpec.packedData[base] = 0.8;
      sourceSpec.packedData[base + 1] = TONE_PHI;
      sourceSpec.packedData[base + 2] = 0.8;
      sourceSpec.packedData[base + 3] = TONE_PHI;
    }
    // Noise-like: flat magnitude with random phases, two octaves... kept in a
    // separate region: fill bands 20..60 from bottom at mag 0.5.
    for (let band = 20; band <= 60; band++) {
      if (band === toneFromBottom) continue;
      for (let frame = 0; frame < numFrames; frame++) {
        const base = (bandIndexFromTop(sourceSpec, band) * numFrames + frame) * 4;
        // Bands far from the tone's dest band form the noise probe; keep the
        // tone's own coarse neighbourhood silent so the two probes stay apart.
        const coarseDist = Math.abs(band - toneFromBottom);
        if (coarseDist < 12) continue;
        const phase = Math.random() * TWO_PI;
        sourceSpec.packedData[base] = 0.5;
        sourceSpec.packedData[base + 1] = phase;
        sourceSpec.packedData[base + 2] = 0.5;
        sourceSpec.packedData[base + 3] = phase;
      }
    }

    const destRenderer = makeRenderer(destSpec, "xdown-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "xdown-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "xdown-source", "/test/xdown-source.wav");
    const state = pasteState({ "/test/xdown-dest.wav": 120, "/test/xdown-source.wav": 120 });
    destRenderer.renderStroke(pasteParams(destSpec.numFrames / destSpec.sampleRate), state, sourceFile);
    const output = await destRenderer.getFBOData();

    const frame = 128;
    // Tone probe: peakiness ~1 → amplitude sum ≈ sqrt(1/pi)·w·0.8 ≈ 0.45.
    const tonePixel = readPixel(output, destSpec, frame, bandIndexFromTop(destSpec, destBandFromBottom));
    expect(tonePixel).not.toBeNull();
    if (tonePixel) {
      expect(tonePixel[0]).toBeGreaterThan(0.33);
      expect(tonePixel[0]).toBeLessThan(0.58);
      expect(Math.abs(wrapPhase(tonePixel[1] - TONE_PHI))).toBeLessThan(0.2);
    }
    // Noise probe: a dest band whose covered fine bands are all filled at 0.5
    // sums in power: 0.5·sqrt(sum of w²) ≈ 1.25. It sits below the tone, in
    // the middle of the filled region.
    const noiseFromBottom = Math.round((toneFromBottom - 30) / (sourceSpec.bandsPerOctave / destSpec.bandsPerOctave));
    const noisePixel = readPixel(output, destSpec, frame, bandIndexFromTop(destSpec, noiseFromBottom));
    expect(noisePixel).not.toBeNull();
    if (noisePixel) {
      expect(noisePixel[0]).toBeGreaterThan(0.95);
      expect(noisePixel[0]).toBeLessThan(1.55);
    }
  });

  it("pastes identically-analysed files verbatim", async () => {
    // Same layout, same length, equal tempo: the paste is the identity, and
    // random magnitudes AND phases must come through untouched — this guards
    // the aligned-grid dead zone, which must classify float noise in the
    // freq-preserving map as "aligned" and leave the stored phase alone.
    const sampleRate = 4410;
    const layout = {
      numFrames: 1024,
      numBands: 36,
      sampleRate,
      minFreq: 20,
      bandsPerOctave: 36,
      pattern: "silence" as const,
    };
    const destSpec = createMockSpectrogramData(layout);
    const sourceSpec = createMockSpectrogramData(layout);

    for (let band = 0; band < sourceSpec.numBands; band++) {
      for (let frame = 0; frame < sourceSpec.numFrames; frame++) {
        const base = (band * sourceSpec.numFrames + frame) * 4;
        sourceSpec.packedData[base] = 0.1 + 0.9 * Math.random();
        sourceSpec.packedData[base + 1] = Math.random() * TWO_PI;
        sourceSpec.packedData[base + 2] = 0.1 + 0.9 * Math.random();
        sourceSpec.packedData[base + 3] = Math.random() * TWO_PI;
      }
    }

    const destRenderer = makeRenderer(destSpec, "ident-dest");
    const sourceRenderer = makeRenderer(sourceSpec, "ident-source");
    const sourceFile = makeSourceFile(sourceRenderer, sourceSpec, "ident-source", "/test/ident-source.wav");

    const state = pasteState({ "/test/ident-dest.wav": 120, "/test/ident-source.wav": 120 });
    destRenderer.renderStroke(pasteParams(destSpec.numFrames / destSpec.sampleRate), state, sourceFile);
    const output = await destRenderer.getFBOData();

    for (let band = 0; band < destSpec.numBands; band++) {
      for (let frame = 16; frame < destSpec.numFrames - 16; frame += 64) {
        const outPixel = readPixel(output, destSpec, frame, band);
        expect(outPixel).not.toBeNull();
        if (!outPixel) continue;
        const base = (band * sourceSpec.numFrames + frame) * 4;
        expect(Math.abs(outPixel[0] - sourceSpec.packedData[base])).toBeLessThan(1e-3);
        expect(Math.abs(wrapPhase(outPixel[1] - sourceSpec.packedData[base + 1]))).toBeLessThan(1e-3);
        expect(Math.abs(outPixel[2] - sourceSpec.packedData[base + 2])).toBeLessThan(1e-3);
        expect(Math.abs(wrapPhase(outPixel[3] - sourceSpec.packedData[base + 3]))).toBeLessThan(1e-3);
      }
    }
  });
});
