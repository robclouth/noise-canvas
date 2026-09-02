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

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { blockGrid, type BlockGrid } from "../block-grid";
import { canvasViewOf, composeViewContent, type CanvasView } from "../canvas-view";
import { gatherPixelRanges } from "../pixel-ranges";
import { SourceWindow, sourceReadSpan } from "../source-window";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";

const SAMPLE_RATE = 8000;
// The window is built on the shipped block grid, so the file has to be long
// enough for that grid to cut it into more blocks than a window holds.
const DURATION_SECONDS = 16;
const WINDOW_BLOCKS = 3;

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { transform: transformEffect, passthrough: passThroughEffect };
}

function dataTexture(
  data: Float32Array,
  width: number,
  height: number,
  format: typeof RGBAFormat | typeof RGFormat,
  internalFormat: "RGBA32F" | "RG32F",
): DataTexture {
  const texture = new DataTexture(data, width, height, format, FloatType);
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A mock file whose every texel differs, so a read from the wrong place shows. */
function mockFile(seed: number): SpectrogramData & { packedData: Float32Array } {
  const file = createConstantQMockSpectrogramData({
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    bandsPerOctave: 4,
  });
  const packed = file.packedData;
  for (let i = 0; i < packed.length / 4; i++) {
    packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13 + seed));
    packed[i * 4 + 1] = Math.sin(i * 0.7 + seed) * 3;
    packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29 + seed));
    packed[i * 4 + 3] = Math.cos(i * 0.41 + seed) * 3;
  }
  return file;
}

describe("sourceReadSpan", () => {
  it("widens the read either side, because effects read around the dab", () => {
    expect(sourceReadSpan({ start: 400, end: 500 }, 1000)).toEqual({ startFrame: 300, endFrame: 600 });
  });

  it("keeps the span inside the file", () => {
    expect(sourceReadSpan({ start: 50, end: 150 }, 1000)).toEqual({ startFrame: 0, endFrame: 250 });
    expect(sourceReadSpan({ start: 950, end: 1050 }, 1000)).toEqual({ startFrame: 850, endFrame: 1000 });
  });

  it("wraps a read past the file into it, the way the shaders wrap a source UV", () => {
    expect(sourceReadSpan({ start: 1400, end: 1500 }, 1000)).toEqual({ startFrame: 300, endFrame: 600 });
    expect(sourceReadSpan({ start: -600, end: -500 }, 1000)).toEqual({ startFrame: 300, endFrame: 600 });
  });
});

describe("SourceWindow", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let dest: SpectrogramData & { packedData: Float32Array };
  let source: SpectrogramData & { packedData: Float32Array };
  let destGrid: BlockGrid;
  let sourceGrid: BlockGrid;
  let destView: CanvasView;
  let destTextures: StrokeTextures;
  let sourceTextures: StrokeTextures;
  const disposers: Array<() => void> = [];

  function texturesFor(file: SpectrogramData & { packedData: Float32Array }): StrokeTextures {
    const fold = packedFold(file.texels);
    const originalPackedDataTex = dataTexture(
      padToFold(file.packedData, file.texels, 4),
      fold.width,
      fold.height,
      RGBAFormat,
      "RGBA32F",
    );
    const inverseMapTex = dataTexture(
      padToFold(file.inverseMap!, file.texels, 2),
      fold.width,
      fold.height,
      RGFormat,
      "RG32F",
    );
    const metadataTex = dataTexture(metadataTextureRows(file), file.numBands, 1, RGBAFormat, "RGBA32F");
    const placeholderTexture = dataTexture(new Float32Array(4), 1, 1, RGBAFormat, "RGBA32F");
    disposers.push(() => {
      originalPackedDataTex.dispose();
      inverseMapTex.dispose();
      metadataTex.dispose();
      placeholderTexture.dispose();
    });
    return {
      originalPackedDataTex,
      inverseMapTex,
      metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
  }

  /** A window over the source file, reading from its packed array. */
  function sourceWindow(): SourceWindow {
    const window = new SourceWindow(
      gl,
      "source",
      {
        spectrogram: source,
        readCurrent: async (ranges) => gatherPixelRanges(source.packedData, ranges),
        readRoot: async (ranges) => gatherPixelRanges(source.packedData, ranges),
        revision: () => 0,
      },
      WINDOW_BLOCKS,
    );
    disposers.push(() => window.dispose());
    return window;
  }

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });
    dest = mockFile(0);
    source = mockFile(1.7);
    destGrid = blockGrid({ numBands: dest.numBands, metadata: dest.metadata }, dest.numFrames, SAMPLE_RATE);
    sourceGrid = blockGrid({ numBands: source.numBands, metadata: source.metadata }, source.numFrames, SAMPLE_RATE);
    expect(sourceGrid.blockCount).toBeGreaterThan(WINDOW_BLOCKS);
    destView = canvasViewOf(destGrid, 2, 5);
    destTextures = texturesFor(dest);
    sourceTextures = texturesFor(source);
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    gl.dispose();
  });

  function strokeParams(cursor: Vector2, totalDuration: number): StrokeParams {
    return {
      cursorPos: cursor,
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

  it("holds only the frames it was aimed at", async () => {
    const window = sourceWindow();
    const blockFrames = sourceGrid.blockFrames;
    expect(window.holdsFrames(0, blockFrames, false)).toBe(false);
    window.aim(0, blockFrames, false);
    await window.settled();
    expect(window.holdsFrames(0, blockFrames, false)).toBe(true);
    const far = (sourceGrid.blockCount - 1) * blockFrames;
    expect(window.holdsFrames(far, far + blockFrames, false)).toBe(false);
  });

  it("composes the source file's own pixels", async () => {
    const window = sourceWindow();
    window.aim(0, sourceGrid.blockFrames, false);
    await window.settled();
    const textures = window.textures();
    expect(textures).not.toBeNull();
    const view = textures!.view;
    const composed = new Float32Array(view.textureWidth * view.textureHeight * 4);
    gl.readRenderTargetPixels(textures!.packed, 0, 0, view.textureWidth, view.textureHeight, composed);
    const expected = composeViewContent(view, source.packedData);
    let firstDifference = -1;
    for (let i = 0; i < view.texels * 4 && firstDifference < 0; i++) {
      if (composed[i] !== expected[i]) firstDifference = i;
    }
    expect(firstDifference, `first differing value at ${firstDifference}`).toBe(-1);
  });

  it("builds the original only once a step asks to read it", async () => {
    const window = sourceWindow();
    window.aim(0, sourceGrid.blockFrames, false);
    await window.settled();
    expect(window.textures()?.original).toBeUndefined();
    expect(window.holdsFrames(0, sourceGrid.blockFrames, true)).toBe(false);

    window.aim(0, sourceGrid.blockFrames, true);
    await window.settled();
    expect(window.textures()?.original).toBeDefined();
    expect(window.holdsFrames(0, sourceGrid.blockFrames, true)).toBe(true);
  });

  it("reads through the window what the whole source reads", async () => {
    const cursor = new Vector2(0.4, 0.35);
    const destFrames = destView.endFrame - destView.startFrame;
    const viewCursor = new Vector2((cursor.x * dest.numFrames - destView.startFrame) / destFrames, cursor.y);
    const state = createMockStateWithSteps([
      {
        name: "Cross",
        overrides: {
          sourcePositionMode: "follow",
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);
    // A tempo of its own, so the read is not at the same frame in both files.
    state.filepathsBpm = { "/source.wav": 90 };

    const wholeSource = new StrokeRenderer(gl, source, sourceTextures, "source", effects);
    wholeSource.initialize();
    wholeSource.setFBOData(source.packedData);
    disposers.push(() => wholeSource.dispose());

    const whole = new StrokeRenderer(gl, dest, destTextures, "dest", effects);
    whole.initialize();
    whole.setFBOData(dest.packedData);
    disposers.push(() => whole.dispose());
    whole.beginStroke();
    whole.renderStroke(strokeParams(cursor, dest.numFrames / SAMPLE_RATE), state, {
      id: "source",
      filePath: "/source.wav",
      displayName: "source.wav",
      spectrogramData: source,
      textures: wholeSource.getTextures(),
    });

    const sub = new StrokeRenderer(gl, dest, destTextures, "dest", effects, destView);
    sub.initialize();
    sub.setFBOData(composeViewContent(destView, dest.packedData));
    disposers.push(() => sub.dispose());

    // The window is placed by the frames the renderer says the dab reads.
    const window = sourceWindow();
    const read = sub.sourceReadFrames(state, viewCursor, 120, destFrames / SAMPLE_RATE, {
      filePath: "/source.wav",
      spectrogramData: source,
    });
    const span = Math.max(1, read.end - read.start);
    window.aim(read.start - span, read.end + span, false);
    await window.settled();
    const textures = window.textures();
    expect(textures).not.toBeNull();
    expect(textures!.view.endFrame - textures!.view.startFrame).toBeLessThan(source.numFrames);

    const sourceInfo: SourceFileInfo = {
      id: "source",
      filePath: "/source.wav",
      displayName: "source.wav",
      spectrogramData: source,
      textures: textures!,
      view: textures!.view,
    };
    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, destFrames / SAMPLE_RATE), state, sourceInfo);

    const inView = composeViewContent(destView, await whole.getFBOData());
    const subData = await sub.getFBOData();
    const before = composeViewContent(destView, dest.packedData);
    let magnitude = 0;
    let phase = 0;
    let changed = 0;
    for (let i = 0; i < destView.texels * 4; i++) {
      if (inView[i] !== before[i]) changed++;
      const difference = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, difference);
      else phase = Math.max(phase, difference);
    }
    expect(changed).toBeGreaterThan(0);
    // The two paths reach the same source position by different routes, and
    // this file is long enough that the last bits of a position carry further
    // than they do in the shorter parity files. A window in the wrong place
    // differs by radians, not thousandths.
    expect(magnitude, `largest magnitude difference ${magnitude}`).toBeLessThan(1e-3);
    expect(phase, `largest phase difference ${phase}`).toBeLessThan(3e-3);
  });
});
