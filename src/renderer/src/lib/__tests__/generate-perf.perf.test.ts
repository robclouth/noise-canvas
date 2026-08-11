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
import { describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { EffectType } from "../../effects/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

// Times a Generate pass the way the panel runs one: every hap is its own
// renderStroke into the same FBO, so a pass costs stamps x stroke. Files get
// longer and patterns keep their density, so both factors grow together.

const BPM = 120;

function createTextures(data: SpectrogramData) {
  const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = data;

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

function placeholder(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

function scaleLut(): DataTexture {
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
  const [pt, sy] = await Promise.all([
    import("../../effects/passthrough-effect"),
    import("../../effects/synthesize-effect"),
  ]);
  return { passthrough: pt.passThroughEffect, synthesize: sy.synthesizeEffect } as EffectsRegistry;
}

type Harness = {
  data: SpectrogramData;
  renderer: StrokeRenderer;
  sourceFile: SourceFileInfo;
  dispose: () => void;
};

function buildHarness(gl: WebGLRenderer, effects: EffectsRegistry, data: SpectrogramData): Harness {
  const tex = createTextures(data);
  const ph = placeholder();
  const lut = scaleLut();
  const strokeTextures: StrokeTextures = {
    packedDataTex: tex.packedDataTex,
    originalPackedDataTex: tex.originalPackedDataTex,
    inverseMapTex: tex.inverseMapTex,
    metadataTex: tex.metadataTex,
    placeholderTexture: ph,
    modulatorScaleLut: lut,
    modulator1Texture: ph,
    modulator2Texture: ph,
    modulator3Texture: ph,
  };
  const renderer = new StrokeRenderer(gl, data, strokeTextures, "gen-perf", effects);
  renderer.initialize();
  const st = renderer.getTextures();
  const sourceFile: SourceFileInfo = {
    id: "gen-perf",
    filePath: "/test/gen.wav",
    displayName: "gen.wav",
    spectrogramData: data,
    textures: { packed: st.packed, inverse: st.inverse, metadata: st.metadata, original: st.original },
  };
  return {
    data,
    renderer,
    sourceFile,
    dispose: () => {
      renderer.dispose();
      tex.packedDataTex.dispose();
      tex.originalPackedDataTex.dispose();
      tex.inverseMapTex.dispose();
      tex.metadataTex.dispose();
      ph.dispose();
      lut.dispose();
    },
  };
}

function buildState(effect: EffectType, sizeTime: number, sizePitch: number): State {
  const effects = [{ id: `gen-${effect}`, effect, enabled: true, params: {} }];
  const state = createMockState({ effects, filepathsBpm: { "/test/gen.wav": BPM } });
  const step = state.brushes[state.activeBrushIndex]?.steps?.[0] as Record<string, unknown> | undefined;
  if (step) {
    step.effects = effects;
    step.brushSizeTime = sizeTime;
    step.brushSizePitch = sizePitch;
  }
  return state;
}

function paramsAt(cursor: Vector2, totalDuration: number): StrokeParams {
  return {
    cursorPos: cursor,
    preview: false,
    bpm: BPM,
    totalDuration,
    viewZoomPower: 0,
    viewOffset: 0,
    viewZoomPowerY: 0,
    viewOffsetY: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
  };
}

const RUN_PROFILE = Boolean(import.meta.env.VITE_PAINT_PROFILE);

// Mock durations chosen for the packed-texture heights they produce, since that
// is what a stroke costs. The real analyzer at the default resolution packs a
// 5 s file into 4096x243 and a 60 s file into 4096x2905, with 85 s the ceiling.
const GEOMETRIES = [2, 4, 8, 16, 24, 31];

describe.skipIf(!RUN_PROFILE)("generate pass profile", () => {
  it("times a whole-file pass against packed size and stamp count", async () => {
    const effects = await loadEffects();
    const gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    const glRenderer = gl.getContext().getParameter(gl.getContext().RENDERER);
    const counts = [30, 120, 480];

    let out = `\n=== Generate pass: one renderStroke per stamp [GL: ${glRenderer}] ===\n`;
    out += `${"texH".padStart(6)} ${counts.map((n) => `${n} stamps`.padStart(12)).join(" ")} ${"per stamp".padStart(11)}\n`;

    for (const durationSeconds of GEOMETRIES) {
      const data = createConstantQMockSpectrogramData({ durationSeconds, bandsPerOctave: 6 });
      const h = buildHarness(gl, effects, data);
      // A sixteenth-note stamp filling a quarter of the spectrum, as zone() gives.
      const state = buildState("passthrough", 0.25, Math.round(((data.numBands / 6) * 12) / 4));

      const cells: string[] = [];
      let perStamp = 0;
      for (const count of counts) {
        const cursors = Array.from({ length: count }, (_, i) => new Vector2((i + 0.5) / count, (i % 4) / 4));
        for (let i = 0; i < 3; i++) h.renderer.renderStroke(paramsAt(cursors[0], durationSeconds), state, h.sourceFile);
        h.renderer.finishGpu();

        const samples: number[] = [];
        for (let run = 0; run < 3; run++) {
          const t0 = performance.now();
          for (const cursor of cursors) {
            h.renderer.renderStroke(paramsAt(cursor, durationSeconds), state, h.sourceFile);
          }
          h.renderer.finishGpu();
          samples.push(performance.now() - t0);
        }
        const ms = samples.sort((a, b) => a - b)[1];
        cells.push(ms.toFixed(0).padStart(12));
        perStamp = ms / count;
      }

      out += `${String(data.textureHeight).padStart(6)} ${cells.join(" ")} ${perStamp.toFixed(2).padStart(11)}\n`;
      h.dispose();
    }

    console.log(out);
    gl.dispose();
    expect(GEOMETRIES.length).toBe(6);
  }, 900000);
});
