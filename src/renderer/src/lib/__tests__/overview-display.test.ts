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
import { beforeAll, describe, expect, it } from "vitest";
import overviewProbeFrag from "../../test/overview-probe.frag";
import probeVert from "../../test/paging-probe.vert";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { buildOverview, createOverviewTextures, magnitudeToDb, overviewDecimationOf } from "../overview";
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
// Coarse enough that the mock's short bands still reach both sides of the
// crossover in glsl/overview.glsl, which is stated in overview bins per pixel.
const OVERVIEW_STEP_LOG2 = 6;

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
  const overview = buildOverview(data.packedData, layout, data.metadata, OVERVIEW_STEP_LOG2);

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

    const overviewTextures = createOverviewTextures(overview);

    material = new RawShaderMaterial({
      uniforms: {
        sourceSpectrogramTex: { value: null },
        sourceMetadataTex: { value: null },
        sourceFrameCount: { value: layout.numFrames },
        sourceBandCount: { value: layout.numBands },
        wrapMode: { value: 0 },
        overviewTex: { value: overviewTextures.data },
        overviewMetaTex: { value: overviewTextures.meta },
        overviewActive: { value: true },
        overviewStepLog2: { value: OVERVIEW_STEP_LOG2 },
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
    const columns = 2048;
    // Fine enough that no band's overview bin reaches a pixel, so the seam is
    // the only thing that can pull the read toward the overview.
    const stride = 4;
    const out = probe(window.startFrame - (columns / 2) * stride, stride, columns);

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

  // Which source a read takes is decided by zoom, not by residency, so the two
  // sides of a window edge cannot differ in what they are made of. The overview
  // is on one time step in every band, so the switch happens everywhere at once.
  it("takes the overview on both sides of the seam once its bins are sub-pixel", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);
    bindWindow(window);
    const columns = 48;
    const stride = 512;
    const out = probe(0, stride, columns);

    let deepInside = 0;
    let outside = 0;
    for (let y = 0; y < layout.numBands; y++) {
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        expect(out[i + 1]).toBe(1);
        if (out[i + 3] >= FADE_BINS) deepInside++;
        if (out[i + 3] < 0) outside++;
      }
    }
    // The overview won it well inside the window, where residency alone would
    // have kept the window's own bins.
    expect(deepInside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  // The overview is on one time step, so the zoom at which the display starts
  // preferring it is the same everywhere: no band boundary shows a join.
  it("crosses at the same zoom in every band", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 4, layout.numFrames / 2);
    bindWindow(window);
    const columns = 64;
    // One overview bin per pixel, halfway along the crossover.
    const stride = 2 ** OVERVIEW_STEP_LOG2;
    // Clear of both window edges, so the seam fade cannot reach these reads.
    const out = probe(window.startFrame + 2048, stride, columns);

    for (let x = 0; x < columns; x++) {
      const blend = out[x * 4 + 1];
      expect(blend).toBeGreaterThan(0);
      expect(blend).toBeLessThan(1);
      for (let y = 1; y < layout.numBands; y++) {
        expect(out[(y * columns + x) * 4 + 1]).toBeCloseTo(blend, 5);
      }
    }
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
    const columns = 62;
    // Not a multiple of any band's overview step, so the reads land between
    // bins rather than on them.
    const stride = 500;
    const out = probe(0, stride, columns);

    /** Max magnitude over one overview group of a band. */
    const groupPeak = (band: number, group: number): number => {
      let peak = 0;
      const decimation = overviewDecimationOf(layout, band, OVERVIEW_STEP_LOG2);
      for (let k = 0; k < decimation; k++) {
        const bin = group * decimation + k;
        if (bin >= layout.bandLengths[band]) break;
        peak = Math.max(peak, data.packedData[(layout.bandOffsets[band] + bin) * 4]);
      }
      return peak;
    };

    let checked = 0;
    for (let y = 0; y < layout.numBands; y++) {
      const overviewStep = 2 ** overview.layout.bandStepLog2s[y];
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
    const columns = 62;
    // A multiple of every band's overview step, so each read lands on a group
    // boundary, and coarse enough that the zoom takes the overview whole.
    const stride = 2 ** Math.max(...Array.from(overview.layout.bandStepLog2s)) * 4;
    const out = probe(0, stride, columns);

    let checked = 0;
    for (let y = 0; y < layout.numBands; y++) {
      const overviewStep = 2 ** overview.layout.bandStepLog2s[y];
      const decimation = overviewDecimationOf(layout, y, OVERVIEW_STEP_LOG2);
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        if (out[i + 1] !== 1) continue;
        const group = Math.floor((x * stride) / overviewStep);
        if (group >= overview.layout.bandLengths[y]) continue;
        let peak = 0;
        for (let k = 0; k < decimation; k++) {
          const bin = group * decimation + k;
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
