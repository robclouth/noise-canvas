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
import { buildOverview, createOverviewTextures } from "../overview";
import { buildInPlaceWindowMetadata, buildWindowLayout, fileLayoutOf } from "../window-layout";

const FADE_BINS = 8;

/**
 * The configuration the app runs before real windows exist: the whole file is
 * on the GPU, and the metadata presents only a window of it as resident.
 */
describe("pretend window over a whole-file texture", () => {
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

  function floatTexture(values: Float32Array, width: number, height: number, rows?: number): DataTexture {
    const tex = new DataTexture(values, width, rows ?? height, RGBAFormat, FloatType);
    tex.internalFormat = "RGBA32F";
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
        sourceSpectrogramTex: { value: floatTexture(data.packedData, layout.textureWidth, layout.textureHeight) },
        sourceMetadataTex: { value: null },
        sourceFrameCount: { value: layout.numFrames },
        sourceBandCount: { value: layout.numBands },
        wrapMode: { value: 0 },
        overviewTex: { value: overviewTextures.data },
        overviewMetaTex: { value: overviewTextures.meta },
        overviewActive: { value: true },
        overviewStepLog2: { value: overview.stepLog2 },
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

  it("falls back only outside the pretend window, over a whole-file texture", () => {
    const window = buildWindowLayout(layout, layout.numFrames / 4, (layout.numFrames * 3) / 4);
    material.uniforms.sourceMetadataTex.value = floatTexture(
      buildInPlaceWindowMetadata(window, data.metadata),
      layout.numBands,
      0,
      2,
    );

    const columns = 256;
    const stride = Math.floor(layout.numFrames / columns);
    const target = new WebGLRenderTarget(columns, layout.numBands, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    material.uniforms.probeFrameStride.value = stride;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const out = new Float32Array(columns * layout.numBands * 4);
    renderer.readRenderTargetPixels(target, 0, 0, columns, layout.numBands, out);
    renderer.setRenderTarget(null);
    target.dispose();

    let inside = 0;
    let outside = 0;
    for (let band = 0; band < layout.numBands; band++) {
      for (let x = 0; x < columns; x++) {
        const i = (band * columns + x) * 4;
        const margin = out[i + 3];
        const blend = out[i + 1];
        const overview = out[i + 2];
        if (margin >= FADE_BINS) {
          expect(blend).toBe(0);
          inside++;
        }
        if (margin < 0) {
          expect(blend).toBe(1);
          outside++;
        }
        // The overview must carry real magnitudes everywhere the display can
        // reach for them, or the fallback draws black over live content.
        expect(Number.isFinite(overview)).toBe(true);
        expect(overview).toBeGreaterThan(0);
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });
});
