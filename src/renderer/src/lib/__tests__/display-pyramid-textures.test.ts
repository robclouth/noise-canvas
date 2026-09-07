import {
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { canvasViewOf } from "../canvas-view";
import { CoarseStripBuilder } from "../coarse-strip";
import { DisplayPyramid } from "../display-pyramid-textures";
import {
  DISPLAY_DB_UNKNOWN,
  displayPyramidLevels as displayPyramidLevelsOf,
  levelDecimation,
} from "../display-pyramid";
import { gatherPixelRanges } from "../pixel-ranges";

const RESOLVE_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D levelTex;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(texture(levelTex, vUv).rg, 0.0, 1.0);
}
`;

/** Magnitude a dB pair encodes, the inverse of the shader's forward conversion. */
function dbToMag(db: number): number {
  return Math.max(10 ** (db / 20) - 1e-9, 0);
}

describe("display pyramid textures", () => {
  const data = createConstantQMockSpectrogramData({
    durationSeconds: 2,
    sampleRate: 8000,
    bandsPerOctave: 4,
  });
  const layout = { numBands: data.numBands, metadata: data.metadata };

  let gl: WebGLRenderer;
  let resolveMaterial: RawShaderMaterial;
  let scene: Scene;
  let camera: OrthographicCamera;
  const disposers: Array<() => void> = [];

  beforeAll(() => {
    gl = new WebGLRenderer({ antialias: false });
    resolveMaterial = new RawShaderMaterial({
      uniforms: { levelTex: { value: null as Texture | null } },
      vertexShader: RESOLVE_VERT,
      fragmentShader: RESOLVE_FRAG,
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), resolveMaterial));
    camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
  });

  afterAll(() => {
    for (const dispose of disposers.reverse()) dispose();
    resolveMaterial.dispose();
    gl.dispose();
  });

  /** The dB pairs of one level, read back through a full-precision pass. */
  function readLevel(pyramid: DisplayPyramid, index: number): Float32Array {
    const level = pyramid.levels[index];
    const target = new WebGLRenderTarget(level.textureWidth, level.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    resolveMaterial.uniforms.levelTex.value = pyramid.texture(index);
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Float32Array(level.textureWidth * level.textureHeight * 4);
    gl.readRenderTargetPixels(target, 0, 0, level.textureWidth, level.textureHeight, pixels);
    target.dispose();
    resolveMaterial.uniforms.levelTex.value = null;
    return pixels;
  }

  function makePyramid(opts?: { maxTexels?: number; uploadChunkBins?: number }): DisplayPyramid {
    const pyramid = new DisplayPyramid(layout, opts);
    disposers.push(() => pyramid.dispose());
    return pyramid;
  }

  function seeded(source: Float32Array, opts?: { maxTexels?: number; uploadChunkBins?: number }): DisplayPyramid {
    const pyramid = makePyramid(opts);
    pyramid.seedFromPacked(gl, source);
    return pyramid;
  }

  /** Left and right magnitudes of every bin of every band, level by level. */
  function levelMagnitudes(pyramid: DisplayPyramid, index: number): Float32Array {
    const pixels = readLevel(pyramid, index);
    const out = new Float32Array(pixels.length / 2);
    for (let i = 0; i < out.length / 2; i++) {
      out[i * 2] = dbToMag(pixels[i * 4]);
      out[i * 2 + 1] = dbToMag(pixels[i * 4 + 1]);
    }
    return out;
  }

  it("seeds a level from a strip, then draws the finer levels in to match", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) {
      source[bin * 4] = 0.01 + ((bin * 11) % 83) * 0.004;
      source[bin * 4 + 2] = 0.03 + ((bin * 5) % 71) * 0.006;
    }
    const reference = seeded(source);
    const stripIndex = 2;
    expect(reference.levels.length).toBeGreaterThan(stripIndex + 1);
    const grid = blockGrid(layout, data.numFrames, 8000, 0.25);
    const builder = new CoarseStripBuilder(layout, reference.levels[stripIndex]);
    const blocks: Array<{ ranges: Uint32Array; values: Float32Array }> = [];
    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      const ranges = list.ranges.slice(0, list.count * 2);
      const values = gatherPixelRanges(source, ranges);
      builder.add(ranges, values);
      blocks.push({ ranges, values });
    }

    const pyramid = makePyramid();
    expect(pyramid.seedLevelFromStrip(gl, builder.strip())).toBe(true);
    expect(pyramid.readyLevel).toBe(stripIndex);
    expect(pyramid.texture(0)).not.toBeNull();
    for (let index = stripIndex; index < pyramid.levels.length; index++) {
      expect(Array.from(readLevel(pyramid, index))).toEqual(Array.from(readLevel(reference, index)));
    }

    pyramid.seedingFromCompact(gl);
    for (const block of blocks) pyramid.patchFromCompact(gl, block.values, block.ranges);
    pyramid.seedFinished();
    expect(pyramid.readyLevel).toBe(0);
    for (let index = 0; index < pyramid.levels.length; index++) {
      expect(Array.from(readLevel(pyramid, index))).toEqual(Array.from(readLevel(reference, index)));
    }
  });

  it("holds every bin as not known until something draws it", () => {
    const pyramid = makePyramid();
    pyramid.seedingFromCompact(gl);
    for (let index = 0; index < pyramid.levels.length; index++) {
      const pixels = readLevel(pyramid, index);
      for (let i = 0; i < pixels.length; i += 4) {
        expect([pixels[i], pixels[i + 1]]).toEqual([DISPLAY_DB_UNKNOWN, DISPLAY_DB_UNKNOWN]);
      }
    }

    // A drawn block is known; the rest of the level stays as it was.
    const grid = blockGrid(layout, data.numFrames, data.sampleRate, 1);
    const list = blockPixelRanges(grid, 0);
    const ranges = list.ranges.slice(0, list.count * 2);
    pyramid.patchFromCompact(gl, gatherPixelRanges(data.packedData, ranges), ranges);
    const drawn = readLevel(pyramid, 0);
    let known = 0;
    for (let i = 0; i < drawn.length; i += 4) if (drawn[i] !== DISPLAY_DB_UNKNOWN) known++;
    expect(known).toBeGreaterThan(0);
    expect(known).toBeLessThan(drawn.length / 4);
  });

  it("marks the levels before a canvas refresh writes the window it holds", () => {
    // The canvas of a windowed file covers one window, so the refresh that
    // draws it must not leave the rest of the file reading as full scale.
    const pyramid = makePyramid();
    const grid = blockGrid(layout, data.numFrames, data.sampleRate, 1);
    const view = canvasViewOf(grid, 0, 0);
    const padded = new Float32Array(view.textureWidth * view.textureHeight * 4);
    padded.set(gatherPixelRanges(data.packedData, view.ranges));
    const texture = new DataTexture(padded, view.textureWidth, view.textureHeight, RGBAFormat, FloatType);
    texture.internalFormat = "RGBA32F";
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;

    pyramid.refreshFromCanvas(gl, { texture, view }, { ranges: Uint32Array.of(0, view.texels), count: 1 });
    texture.dispose();
    expect(pyramid.texture(0)).not.toBeNull();

    const pixels = readLevel(pyramid, 0);
    let unknown = 0;
    let loud = 0;
    let known = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === DISPLAY_DB_UNKNOWN) unknown++;
      else if (pixels[i] === 0) loud++;
      else known++;
    }
    expect([loud, unknown > 0, known > 0]).toEqual([0, true, true]);
  });

  it("refuses a strip cut for a level the stack does not hold", () => {
    const capped = makePyramid({ maxTexels: 4000 });
    const full = displayPyramidLevelsOf(layout);
    expect(capped.levels[0].stepLog2).toBeGreaterThan(full[0].stepLog2);
    const builder = new CoarseStripBuilder(layout, full[0]);
    expect(capped.seedLevelFromStrip(gl, builder.strip())).toBe(false);
    expect(capped.texture(0)).toBeNull();
  });

  it("holds no texture before it is seeded", () => {
    const pyramid = makePyramid();
    expect(pyramid.texture(0)).toBeNull();
  });

  it("encodes the source magnitudes into the finest level", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < 400; bin++) {
      source[bin * 4] = 0.001 + bin * 0.002;
      source[bin * 4 + 2] = 0.5 - bin * 0.001;
    }
    const pyramid = seeded(source);
    expect(pyramid.levels[0].stepLog2).toBe(0);
    const mags = levelMagnitudes(pyramid, 0);
    for (let bin = 0; bin < 400; bin++) {
      expect(mags[bin * 2]).toBeCloseTo(source[bin * 4], 3);
      expect(mags[bin * 2 + 1]).toBeCloseTo(source[bin * 4 + 2], 3);
    }
  });

  it("takes every level's bin from the finer level's bin at its stride", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) {
      source[bin * 4] = 0.01 + ((bin * 7) % 97) * 0.005;
      source[bin * 4 + 2] = 0.02 + ((bin * 13) % 89) * 0.005;
    }
    const pyramid = seeded(source);
    expect(pyramid.levels.length).toBeGreaterThan(3);

    for (let index = 1; index < pyramid.levels.length; index++) {
      const fine = readLevel(pyramid, index - 1);
      const coarse = readLevel(pyramid, index);
      const fineLevel = pyramid.levels[index - 1];
      const coarseLevel = pyramid.levels[index];
      for (let band = 0; band < layout.numBands; band++) {
        const stride = 2 ** (coarseLevel.metadata[band * 4 + 2] - fineLevel.metadata[band * 4 + 2]);
        const bins = coarseLevel.metadata[band * 4 + 1];
        for (let bin = 0; bin < bins; bin++) {
          const to = (coarseLevel.metadata[band * 4] + bin) * 4;
          const from = (fineLevel.metadata[band * 4] + bin * stride) * 4;
          expect(coarse[to]).toBe(fine[from]);
          expect(coarse[to + 1]).toBe(fine[from + 1]);
        }
      }
    }
  });

  it("starts a capped stack above the source's finest step and still reads the source", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) source[bin * 4] = 0.01 + ((bin * 5) % 61) * 0.01;
    const pyramid = seeded(source, { maxTexels: 3000 });
    const level = pyramid.levels[0];
    expect(level.stepLog2).toBeGreaterThan(0);

    const mags = levelMagnitudes(pyramid, 0);
    for (let band = 0; band < layout.numBands; band++) {
      const stride = levelDecimation(level, layout.metadata[band * 4 + 2], band);
      for (let bin = 0; bin < level.metadata[band * 4 + 1]; bin++) {
        const to = (level.metadata[band * 4] + bin) * 2;
        const from = (layout.metadata[band * 4] + bin * stride) * 4;
        expect(mags[to]).toBeCloseTo(source[from], 3);
      }
    }
  });

  it("uploads in batches without changing what lands", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) source[bin * 4] = 0.03 + ((bin * 11) % 53) * 0.01;
    const whole = seeded(source);
    const chunked = seeded(source, { uploadChunkBins: 37 });
    for (let index = 0; index < whole.levels.length; index++) {
      expect(Array.from(readLevel(chunked, index))).toEqual(Array.from(readLevel(whole, index)));
    }
  });

  it("patches the ranges it is given, matching a full re-seed", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) source[bin * 4] = 0.05 + ((bin * 3) % 41) * 0.01;
    const pyramid = seeded(source);
    const before = readLevel(pyramid, 0);

    const patched = new Float32Array(source);
    const ranges = Uint32Array.of(300, 250, 900, 600);
    for (let r = 0; r < ranges.length; r += 2) {
      for (let bin = ranges[r]; bin < ranges[r] + ranges[r + 1]; bin++) {
        patched[bin * 4] *= 3;
        patched[bin * 4 + 2] = 0.4;
      }
    }
    pyramid.patchFromPacked(gl, patched, ranges);
    const reference = seeded(patched);

    for (let index = 0; index < pyramid.levels.length; index++) {
      expect(Array.from(readLevel(pyramid, index))).toEqual(Array.from(readLevel(reference, index)));
    }
    expect(Array.from(readLevel(pyramid, 0))).not.toEqual(Array.from(before));
  });

  it("patches from the ranges' own pixels the same as from the whole array", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) source[bin * 4] = 0.05 + ((bin * 3) % 41) * 0.01;
    const fromWhole = seeded(source);
    const fromCompact = seeded(source);
    const before = readLevel(fromCompact, 0);

    // Two ranges the level strides do not line up with, and one whole block
    // of the store's grid, which is the shape the seed reads in.
    const grid = blockGrid(layout, data.numFrames, data.sampleRate);
    const block = blockPixelRanges(grid, 2);
    const ranges = Uint32Array.from([301, 247, 903, 601, ...block.ranges.subarray(0, block.count * 2)]);
    const patched = new Float32Array(source);
    for (let r = 0; r < ranges.length; r += 2) {
      for (let bin = ranges[r]; bin < ranges[r] + ranges[r + 1]; bin++) {
        patched[bin * 4] *= 3;
        patched[bin * 4 + 2] = 0.4;
      }
    }

    fromWhole.patchFromPacked(gl, patched, ranges);
    fromCompact.patchFromCompact(gl, gatherPixelRanges(patched, ranges), ranges);

    for (let index = 0; index < fromWhole.levels.length; index++) {
      expect(Array.from(readLevel(fromCompact, index))).toEqual(Array.from(readLevel(fromWhole, index)));
    }
    expect(Array.from(readLevel(fromCompact, 0))).not.toEqual(Array.from(before));
  });

  it("patches a capped stack up every level", () => {
    const source = new Float32Array(data.packedData);
    for (let bin = 0; bin < source.length / 4; bin++) source[bin * 4] = 0.07 + ((bin * 17) % 31) * 0.01;
    const pyramid = seeded(source, { maxTexels: 3000 });

    const patched = new Float32Array(source);
    const ranges = Uint32Array.of(1000, 900);
    for (let bin = 1000; bin < 1900; bin++) patched[bin * 4] = 0.9;
    pyramid.patchFromPacked(gl, patched, ranges);
    const reference = seeded(patched, { maxTexels: 3000 });

    for (let index = 0; index < pyramid.levels.length; index++) {
      expect(Array.from(readLevel(pyramid, index))).toEqual(Array.from(readLevel(reference, index)));
    }
  });

  it("skips a patch into an unseeded stack", () => {
    const pyramid = makePyramid();
    pyramid.patchFromPacked(gl, data.packedData, Uint32Array.of(0, 64));
    expect(pyramid.texture(0)).toBeNull();
  });
});
