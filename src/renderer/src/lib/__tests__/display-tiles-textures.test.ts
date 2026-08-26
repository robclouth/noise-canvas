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
import type { SpectrogramData } from "../../store/types";
import { DisplayTileRing, type RingView } from "../display-tiles-textures";
import { tileGrid } from "../display-tiles";

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
uniform sampler2D ringTex;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(texture(ringTex, vUv).rg, 0.0, 1.0);
}
`;

/** The dB the display textures store a magnitude as, the same way the shader does. */
function magToDb(mag: number): number {
  return (20 * Math.log(mag + 1e-9)) / Math.log(10);
}

describe("display tile ring", () => {
  const data: SpectrogramData = createConstantQMockSpectrogramData({
    durationSeconds: 2,
    sampleRate: 8000,
    bandsPerOctave: 4,
  });
  const layout = { numBands: data.numBands, metadata: data.metadata };
  // Far above any level under test, so the ring is never left to the pyramid.
  const PYRAMID_STEP = 30;

  // The mock's magnitude is the same everywhere, which hides a bin read from
  // the wrong place; this varies it along the packed layout.
  const varied = Float32Array.from(data.packedData);
  for (let i = 0; i < varied.length / 4; i++) {
    varied[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.37));
    varied[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.11));
  }

  let gl: WebGLRenderer;
  let resolveMaterial: RawShaderMaterial;
  let scene: Scene;
  let camera: OrthographicCamera;
  const disposers: Array<() => void> = [];

  beforeAll(() => {
    gl = new WebGLRenderer({ antialias: false });
    resolveMaterial = new RawShaderMaterial({
      uniforms: { ringTex: { value: null as Texture | null } },
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

  /** The packed state as the canvas holds it: magnitude and phase per channel. */
  function makeCanvas(packed: Float32Array): DataTexture {
    const texture = new DataTexture(packed, data.textureWidth, data.textureHeight, RGBAFormat, FloatType);
    texture.internalFormat = "RGBA32F";
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    disposers.push(() => texture.dispose());
    return texture;
  }

  function makeRing(maxTexels: number): DisplayTileRing {
    const ring = new DisplayTileRing(layout, data.numFrames, { maxTexels });
    disposers.push(() => ring.dispose());
    return ring;
  }

  /** The ring's dB pairs, read back through a full-precision pass. */
  function readRing(ring: DisplayTileRing, maxTexels: number): Float32Array {
    const width = Math.min(8192, maxTexels);
    const height = Math.ceil(maxTexels / width);
    const target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    resolveMaterial.uniforms.ringTex.value = ring.texture();
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Float32Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    target.dispose();
    resolveMaterial.uniforms.ringTex.value = null;
    return pixels;
  }

  const view = (framesPerPixel: number, startFrame: number, viewportPixels = 64): RingView => ({
    framesPerPixel,
    startFrame,
    endFrame: startFrame + framesPerPixel * viewportPixels,
    viewportPixels,
  });

  /**
   * Checks every resident tile against the packed state it was cut from: bin
   * `k` of a band holds the source bin at `k` times the band's stride.
   */
  function expectRingMatches(ring: DisplayTileRing, maxTexels: number, packed: Float32Array, level: number): number {
    const pixels = readRing(ring, maxTexels);
    const ringUniforms = ring.uniforms();
    const grid = tileGrid(layout, data.numFrames, level);
    expect(ringUniforms.tileCount).toBeGreaterThan(0);
    expect(ringUniforms.tileTexels).toBe(grid.tileTexels);

    let checked = 0;
    for (let tile = ringUniforms.firstTile; tile < ringUniforms.firstTile + ringUniforms.tileCount; tile++) {
      const slot = tile % ringUniforms.slotCount;
      for (let band = 0; band < layout.numBands; band++) {
        const sourceStep = layout.metadata[band * 4 + 2];
        const decimation = 2 ** (grid.metadata[band * 4 + 2] - sourceStep);
        const binsPerTile = grid.metadata[band * 4 + 3];
        const base = tile * binsPerTile;
        const bins = Math.min(binsPerTile, grid.metadata[band * 4 + 1] - base);
        for (let i = 0; i < bins; i++) {
          const at = slot * grid.tileTexels + grid.metadata[band * 4] + i;
          const source = (layout.metadata[band * 4] + (base + i) * decimation) * 4;
          expect(pixels[at * 4], `tile ${tile} band ${band} bin ${i}`).toBeCloseTo(magToDb(packed[source]), 1);
          expect(pixels[at * 4 + 1]).toBeCloseTo(magToDb(packed[source + 2]), 1);
          checked++;
        }
      }
    }
    return checked;
  }

  it("cuts the tiles the view covers straight from the canvas", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    ring.update(gl, canvas, data.textureWidth, view(1, 0), PYRAMID_STEP);
    expect(expectRingMatches(ring, maxTexels, varied, 0)).toBeGreaterThan(1000);
  });

  it("takes every bin at the level's stride when the view is zoomed out", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    ring.update(gl, canvas, data.textureWidth, view(16, 0), PYRAMID_STEP);
    expect(ring.uniforms().level).toBe(4);
    expect(expectRingMatches(ring, maxTexels, varied, 4)).toBeGreaterThan(1000);
  });

  it("re-cuts only the tile a pan brings in", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    const grid = tileGrid(layout, data.numFrames, 0);

    ring.update(gl, canvas, data.textureWidth, view(1, grid.tileFrames * 8), PYRAMID_STEP);
    const before = ring.uniforms();
    const kept = readRing(ring, maxTexels).slice(0, before.tileTexels * before.slotCount * 4);

    // Far enough to leave the window by exactly one tile.
    const panned = (before.firstTile + before.tileCount) * grid.tileFrames;
    ring.update(gl, canvas, data.textureWidth, view(1, panned), PYRAMID_STEP);
    const after = ring.uniforms();
    expect(after.firstTile).toBeGreaterThan(before.firstTile);
    expect(expectRingMatches(ring, maxTexels, varied, 0)).toBeGreaterThan(1000);

    // Every slot still holding a tile from the old window kept its pixels.
    const now = readRing(ring, maxTexels);
    const stillHeld: number[] = [];
    for (let tile = after.firstTile; tile < after.firstTile + after.tileCount; tile++) {
      if (tile >= before.firstTile && tile < before.firstTile + before.tileCount) stillHeld.push(tile);
    }
    expect(stillHeld.length).toBeGreaterThan(0);
    for (const tile of stillHeld) {
      const start = (tile % after.slotCount) * after.tileTexels * 4;
      const end = start + after.tileTexels * 4;
      expect(Array.from(now.slice(start, end))).toEqual(Array.from(kept.slice(start, end)));
    }
  });

  it("keeps its window while the view stays inside it", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    const grid = tileGrid(layout, data.numFrames, 0);
    ring.update(gl, canvas, data.textureWidth, view(1, grid.tileFrames * 8), PYRAMID_STEP);
    const before = ring.uniforms();
    ring.update(gl, canvas, data.textureWidth, view(1, grid.tileFrames * 8 + 4), PYRAMID_STEP);
    expect(ring.uniforms().firstTile).toBe(before.firstTile);
  });

  it("re-cuts only the bins a canvas change names", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const packed = Float32Array.from(varied);
    const canvas = makeCanvas(packed);
    ring.update(gl, canvas, data.textureWidth, view(1, 0), PYRAMID_STEP);

    const grid = tileGrid(layout, data.numFrames, 0);
    const before = readRing(ring, maxTexels);
    const band = 1;
    const bandStart = layout.metadata[band * 4];
    const binAt = (pixels: Float32Array, bin: number): number => {
      const binsPerTile = grid.metadata[band * 4 + 3];
      const tile = Math.floor(bin / binsPerTile);
      const slot = tile % ring.uniforms().slotCount;
      const at = slot * grid.tileTexels + grid.metadata[band * 4] + (bin - tile * binsPerTile);
      return pixels[at * 4];
    };

    // Every texel changes, but only bins 100 to 132 of one band are declared.
    for (let i = 0; i < packed.length; i += 4) packed[i] *= 3;
    canvas.needsUpdate = true;
    ring.refreshFromCanvas(gl, canvas, data.textureWidth, {
      ranges: Uint32Array.of(bandStart + 100, 32),
      count: 1,
    });

    const after = readRing(ring, maxTexels);
    for (const bin of [100, 115, 131]) {
      expect(binAt(after, bin), `bin ${bin}`).toBeCloseTo(magToDb(packed[(bandStart + bin) * 4]), 1);
      expect(binAt(after, bin)).not.toBeCloseTo(binAt(before, bin), 1);
    }
    // Outside the declared range, and clear of the margin the mapping widens
    // it by, the ring still holds what it was cut from.
    for (const bin of [0, 50, 200, 400]) {
      expect(binAt(after, bin), `bin ${bin}`).toBe(binAt(before, bin));
    }
  });

  it("leaves the view to the pyramid when its bins are already that fine", () => {
    const ring = makeRing(1 << 16);
    const canvas = makeCanvas(varied);
    ring.update(gl, canvas, data.textureWidth, view(16, 0), 4);
    expect(ring.uniforms().tileCount).toBe(0);
    expect(ring.texture()).toBeNull();
  });

  it("holds nothing when it is too small for a viewport", () => {
    const ring = makeRing(256);
    const canvas = makeCanvas(varied);
    ring.update(gl, canvas, data.textureWidth, view(1, 0), PYRAMID_STEP);
    expect(ring.uniforms().tileCount).toBe(0);
    expect(ring.texture()).toBeNull();
  });
});
