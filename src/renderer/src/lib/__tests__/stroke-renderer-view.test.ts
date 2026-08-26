import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Scene,
  Texture,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { blockGrid, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "../block-grid";
import { BlockSlotCache } from "../block-slot-cache";
import { canvasViewOf, composeViewContent, type CanvasView } from "../canvas-view";
import { levelDecimation } from "../display-pyramid";
import { DisplayTileRing } from "../display-tiles-textures";
import { gatherPixelRanges } from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

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

function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>, length: number): number {
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const SAMPLE_RATE = 8000;

describe("stroke parity between a whole-file canvas and a sub-view canvas", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let data: SpectrogramData & { packedData: Float32Array };
  let grid: BlockGrid;
  let view: CanvasView;
  let viewFrames: number;
  let viewSpec: SpectrogramData;
  let strokeTextures: StrokeTextures;
  const fileCursor = new Vector2(0.4, 0.35);
  let viewCursor: Vector2;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });

    data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
    // Every texel gets its own value, so a read from the wrong place shows.
    const packed = data.packedData;
    for (let i = 0; i < packed.length / 4; i++) {
      packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13));
      packed[i * 4 + 1] = Math.sin(i * 0.7) * 3;
      packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29));
      packed[i * 4 + 3] = Math.cos(i * 0.41) * 3;
    }

    grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, 0.25);
    expect(grid.blockCount).toBeGreaterThanOrEqual(8);
    view = canvasViewOf(grid, 2, 5);
    viewFrames = view.endFrame - view.startFrame;
    viewSpec = {
      ...data,
      numFrames: viewFrames,
      metadata: view.layout.metadata,
      textureWidth: view.textureWidth,
      textureHeight: view.textureHeight,
      packedTextureSize: new Vector2(view.textureWidth, view.textureHeight),
    };
    viewCursor = new Vector2((fileCursor.x * data.numFrames - view.startFrame) / viewFrames, fileCursor.y);

    const originalPackedDataTex = dataTexture(packed, data.textureWidth, data.textureHeight, RGBAFormat, "RGBA32F");
    const inverseMapTex = dataTexture(data.inverseMap!, data.textureWidth, data.textureHeight, RGFormat, "RG32F");
    const metadataTex = dataTexture(data.metadata, data.numBands, 1, RGBAFormat, "RGBA32F");
    const placeholderTexture = dataTexture(new Float32Array(4), 1, 1, RGBAFormat, "RGBA32F");
    disposers.push(() => {
      originalPackedDataTex.dispose();
      inverseMapTex.dispose();
      metadataTex.dispose();
      placeholderTexture.dispose();
    });
    strokeTextures = {
      originalPackedDataTex,
      inverseMapTex,
      metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
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

  function sourceFor(renderer: StrokeRenderer, spec: SpectrogramData): SourceFileInfo {
    const textures = renderer.getTextures();
    return {
      id: "parity",
      filePath: "/parity.wav",
      displayName: "parity.wav",
      spectrogramData: spec,
      textures,
    };
  }

  function subViewRenderer(): StrokeRenderer {
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "parity", effects, view);
    renderer.initialize();
    disposers.push(() => renderer.dispose());
    return renderer;
  }

  /** The RG pairs of a display texture, read back through a full-precision pass. */
  function readDisplayTexture(tex: Texture, width: number, height: number): Float32Array {
    const material = new RawShaderMaterial({
      uniforms: { srcTex: { value: tex } },
      vertexShader: /* glsl */ `
        in vec3 position;
        in vec2 uv;
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D srcTex;
        in vec2 vUv;
        layout(location = 0) out vec4 outColor;
        void main() {
          outColor = vec4(texture(srcTex, vUv).rg, 0.0, 1.0);
        }
      `,
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Float32Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    target.dispose();
    material.dispose();
    return pixels;
  }

  it("commits the same coefficients through a sub-view as through the whole file", async () => {
    const state = createMockState();

    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());

    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    whole.beginStroke();
    whole.renderStroke(strokeParams(fileCursor, data.numFrames / SAMPLE_RATE), state, sourceFor(whole, data));
    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, viewSpec));

    const wholeData = await whole.getFBOData();
    const subData = await sub.getFBOData();

    // The stroke must have painted, and only inside the view's file span.
    let changed = 0;
    for (let i = 0; i < data.packedData.length; i++) if (wholeData[i] !== data.packedData[i]) changed++;
    expect(changed).toBeGreaterThan(0);
    const inView = composeViewContent(view, wholeData);
    const outside = Float32Array.from(wholeData);
    for (let band = 0; band < view.layout.numBands; band++) {
      const fileStart = view.ranges[band * 2];
      const count = view.ranges[band * 2 + 1];
      outside.set(data.packedData.subarray(fileStart * 4, (fileStart + count) * 4), fileStart * 4);
    }
    let leaked = 0;
    for (let i = 0; i < outside.length; i++) if (outside[i] !== data.packedData[i]) leaked++;
    expect(leaked).toBe(0);

    // The sub-view stroke lands on the same coefficients. The two paths
    // compute the same positions from different texture bases, so values
    // agree to float rounding rather than bit-for-bit: magnitudes vary
    // smoothly and stay tight, while interpolated reads across the seeded
    // random phase jumps amplify a last-bit position difference.
    let maxMagnitude = 0;
    let maxPhase = 0;
    for (let i = 0; i < view.texels * 4; i++) {
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) maxMagnitude = Math.max(maxMagnitude, diff);
      else maxPhase = Math.max(maxPhase, diff);
    }
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-5);
    expect(maxPhase, `largest phase difference ${maxPhase}`).toBeLessThan(1e-3);
  });

  it("paints over a canvas composed from block slots and folds the blocks back", async () => {
    const state = createMockState();
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL);
    disposers.push(() => cache.dispose());
    const viewBlocks: number[] = [];
    for (let block = view.firstBlock; block <= view.lastBlock; block++) viewBlocks.push(block);
    for (const block of viewBlocks) {
      const list = blockPixelRanges(grid, block);
      cache.upload(block, gatherPixelRanges(data.packedData, list.ranges.subarray(0, list.count * 2)));
    }

    const sub = subViewRenderer();
    cache.compose(view, viewBlocks, sub.getTextures().packed);
    const seeded = await sub.getFBOData();
    expect(firstDifference(seeded, composeViewContent(view, data.packedData), view.texels * 4)).toBe(-1);

    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, viewSpec));
    const painted = await sub.getFBOData();
    expect(firstDifference(painted, seeded, view.texels * 4)).not.toBe(-1);

    cache.copyBack(view, viewBlocks, sub.getTextures().packed.texture);
    const target = new WebGLRenderTarget(view.textureWidth, view.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    disposers.push(() => target.dispose());
    cache.compose(view, viewBlocks, target);
    const roundTripped = new Float32Array(target.width * target.height * 4);
    gl.readRenderTargetPixels(target, 0, 0, target.width, target.height, roundTripped);
    expect(firstDifference(roundTripped, painted, view.texels * 4)).toBe(-1);
  });

  it("cuts the same display pyramid bins and ring tiles through a sub-view", () => {
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    // Pyramid level 0: every bin whose tap lies inside the view matches.
    const level = whole.getDisplayPyramid()!.levels[0];
    const wholeLevel = readDisplayTexture(
      whole.getDisplayPyramid()!.texture(0)!,
      level.textureWidth,
      level.textureHeight,
    );
    const subLevel = readDisplayTexture(sub.getDisplayPyramid()!.texture(0)!, level.textureWidth, level.textureHeight);
    let compared = 0;
    let nonzero = 0;
    let mismatchAt = -1;
    for (let band = 0; band < view.layout.numBands && mismatchAt === -1; band++) {
      const decimation = levelDecimation(level, data.metadata[band * 4 + 2], band);
      const first = view.bandK0[band];
      const start = Math.ceil(first / decimation);
      const end = Math.ceil((first + view.layout.metadata[band * 4 + 1]) / decimation);
      for (let bin = start; bin < end; bin++) {
        const at = (level.metadata[band * 4] + bin) * 4;
        if (subLevel[at] !== wholeLevel[at] || subLevel[at + 1] !== wholeLevel[at + 1]) {
          mismatchAt = at;
          break;
        }
        compared++;
        if (wholeLevel[at] !== 0) nonzero++;
      }
    }
    expect(mismatchAt, `first pyramid difference at float ${mismatchAt}`).toBe(-1);
    expect(compared).toBeGreaterThan(1000);
    expect(nonzero).toBeGreaterThan(0);

    // The tile ring cut over the view span: identical tiles from both sources.
    const fileLayout = { numBands: data.numBands, metadata: data.metadata };
    const ringTexels = 1 << 16;
    const wholeRing = new DisplayTileRing(fileLayout, data.numFrames, { maxTexels: ringTexels });
    const subRing = new DisplayTileRing(fileLayout, data.numFrames, { maxTexels: ringTexels });
    disposers.push(() => {
      wholeRing.dispose();
      subRing.dispose();
    });
    const mid = Math.round((view.startFrame + view.endFrame) / 2);
    const ringView = { framesPerPixel: 1, startFrame: mid - 128, endFrame: mid + 128, viewportPixels: 256 };
    wholeRing.update(gl, whole.committedSource(), ringView, 30);
    subRing.update(gl, sub.committedSource(), ringView, 30);
    const bound = wholeRing.uniforms();
    expect(bound.tileCount).toBeGreaterThan(0);
    expect(subRing.uniforms()).toEqual(bound);
    const width = Math.min(8192, ringTexels);
    const height = Math.ceil(ringTexels / width);
    const wholePixels = readDisplayTexture(wholeRing.texture()!, width, height);
    const subPixels = readDisplayTexture(subRing.texture()!, width, height);
    expect(firstDifference(subPixels, wholePixels, wholePixels.length)).toBe(-1);
    expect(wholePixels.some((value) => value !== 0)).toBe(true);
  });

  it("refuses to cut ring tiles the source view does not cover", () => {
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));
    const ring = new DisplayTileRing({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, {
      maxTexels: 1 << 16,
    });
    disposers.push(() => ring.dispose());
    expect(() =>
      ring.update(
        gl,
        sub.committedSource(),
        { framesPerPixel: 1, startFrame: 0, endFrame: 256, viewportPixels: 256 },
        30,
      ),
    ).toThrow("does not cover");
  });
});
