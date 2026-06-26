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

  return { packedDataTex, originalPackedDataTex, inverseMapTex, metadataTex };
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

// Magnitude (L channel) per time frame, averaged over bands so a per-band-constant
// ramp collapses to one number per frame.
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

describe("transform reverse scale", () => {
  let gl: WebGLRenderer;
  let placeholderTexture: DataTexture;
  let modulatorScaleLut: DataTexture;
  let effects: EffectsRegistry;

  const destFrames = 16;
  const numBands = 8;
  const sampleRate = 16; // 1 second files so beats map sanely at bpm=60
  const bpm = 60;
  const destPath = "/test/reverse-dest.wav";
  const srcPath = "/test/reverse-src.wav";

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    placeholderTexture = createPlaceholderTexture();
    modulatorScaleLut = createModulatorScaleLut();
  });

  afterEach(() => {
    gl.dispose();
    placeholderTexture.dispose();
    modulatorScaleLut.dispose();
  });

  // A spectrogram whose magnitude ramps across time (mag = frame/numFrames, equal
  // for every band) — lets us see exactly how the time axis is remapped.
  function timeRamp(numFrames: number, durationSeconds: number): SpectrogramData {
    const spec = createMockSpectrogramData({
      numFrames,
      numBands,
      sampleRate: numFrames / durationSeconds,
      pattern: "silence",
    });
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

  function makeRenderer(spec: SpectrogramData, id: string) {
    const raw = createTexturesFromSpectrogramData(spec);
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

  function reverseState(positionMode: string, scaleTime: number, bpmMap: Record<string, number>): State {
    const overrides = {
      sourcePositionMode: positionMode,
      sourceDataMode: "current",
      transformScaleTime: scaleTime,
      transformScalePitch: 1,
      transformShiftBeats: 0,
      transformShiftSemis: 0,
      transformRotation: 0,
      transformEdgeMode: 1, // Bleed: sample outside the brush instead of zeroing it
      filepathsBpm: bpmMap,
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushSizeTime: 0.5, // 0.5 beats -> 0.5 UV (bpm 60, 1 s file)
      brushSizePitch: 128, // full pitch
      accumulate: true,
      blendMode: 0,
      algorithm: 0,
    };
    const state = createMockState(overrides);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, overrides);
    return state;
  }

  function params(blX: number): StrokeParams {
    return {
      cursorPos: new Vector2(blX, 0),
      preview: false,
      bpm,
      totalDuration: destFrames / sampleRate,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };
  }

  // Reverse must equal forward mirrored about the brush centre. The brush covers
  // UV x in [0.25, 0.75] = frames 4..11, so frame f mirrors to (15 - f). This
  // invariant is independent of the source mapping, so it must hold in every
  // tracking mode and across files.
  async function assertReverseIsMirroredForward(
    positionMode: string,
    sourceFrames: number,
    bpmMap: Record<string, number>,
  ) {
    const destSpec = timeRamp(destFrames, 1);
    const destRenderer = makeRenderer(destSpec, "dest");

    const sameFile = sourceFrames === destFrames && bpmMap[srcPath] === undefined;
    let sourceFile: SourceFileInfo;
    let srcRenderer: StrokeRenderer | null = null;
    if (sameFile) {
      sourceFile = sourceFileFor(destRenderer, destSpec, "dest", destPath);
    } else {
      const srcSpec = timeRamp(sourceFrames, 1);
      srcRenderer = makeRenderer(srcSpec, "src");
      sourceFile = sourceFileFor(srcRenderer, srcSpec, "src", srcPath);
    }

    destRenderer.renderStroke(params(0.25), reverseState(positionMode, 1, bpmMap), sourceFile);
    const forward = magByFrame(await destRenderer.getFBOData(), destFrames, numBands);

    // Fresh dest so the reverse stroke paints onto the untouched ramp.
    destRenderer.dispose();
    const destRenderer2 = makeRenderer(destSpec, "dest2");
    const sourceFile2 = sameFile ? sourceFileFor(destRenderer2, destSpec, "dest2", destPath) : sourceFile;
    destRenderer2.renderStroke(params(0.25), reverseState(positionMode, -1, bpmMap), sourceFile2);
    const reverse = magByFrame(await destRenderer2.getFBOData(), destFrames, numBands);

    // One frame of slack (1/16 = 0.0625) for the half-texel rounding in the
    // point-sampled time read; the shape must still be the mirror of forward.
    for (let f = 5; f <= 11; f++) {
      expect(Math.abs(reverse[f] - forward[15 - f])).toBeLessThan(0.08);
    }

    destRenderer2.dispose();
    srcRenderer?.dispose();
  }

  it("FOLLOW same-file: reverse mirrors forward under the brush", async () => {
    await assertReverseIsMirroredForward("follow", destFrames, { [destPath]: bpm });
  });

  it("FIXED same-file: reverse mirrors forward under the brush", async () => {
    await assertReverseIsMirroredForward("fixed", destFrames, { [destPath]: bpm });
  });

  it("FOLLOW cross-file (2x longer source): reverse mirrors forward under the brush", async () => {
    await assertReverseIsMirroredForward("follow", destFrames * 2, { [destPath]: bpm, [srcPath]: bpm });
  });
});
