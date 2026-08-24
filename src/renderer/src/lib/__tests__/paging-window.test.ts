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
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import probeFrag from "../../test/paging-probe.frag";
import probeVert from "../../test/paging-probe.vert";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { gatherPixelRanges } from "../pixel-ranges";
import {
  buildInPlaceWindowMetadata,
  buildWindowLayout,
  buildWindowMetadata,
  fileLayoutOf,
  windowFileRanges,
  type PackedLayout,
  type WindowLayout,
} from "../window-layout";

/**
 * Stage 0's gate: with the addressing centralised, a window of a file must
 * answer every resident read exactly as the whole file does, and must report
 * every other read as a miss rather than clamping into edge data.
 */

const SAMPLE_RATE = 8000;
const BANDS_PER_OCTAVE = 4;

/** Distinct magnitude per packed pixel, so a mis-addressed read cannot pass. */
function stampPackedData(data: Float32Array, layout: PackedLayout): void {
  for (let b = 0; b < layout.numBands; b++) {
    for (let k = 0; k < layout.bandLengths[b]; k++) {
      const pixel = layout.bandOffsets[b] + k;
      data[pixel * 4 + 0] = b * 4096 + k + 1;
      data[pixel * 4 + 1] = 0;
      data[pixel * 4 + 2] = b * 4096 + k + 1;
      data[pixel * 4 + 3] = 0;
    }
  }
}

interface ProbeTextures {
  packed: DataTexture;
  metadata: DataTexture;
}

function makeTextures(
  packedData: Float32Array,
  metadata: Float32Array,
  width: number,
  height: number,
  metaBands: number,
  metaRows: number,
): ProbeTextures {
  const packed = new DataTexture(packedData, width, height, RGBAFormat, FloatType);
  packed.internalFormat = "RGBA32F";
  packed.minFilter = NearestFilter;
  packed.magFilter = NearestFilter;
  packed.wrapS = ClampToEdgeWrapping;
  packed.wrapT = ClampToEdgeWrapping;
  packed.needsUpdate = true;

  const meta = new DataTexture(metadata, metaBands, metaRows, RGBAFormat, FloatType);
  meta.internalFormat = "RGBA32F";
  meta.minFilter = NearestFilter;
  meta.magFilter = NearestFilter;
  meta.wrapS = ClampToEdgeWrapping;
  meta.wrapT = ClampToEdgeWrapping;
  meta.needsUpdate = true;

  return { packed, metadata: meta };
}

/** The window's own packed texture: its pixels gathered out of the file array. */
function windowTextures(fileData: Float32Array, fileMetadata: Float32Array, window: WindowLayout): ProbeTextures {
  const gathered = gatherPixelRanges(fileData, windowFileRanges(window));
  const padded = new Float32Array(window.textureWidth * window.textureHeight * 4);
  padded.set(gathered);
  return makeTextures(
    padded,
    buildWindowMetadata(window, fileMetadata),
    window.textureWidth,
    window.textureHeight,
    window.numBands,
    2,
  );
}

describe("paged window reads", () => {
  const data = createConstantQMockSpectrogramData({
    durationSeconds: 4,
    sampleRate: SAMPLE_RATE,
    bandsPerOctave: BANDS_PER_OCTAVE,
  });
  const layout = fileLayoutOf(data);
  stampPackedData(data.packedData, layout);

  let renderer: WebGLRenderer;
  let scene: Scene;
  let camera: OrthographicCamera;
  let material: RawShaderMaterial;
  const disposables: { dispose: () => void }[] = [];

  beforeAll(() => {
    renderer = new WebGLRenderer({ antialias: false });
    material = new RawShaderMaterial({
      uniforms: {
        sourceSpectrogramTex: { value: null },
        sourceMetadataTex: { value: null },
        sourceFrameCount: { value: layout.numFrames },
        sourceBandCount: { value: layout.numBands },
        wrapMode: { value: 0 },
        probeFrameOrigin: { value: 0 },
        probeFrameStride: { value: 1 },
      },
      vertexShader: probeVert,
      fragmentShader: probeFrag,
      glslVersion: GLSL3,
    });
    scene = new Scene();
    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  });

  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose();
  });

  /** One RGBA sample per (frame index, band): magnitude and residency, point and interpolated. */
  function probe(textures: ProbeTextures, origin: number, stride: number, columns: number): Float32Array {
    const target = new WebGLRenderTarget(columns, layout.numBands, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    material.uniforms.sourceSpectrogramTex.value = textures.packed;
    material.uniforms.sourceMetadataTex.value = textures.metadata;
    material.uniforms.probeFrameOrigin.value = origin;
    material.uniforms.probeFrameStride.value = stride;

    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const out = new Float32Array(columns * layout.numBands * 4);
    renderer.readRenderTargetPixels(target, 0, 0, columns, layout.numBands, out);
    renderer.setRenderTarget(null);
    target.dispose();
    return out;
  }

  const fileTextures = (): ProbeTextures =>
    makeTextures(data.packedData, data.metadata, layout.textureWidth, layout.textureHeight, layout.numBands, 1);

  it("reads a whole-file window exactly as the file does", () => {
    const window = buildWindowLayout(layout, 0, layout.numFrames);
    const file = fileTextures();
    const win = windowTextures(data.packedData, data.metadata, window);
    disposables.push(file.packed, file.metadata, win.packed, win.metadata);

    const columns = 512;
    const stride = Math.floor(layout.numFrames / columns);
    const baseline = probe(file, 0, stride, columns);
    const paged = probe(win, 0, stride, columns);

    expect(Array.from(paged)).toEqual(Array.from(baseline));
    for (let i = 1; i < paged.length; i += 4) expect(paged[i]).toBe(1);
  });

  it("matches the file inside a half-file window and reports a miss outside it", () => {
    const start = Math.floor(layout.numFrames / 4);
    const end = Math.floor((layout.numFrames * 3) / 4);
    const window = buildWindowLayout(layout, start, end);
    const file = fileTextures();
    const win = windowTextures(data.packedData, data.metadata, window);
    disposables.push(file.packed, file.metadata, win.packed, win.metadata);

    const columns = 512;
    const stride = Math.floor(layout.numFrames / columns);
    const baseline = probe(file, 0, stride, columns);
    const paged = probe(win, 0, stride, columns);

    let residentSamples = 0;
    let missSamples = 0;
    for (let y = 0; y < layout.numBands; y++) {
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        const frame = x * stride;
        const inWindow = frame >= window.startFrame && frame < window.endFrame;

        if (paged[i + 1] === 1) {
          residentSamples++;
          expect(paged[i]).toBe(baseline[i]);
          expect(inWindow).toBe(true);
        } else {
          missSamples++;
          // Every frame the window covers must be resident; only the far
          // edge's interpolation partner may fall outside.
          expect(inWindow).toBe(false);
        }
        if (paged[i + 3] === 1) expect(paged[i + 2]).toBe(baseline[i + 2]);
      }
    }

    expect(residentSamples).toBeGreaterThan(0);
    expect(missSamples).toBeGreaterThan(0);
  });

  it("holds at every window offset, band by band", () => {
    const file = fileTextures();
    disposables.push(file.packed, file.metadata);
    const columns = 256;
    const stride = Math.floor(layout.numFrames / columns);
    const baseline = probe(file, 0, stride, columns);

    for (const fraction of [0, 0.1, 0.37, 0.5, 0.9]) {
      const start = Math.floor(layout.numFrames * fraction);
      const window = buildWindowLayout(layout, start, start + layout.numFrames / 8);
      const win = windowTextures(data.packedData, data.metadata, window);
      const paged = probe(win, 0, stride, columns);
      win.packed.dispose();
      win.metadata.dispose();

      let resident = 0;
      for (let i = 0; i < paged.length; i += 4) {
        if (paged[i + 1] !== 1) continue;
        resident++;
        expect(paged[i]).toBe(baseline[i]);
      }
      expect(resident).toBeGreaterThan(0);
    }
  });

  it("presents a pretend window over the whole file without moving a resident read", () => {
    const start = Math.floor(layout.numFrames / 3);
    const window = buildWindowLayout(layout, start, start + Math.floor(layout.numFrames / 3));
    const file = fileTextures();
    // The file's own packed texture, described as if only the window were there.
    const pretend: ProbeTextures = {
      packed: file.packed,
      metadata: makeTextures(
        data.packedData,
        buildInPlaceWindowMetadata(window, data.metadata),
        layout.textureWidth,
        layout.textureHeight,
        layout.numBands,
        2,
      ).metadata,
    };
    disposables.push(file.packed, file.metadata, pretend.metadata);

    const columns = 512;
    const stride = Math.floor(layout.numFrames / columns);
    const baseline = probe(file, 0, stride, columns);
    const paged = probe(pretend, 0, stride, columns);

    let resident = 0;
    let miss = 0;
    for (let y = 0; y < layout.numBands; y++) {
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        const frame = x * stride;
        if (paged[i + 1] === 1) {
          resident++;
          expect(paged[i]).toBe(baseline[i]);
          expect(frame >= window.startFrame && frame < window.endFrame).toBe(true);
        } else {
          miss++;
          expect(frame >= window.startFrame && frame < window.endFrame).toBe(false);
        }
      }
    }
    expect(resident).toBeGreaterThan(0);
    expect(miss).toBeGreaterThan(0);
  });

  it("wraps over the file, not over the window", () => {
    const start = Math.floor(layout.numFrames / 2);
    const window = buildWindowLayout(layout, start, layout.numFrames);
    const file = fileTextures();
    const win = windowTextures(data.packedData, data.metadata, window);
    disposables.push(file.packed, file.metadata, win.packed, win.metadata);

    material.uniforms.wrapMode.value = 1;
    const columns = 128;
    const stride = Math.floor(layout.numFrames / columns);
    // Probe a full file length PAST the end, where wrapping folds back to the
    // file's own frames. A window that wrapped itself would land elsewhere.
    const baseline = probe(file, layout.numFrames, stride, columns);
    const paged = probe(win, layout.numFrames, stride, columns);
    material.uniforms.wrapMode.value = 0;

    let resident = 0;
    for (let i = 0; i < paged.length; i += 4) {
      if (paged[i + 1] !== 1) continue;
      resident++;
      expect(paged[i]).toBe(baseline[i]);
    }
    expect(resident).toBeGreaterThan(0);
  });
});
