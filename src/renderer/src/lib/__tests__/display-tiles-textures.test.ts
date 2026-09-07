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
import { wholeFileCanvasView } from "../canvas-view";
import type { CommittedSource } from "../display-decimate";
import { DisplayTileRing, type RingView } from "../display-tiles-textures";
import { DISPLAY_TILES_BYTES_PER_TEXEL, displayTilesBytes, tileGrid } from "../display-tiles";
import { gatherTaps, tapSpanRanges } from "../pixel-ranges";
import { packedFold, padToFold } from "../constants";

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
  const data = createConstantQMockSpectrogramData({
    durationSeconds: 2,
    sampleRate: 8000,
    bandsPerOctave: 4,
  });
  const layout = { numBands: data.numBands, metadata: data.metadata };
  const wholeView = wholeFileCanvasView(data);
  const asSource = (canvas: Texture): CommittedSource => ({ texture: canvas, view: wholeView });
  // Far above any level under test, so the ring is never left to the pyramid.
  const PYRAMID_STEP = 30;

  // The mock's magnitude is the same everywhere, which hides a bin read from
  // the wrong place; this varies it along the packed layout.
  // Padded to the fold once, so a test that writes into it writes into the
  // array its texture is bound to.
  const varied = padToFold(Float32Array.from(data.packedData), data.texels, 4);
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
    const fold = packedFold(data.texels);
    const texture = new DataTexture(packed, fold.width, fold.height, RGBAFormat, FloatType);
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
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    expect(expectRingMatches(ring, maxTexels, varied, 0)).toBeGreaterThan(1000);
  });

  it("takes every bin at the level's stride when the view is zoomed out", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    ring.update(gl, asSource(canvas), view(16, 0), PYRAMID_STEP);
    expect(ring.uniforms().level).toBe(4);
    expect(expectRingMatches(ring, maxTexels, varied, 4)).toBeGreaterThan(1000);
  });

  it("re-cuts only the tile a pan brings in", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    const grid = tileGrid(layout, data.numFrames, 0);

    ring.update(gl, asSource(canvas), view(1, grid.tileFrames * 8), PYRAMID_STEP);
    const before = ring.uniforms();
    const kept = readRing(ring, maxTexels).slice(0, before.tileTexels * before.slotCount * 4);

    // Far enough to leave the window by exactly one tile.
    const panned = (before.firstTile + before.tileCount) * grid.tileFrames;
    ring.update(gl, asSource(canvas), view(1, panned), PYRAMID_STEP);
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
    ring.update(gl, asSource(canvas), view(1, grid.tileFrames * 8), PYRAMID_STEP);
    const before = ring.uniforms();
    ring.update(gl, asSource(canvas), view(1, grid.tileFrames * 8 + 4), PYRAMID_STEP);
    expect(ring.uniforms().firstTile).toBe(before.firstTile);
  });

  it("re-cuts only the bins a canvas change names", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const packed = Float32Array.from(varied);
    const canvas = makeCanvas(packed);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);

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
    ring.refreshFromCanvas(gl, asSource(canvas), {
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

  it("re-cuts a slot that went stale while it held no window", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const packed = Float32Array.from(varied);
    const canvas = makeCanvas(packed);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    expect(ring.uniforms().tileCount).toBeGreaterThan(0);

    // Zoomed out to where the pyramid serves, the ring empties its window.
    ring.update(gl, asSource(canvas), view(16, 0), 4);
    expect(ring.uniforms().tileCount).toBe(0);

    for (let i = 0; i < packed.length; i += 4) packed[i] *= 3;
    canvas.needsUpdate = true;
    ring.refreshFromCanvas(gl, asSource(canvas), {
      ranges: Uint32Array.of(0, data.texels),
      count: 1,
    });

    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    expect(expectRingMatches(ring, maxTexels, packed, 0)).toBeGreaterThan(1000);
  });

  it("cuts a tile from its taps the same as from the canvas", () => {
    const maxTexels = 1 << 16;
    const fromCanvas = makeRing(maxTexels);
    const fromStore = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    // Zoomed out to a level whose fine bands stride, so the cut's stride shows.
    const ringView = view(16, 0);
    fromCanvas.update(gl, asSource(canvas), ringView, PYRAMID_STEP);
    expect(fromCanvas.uniforms().tileCount).toBeGreaterThan(0);
    expect(fromCanvas.uniforms().level).toBe(4);

    const missing = fromStore.aim(ringView, PYRAMID_STEP);
    expect(missing.length).toBeGreaterThan(0);
    expect(fromStore.uniforms().tileCount).toBe(0);
    for (const tile of missing) {
      fromStore.cutTileFromTaps(gl, tile, gatherTaps(varied, fromStore.tileTapRuns(tile)));
    }
    expect(fromStore.aim(ringView, PYRAMID_STEP)).toEqual([]);
    expect(fromStore.uniforms()).toEqual(fromCanvas.uniforms());

    const a = readRing(fromCanvas, maxTexels);
    const b = readRing(fromStore, maxTexels);
    const bound = fromCanvas.uniforms();
    const used = bound.slotCount * bound.tileTexels * 4;
    for (let i = 0; i < used; i++) {
      if (a[i] !== b[i]) throw new Error(`ring texel float ${i} differs: ${a[i]} vs ${b[i]}`);
    }
  });

  it("empties the bound window when a far pan retargets its slots", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    const grid = tileGrid(layout, data.numFrames, 0);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    const before = ring.uniforms();
    expect(before.tileCount).toBeGreaterThan(0);

    const far = view(1, grid.tileFrames * before.tileCount * 3);
    const missing = ring.aim(far, PYRAMID_STEP);
    expect(missing.length).toBeGreaterThan(0);
    expect(ring.uniforms().tileCount).toBe(0);

    for (const tile of missing) {
      ring.cutTileFromTaps(gl, tile, gatherTaps(varied, ring.tileTapRuns(tile)));
    }
    expect(ring.aim(far, PYRAMID_STEP)).toEqual([]);
    expect(ring.uniforms().firstTile).toBe(missing[0]);
    expect(expectRingMatches(ring, maxTexels, varied, 0)).toBeGreaterThan(1000);
  });

  it("names the level it cuts at and the tiles whose slots are free", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    expect(ring.gridLevel()).toBe(-1);
    const canvas = makeCanvas(varied);
    const grid = tileGrid(layout, data.numFrames, 0);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    const bound = ring.uniforms();
    expect(ring.gridLevel()).toBe(0);
    expect(bound.tileCount).toBeGreaterThan(0);

    // A tile the window shows can be cut again; one sharing that slot cannot,
    // until an aim elsewhere lets the window go.
    expect(ring.canCutTile(bound.firstTile)).toBe(true);
    const clashing = bound.firstTile + bound.slotCount;
    expect(ring.canCutTile(clashing)).toBe(false);

    const far = view(1, grid.tileFrames * bound.tileCount * 3);
    ring.aim(far, PYRAMID_STEP);
    expect(ring.uniforms().tileCount).toBe(0);
    expect(ring.canCutTile(clashing)).toBe(true);
  });

  it("cuts a dropped tile again and leaves the others alone", () => {
    const maxTexels = 1 << 16;
    const ring = makeRing(maxTexels);
    const canvas = makeCanvas(varied);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    const bound = ring.uniforms();
    expect(bound.tileCount).toBeGreaterThan(1);
    expect(ring.aim(view(1, 0), PYRAMID_STEP)).toEqual([]);

    // The pixels of the first tile alone: the ring forgets that tile and
    // keeps the rest of the window.
    const dropped = bound.firstTile;
    ring.dropTiles(tapSpanRanges(ring.tileTapRuns(dropped)));
    expect(ring.aim(view(1, 0), PYRAMID_STEP)).toEqual([dropped]);

    ring.cutTileFromTaps(gl, dropped, gatherTaps(varied, ring.tileTapRuns(dropped)));
    expect(ring.aim(view(1, 0), PYRAMID_STEP)).toEqual([]);
    expect(expectRingMatches(ring, maxTexels, varied, 0)).toBeGreaterThan(1000);
  });

  it("costs what the budget charges it", () => {
    const maxTexels = 100_000;
    const ring = makeRing(maxTexels);
    expect(ring.texelCount() * DISPLAY_TILES_BYTES_PER_TEXEL).toBe(displayTilesBytes(maxTexels));
  });

  it("leaves the view to the pyramid when its bins are already that fine", () => {
    const ring = makeRing(1 << 16);
    const canvas = makeCanvas(varied);
    ring.update(gl, asSource(canvas), view(16, 0), 4);
    expect(ring.uniforms().tileCount).toBe(0);
    expect(ring.texture()).toBeNull();
  });

  it("holds nothing when it is too small for a viewport", () => {
    const ring = makeRing(256);
    const canvas = makeCanvas(varied);
    ring.update(gl, asSource(canvas), view(1, 0), PYRAMID_STEP);
    expect(ring.uniforms().tileCount).toBe(0);
    expect(ring.texture()).toBeNull();
  });
});
