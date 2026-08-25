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

import { BRUSH_ANCHOR_MODE_CENTER } from "../constants";
import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

function createTexturesFromSpectrogramData(spectrogramData: SpectrogramData) {
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

  return { originalPackedDataTex, inverseMapTex, metadataTex };
}

function createPlaceholderTexture(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
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
  const [{ passThroughEffect }, { dynamicsEffect }, { blurEffect }] = await Promise.all([
    import("../../effects/passthrough-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/blur-effect"),
  ]);
  return { passthrough: passThroughEffect, dynamics: dynamicsEffect, blur: blurEffect };
}

/** Magnitude (L channel) per time frame, averaged over bands. */
function magByFrame(data: Float32Array, numFrames: number, numBands: number): number[] {
  const out: number[] = [];
  for (let frame = 0; frame < numFrames; frame++) {
    let sum = 0;
    for (let band = 0; band < numBands; band++) sum += data[(band * numFrames + frame) * 4];
    out.push(sum / numBands);
  }
  return out;
}

describe("per-step source independence", () => {
  let gl: WebGLRenderer;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;
  const disposables: StrokeRenderer[] = [];

  const numBands = 8;
  const destFrames = 16;
  const bpm = 60;
  const destPath = "/test/step-dest.wav";
  const srcPath = "/test/step-src.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    placeholderTexture = createPlaceholderTexture();
    modulatorScaleLut = createModulatorScaleLut();
  });

  afterEach(() => {
    for (const renderer of disposables.splice(0)) renderer.dispose();
    gl.dispose();
    placeholderTexture.dispose();
    modulatorScaleLut.dispose();
  });

  /** A spectrogram whose magnitude is the same everywhere. */
  function flat(numFrames: number, magnitude: number): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate: numFrames, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        spec.packedData[idx] = magnitude;
        spec.packedData[idx + 2] = magnitude;
      }
    }
    return spec;
  }

  /** A spectrogram whose magnitude ramps across time, equal for every band. */
  function timeRamp(numFrames: number): SpectrogramData {
    const spec = createMockSpectrogramData({ numFrames, numBands, sampleRate: numFrames, pattern: "silence" });
    for (let band = 0; band < numBands; band++) {
      for (let frame = 0; frame < numFrames; frame++) {
        const idx = (band * numFrames + frame) * 4;
        const mag = frame / numFrames;
        spec.packedData[idx] = mag;
        spec.packedData[idx + 2] = mag;
      }
    }
    return spec;
  }

  function makeRenderer(spec: SpectrogramData, id: string): StrokeRenderer {
    const raw = createTexturesFromSpectrogramData(spec);
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

  function sourceFileFor(
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
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };
  }

  /** A brush whose steps take the given per-step overrides, in order. */
  function stateWithSteps(steps: Record<string, unknown>[], activeStepIndex: number): State {
    const shared = {
      sourcePositionMode: "follow",
      sourceDataMode: "current",
      brushIntensity: 100,
      brushIterations: 1,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizeTime: 1,
      brushSizePitch: 128,
      brushAnchorMode: 0,
      brushWrapMode: 0,
      accumulate: true,
      blendMode: 0,
      algorithm: 0,
      effects: [],
      filepathsBpm: { [destPath]: bpm, [srcPath]: bpm },
    };
    const state = createMockState({ ...shared, activeStepIndex });
    const template = state.brushes[0].steps[0] as unknown as Record<string, unknown>;
    state.brushes[0].steps = steps.map((overrides, index) => ({
      ...template,
      id: `step-${index}`,
      name: `Step ${index + 1}`,
      ...shared,
      ...overrides,
    })) as unknown as (typeof state.brushes)[0]["steps"];
    return state;
  }

  function params(aimX: number): StrokeParams {
    return {
      cursorPos: new Vector2(aimX, 0),
      preview: false,
      bpm,
      totalDuration: 1,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };
  }

  it("samples the file each step names, whichever step is selected", async () => {
    // Step 1 paints the source file over what step 0 leaves behind. Selecting a
    // step is a UI act, so it must not change a single painted pixel.
    const painted: number[][] = [];
    for (const activeStepIndex of [0, 1]) {
      const destSpec = flat(destFrames, 0);
      const destRenderer = makeRenderer(destSpec, `dest-${activeStepIndex}`);
      const srcSpec = flat(destFrames, 0.5);
      const srcRenderer = makeRenderer(srcSpec, `src-${activeStepIndex}`);
      const srcFile = sourceFileFor(srcRenderer, srcSpec, `src-${activeStepIndex}`, srcPath);
      const selfFile = sourceFileFor(destRenderer, destSpec, `dest-${activeStepIndex}`, destPath);

      destRenderer.renderStroke(
        { ...params(0), stepSources: [undefined, srcFile] },
        stateWithSteps([{ sourceFile: null }, { sourceFile: { path: srcPath } }], activeStepIndex),
        selfFile,
      );
      painted.push(magByFrame(await destRenderer.getFBOData(), destFrames, numBands));
    }

    // The named source reached the canvas, and both selections painted it alike.
    expect(painted[0][8]).toBeGreaterThan(0.4);
    for (let frame = 0; frame < destFrames; frame++) {
      expect(Math.abs(painted[0][frame] - painted[1][frame])).toBeLessThan(1e-5);
    }
  });

  it("reads what the step before it produced when it names no source", async () => {
    // A second step with no Source of its own must pass the running result
    // through untouched, in this file's own layout rather than the source's.
    const srcFrames = destFrames * 2;

    const chained = (() => {
      const destSpec = flat(destFrames, 0);
      const destRenderer = makeRenderer(destSpec, "dest-chained");
      const srcSpec = timeRamp(srcFrames);
      const srcRenderer = makeRenderer(srcSpec, "src-chained");
      const srcFile = sourceFileFor(srcRenderer, srcSpec, "src-chained", srcPath);
      destRenderer.renderStroke(
        { ...params(0), stepSources: [srcFile, undefined] },
        stateWithSteps([{ sourceFile: { path: srcPath } }, { sourceFile: null }], 0),
        sourceFileFor(destRenderer, destSpec, "dest-chained", destPath),
      );
      return destRenderer;
    })();

    const single = (() => {
      const destSpec = flat(destFrames, 0);
      const destRenderer = makeRenderer(destSpec, "dest-single");
      const srcSpec = timeRamp(srcFrames);
      const srcRenderer = makeRenderer(srcSpec, "src-single");
      const srcFile = sourceFileFor(srcRenderer, srcSpec, "src-single", srcPath);
      destRenderer.renderStroke(
        { ...params(0), stepSources: [srcFile] },
        stateWithSteps([{ sourceFile: { path: srcPath } }], 0),
        sourceFileFor(destRenderer, destSpec, "dest-single", destPath),
      );
      return destRenderer;
    })();

    const withPassthrough = magByFrame(await chained.getFBOData(), destFrames, numBands);
    const withoutPassthrough = magByFrame(await single.getFBOData(), destFrames, numBands);
    for (let frame = 0; frame < destFrames; frame++) {
      expect(Math.abs(withPassthrough[frame] - withoutPassthrough[frame])).toBeLessThan(1e-5);
    }
  });

  it("blurs the canvas, then multiplies a source over it, whichever step is selected", async () => {
    // Blur the target in one step, then cross-synthesise a second file over the
    // result in the next: the shape that first showed the preview moving with
    // the selection.
    const painted: number[][] = [];
    for (const activeStepIndex of [0, 1]) {
      const destSpec = flat(destFrames, 0.5);
      const destRenderer = makeRenderer(destSpec, `dest-real-${activeStepIndex}`);
      const srcSpec = flat(destFrames, 0.5);
      const srcRenderer = makeRenderer(srcSpec, `src-real-${activeStepIndex}`);
      const srcFile = sourceFileFor(srcRenderer, srcSpec, `src-real-${activeStepIndex}`, srcPath);

      destRenderer.renderStroke(
        { ...params(0), stepSources: [undefined, srcFile] },
        stateWithSteps(
          [
            {
              sourceFile: null,
              effects: [
                {
                  id: "blur",
                  effect: "blur",
                  enabled: true,
                  params: { blurAmountTime: 100, blurAmountPitch: 0, blurSamplesX: 16, blurSamplesY: 16 },
                },
              ],
            },
            {
              sourceFile: { path: srcPath },
              blendMode: 3,
              effects: [{ id: "gain", effect: "dynamics", enabled: true, params: { dynamicsGainDb: 0 } }],
            },
          ],
          activeStepIndex,
        ),
        sourceFileFor(destRenderer, destSpec, `dest-real-${activeStepIndex}`, destPath),
      );
      painted.push(magByFrame(await destRenderer.getFBOData(), destFrames, numBands));
    }

    // Multiplying two halves leaves a quarter, and the selection changes nothing.
    expect(painted[0][8]).toBeGreaterThan(0.15);
    expect(painted[0][8]).toBeLessThan(0.35);
    for (let frame = 0; frame < destFrames; frame++) {
      expect(Math.abs(painted[0][frame] - painted[1][frame])).toBeLessThan(1e-5);
    }
  });

  it("anchors each step's brush on its own size, whichever step is selected", async () => {
    // Two centre-anchored steps of different lengths both centre on the aim, so
    // the painted extent cannot move with the selection.
    const aimX = 0.5;
    const extents: number[][] = [];
    for (const activeStepIndex of [0, 1]) {
      const destSpec = flat(destFrames, 0);
      const destRenderer = makeRenderer(destSpec, `dest-anchor-${activeStepIndex}`);
      const srcSpec = flat(destFrames, 0.5);
      const srcRenderer = makeRenderer(srcSpec, `src-anchor-${activeStepIndex}`);
      const srcFile = sourceFileFor(srcRenderer, srcSpec, `src-anchor-${activeStepIndex}`, srcPath);

      destRenderer.renderStroke(
        { ...params(aimX), stepSources: [srcFile, srcFile] },
        stateWithSteps(
          [
            { sourceFile: { path: srcPath }, brushSizeTime: 0.25, brushAnchorMode: BRUSH_ANCHOR_MODE_CENTER },
            { sourceFile: { path: srcPath }, brushSizeTime: 0.5, brushAnchorMode: BRUSH_ANCHOR_MODE_CENTER },
          ],
          activeStepIndex,
        ),
        sourceFileFor(destRenderer, destSpec, `dest-anchor-${activeStepIndex}`, destPath),
      );
      extents.push(magByFrame(await destRenderer.getFBOData(), destFrames, numBands));
    }

    // The longer step spans half the file centred on the aim: frames 4..11.
    expect(extents[0][8]).toBeGreaterThan(0.1);
    expect(extents[0][1]).toBeLessThan(1e-5);
    expect(extents[0][14]).toBeLessThan(1e-5);
    for (let frame = 0; frame < destFrames; frame++) {
      expect(Math.abs(extents[0][frame] - extents[1][frame])).toBeLessThan(1e-5);
    }
  });
});
