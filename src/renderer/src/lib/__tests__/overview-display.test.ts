import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { beforeAll, describe, expect, it } from "vitest";
import overviewProbeFrag from "../../test/overview-probe.frag";
import probeVert from "../../test/paging-probe.vert";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { buildOverview, magnitudeToDb, OVERVIEW_DECIMATION } from "../overview";
import { gatherPixelRanges } from "../pixel-ranges";
import {
  buildWindowLayout,
  buildWindowMetadata,
  fileLayoutOf,
  windowFileRanges,
  type WindowLayout,
} from "../window-layout";

/**
 * Stage 1's correctness gate: with only a window resident, the display must
 * take the missing span from the overview, cross the seam gradually, and leave
 * a whole-file texture untouched.
 */

const FADE_BINS = 8;

describe("display overview fallback", () => {
  const data = createConstantQMockSpectrogramData({ durationSeconds: 4, sampleRate: 8000, bandsPerOctave: 4 });
  const layout = fileLayoutOf(data);
  for (let b = 0; b < layout.numBands; b++) {
    for (let k = 0; k < layout.bandLengths[b]; k++) {
      const pixel = (layout.bandOffsets[b] + k) * 4;
      data.packedData[pixel] = 1e-3 * (1 + ((b * 7 + k * 13) % 97));
      data.packedData[pixel + 2] = data.packedData[pixel];
    }
  }
  const overview = buildOverview(data.packedData, layout, data.metadata);

  let renderer: WebGLRenderer;
  let scene: Scene;
  let camera: OrthographicCamera;
  let material: RawShaderMaterial;

  function floatTexture(values: Float32Array, width: number, height: number, format = RGBAFormat): DataTexture {
    const tex = new DataTexture(values, width, height, format, FloatType);
    tex.internalFormat = format === RGBAFormat ? "RGBA32F" : "RG32F";
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  beforeAll(() => {
    renderer = new WebGLRenderer({ antialias: false });

    const overviewTex = new DataTexture(
      overview.data,
      overview.layout.textureWidth,
      overview.layout.textureHeight,
      RGFormat,
      HalfFloatType,
    );
    overviewTex.internalFormat = "RG16F";
    overviewTex.minFilter = NearestFilter;
    overviewTex.magFilter = NearestFilter;
    overviewTex.wrapS = ClampToEdgeWrapping;
    overviewTex.wrapT = ClampToEdgeWrapping;
    overviewTex.needsUpdate = true;

    material = new RawShaderMaterial({
      uniforms: {
        sourceSpectrogramTex: { value: null },
        sourceMetadataTex: { value: null },
        sourceFrameCount: { value: layout.numFrames },
        sourceBandCount: { value: layout.numBands },
        wrapMode: { value: 0 },
        overviewTex: { value: overviewTex },
        overviewMetaTex: { value: floatTexture(overview.metadata, overview.layout.numBands, 1) },
        overviewActive: { value: true },
        probeFrameOrigin: { value: 0 },
        probeFrameStride: { value: 1 },
      },
      vertexShader: probeVert,
      fragmentShader: overviewProbeFrag,
      glslVersion: GLSL3,
    });
    scene = new Scene();
    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  });

  function bindWindow(window: WindowLayout): void {
    const gathered = gatherPixelRanges(data.packedData, windowFileRanges(window));
    const padded = new Float32Array(window.textureWidth * window.textureHeight * 4);
    padded.set(gathered);
    material.uniforms.sourceSpectrogramTex.value = floatTexture(padded, window.textureWidth, window.textureHeight);
    material.uniforms.sourceMetadataTex.value = floatTexture(
      buildWindowMetadata(window, data.metadata),
      window.numBands,
      2,
    );
  }

  function bindWholeFile(): void {
    material.uniforms.sourceSpectrogramTex.value = floatTexture(
      data.packedData,
      layout.textureWidth,
      layout.textureHeight,
    );
    material.uniforms.sourceMetadataTex.value = floatTexture(data.metadata, layout.numBands, 1);
  }

  function probe(origin: number, stride: number, columns: number): Float32Array {
    const target = new WebGLRenderTarget(columns, layout.numBands, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
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

  it("takes nothing from the overview when the whole file is resident", () => {
    bindWholeFile();
    const columns = 512;
    const stride = Math.floor(layout.numFrames / columns);
    const out = probe(0, stride, columns);
    for (let i = 1; i < out.length; i += 4) expect(out[i]).toBe(0);
  });

  it("takes the overview whole beyond the window and the window whole well inside it", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);
    bindWindow(window);
    const columns = 512;
    const stride = Math.floor(layout.numFrames / columns);
    const out = probe(0, stride, columns);

    let deepInside = 0;
    let outside = 0;
    for (let i = 0; i < out.length; i += 4) {
      const margin = out[i + 3];
      const blend = out[i + 1];
      if (margin >= FADE_BINS) {
        expect(blend).toBe(0);
        deepInside++;
      }
      if (margin < 0) {
        expect(blend).toBe(1);
        outside++;
      }
    }
    expect(deepInside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it("crosses the seam gradually rather than in one step", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);
    bindWindow(window);
    // Contiguous frames across the window's start, at the finest band, where
    // one frame is one bin.
    const columns = 64;
    const out = probe(window.startFrame - 16, 1, columns);

    const blends: number[] = [];
    for (let x = 0; x < columns; x++) blends.push(out[x * 4 + 1]);

    const partial = blends.filter((b) => b > 0 && b < 1);
    expect(partial.length).toBeGreaterThanOrEqual(FADE_BINS - 1);
    // Monotone from fully-overview to fully-window across the seam.
    for (let i = 1; i < blends.length; i++) expect(blends[i]).toBeLessThanOrEqual(blends[i - 1] + 1e-6);
    expect(blends[0]).toBe(1);
    expect(blends[blends.length - 1]).toBe(0);
  });

  it("supplies a level between the two overview bins it blends", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 2, layout.numFrames);
    bindWindow(window);
    const columns = 256;
    const stride = Math.floor(layout.numFrames / columns);
    const out = probe(0, stride, columns);

    /** Max magnitude over one overview group of a band. */
    const groupPeak = (band: number, group: number): number => {
      let peak = 0;
      for (let k = 0; k < OVERVIEW_DECIMATION; k++) {
        const bin = group * OVERVIEW_DECIMATION + k;
        if (bin >= layout.bandLengths[band]) break;
        peak = Math.max(peak, data.packedData[(layout.bandOffsets[band] + bin) * 4]);
      }
      return peak;
    };

    let checked = 0;
    for (let y = 0; y < layout.numBands; y++) {
      const overviewStep = 2 ** (layout.bandStepLog2s[y] + Math.log2(OVERVIEW_DECIMATION));
      const lastGroup = overview.layout.bandLengths[y] - 1;
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        if (out[i + 1] !== 1) continue;

        // The read blends the two overview bins its time falls between, so the
        // value must sit between their peaks — not at the containing group's.
        const g0 = Math.min(Math.floor((x * stride) / overviewStep), lastGroup);
        const g1 = Math.min(g0 + 1, lastGroup);
        const lo = Math.min(groupPeak(y, g0), groupPeak(y, g1));
        const hi = Math.max(groupPeak(y, g0), groupPeak(y, g1));

        // Half float holds dB to an eighth of a dB, which is 1.5% of a magnitude.
        expect(out[i + 2]).toBeGreaterThan(lo * 0.98 - 1e-9);
        expect(out[i + 2]).toBeLessThan(hi * 1.02 + 1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  // The overview must never read quieter than the file it stands for at the
  // peak of a group, or a transient would dim on zoom-out.
  it("never loses a group's peak", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 2, layout.numFrames);
    bindWindow(window);
    const columns = 256;
    const stride = 2 ** Math.max(...Array.from(layout.bandStepLog2s)) * OVERVIEW_DECIMATION;
    const out = probe(0, stride, columns);

    let checked = 0;
    for (let y = 0; y < layout.numBands; y++) {
      const overviewStep = 2 ** (layout.bandStepLog2s[y] + Math.log2(OVERVIEW_DECIMATION));
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        if (out[i + 1] !== 1) continue;
        const group = Math.floor((x * stride) / overviewStep);
        if (group >= overview.layout.bandLengths[y]) continue;
        let peak = 0;
        for (let k = 0; k < OVERVIEW_DECIMATION; k++) {
          const bin = group * OVERVIEW_DECIMATION + k;
          if (bin >= layout.bandLengths[y]) break;
          peak = Math.max(peak, data.packedData[(layout.bandOffsets[y] + bin) * 4]);
        }
        if (peak === 0) continue;
        // Probed exactly on a group boundary, so the blend weight is zero and
        // the read is that group's own peak.
        expect(magnitudeToDb(out[i + 2])).toBeCloseTo(magnitudeToDb(peak), 0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
