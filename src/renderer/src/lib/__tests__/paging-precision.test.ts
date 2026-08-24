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
import precisionFrag from "../../test/paging-precision.frag";
import probeVert from "../../test/paging-probe.vert";

/**
 * Stage 0's precision spike. Unpacked UV is file space, so a frame reaches the
 * addressing as `frame / frameCount` and is multiplied back by it. Float32
 * carries 24 mantissa bits, so past 2^24 frames the product cannot name every
 * frame and the recovered bin drifts. This measures where that starts, which
 * is what decides the longest file paging can address.
 */

const BANDS = 8;
// Every band's step, high frequency first — one octave per step, as gaborator lays them out.
const STEP_LOG2 = [0, 1, 2, 3, 4, 5, 6, 7];

interface Measurement {
  frames: number;
  /** Worst |round(recovered) - frame| over the probe. */
  maxFrameError: number;
  /** Worst |addressed bin - expected bin|, per band. */
  perBand: number[];
}

describe("packed addressing precision", () => {
  let renderer: WebGLRenderer;
  let scene: Scene;
  let camera: OrthographicCamera;
  let material: RawShaderMaterial;
  let metadataTex: DataTexture;

  beforeAll(() => {
    renderer = new WebGLRenderer({ antialias: false });

    const metadata = new Float32Array(BANDS * 4);
    for (let b = 0; b < BANDS; b++) {
      metadata[b * 4 + 0] = 0;
      // Long enough that the helper's own clamp never masks a drifted index.
      metadata[b * 4 + 1] = 1e9;
      metadata[b * 4 + 2] = STEP_LOG2[b];
      metadata[b * 4 + 3] = 1000;
    }
    metadataTex = new DataTexture(metadata, BANDS, 1, RGBAFormat, FloatType);
    metadataTex.internalFormat = "RGBA32F";
    metadataTex.minFilter = NearestFilter;
    metadataTex.magFilter = NearestFilter;
    metadataTex.wrapS = ClampToEdgeWrapping;
    metadataTex.wrapT = ClampToEdgeWrapping;
    metadataTex.needsUpdate = true;

    material = new RawShaderMaterial({
      uniforms: {
        sourceMetadataTex: { value: metadataTex },
        sourceFrameCount: { value: 1 },
        sourceBandCount: { value: BANDS },
        wrapMode: { value: 0 },
        probeFrameOrigin: { value: 0 },
        probeFrameStride: { value: 1 },
      },
      vertexShader: probeVert,
      fragmentShader: precisionFrag,
      glslVersion: GLSL3,
    });
    scene = new Scene();
    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  });

  function measure(frames: number, origin = 0, stride = 0, columns = 1024): Measurement {
    // stride 0 spreads the probe across the whole file; any other value probes
    // a contiguous run from `origin`, which is where the worst case lives.
    const step = stride || Math.max(1, Math.floor((frames - 1) / (columns - 1)));
    material.uniforms.sourceFrameCount.value = frames;
    material.uniforms.probeFrameOrigin.value = origin;
    material.uniforms.probeFrameStride.value = step;

    const target = new WebGLRenderTarget(columns, BANDS, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const out = new Float32Array(columns * BANDS * 4);
    renderer.readRenderTargetPixels(target, 0, 0, columns, BANDS, out);
    renderer.setRenderTarget(null);
    target.dispose();

    let maxFrameError = 0;
    const perBand: number[] = [];
    for (let y = 0; y < BANDS; y++) {
      let bandMax = 0;
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 4;
        const frame = origin + x * step;
        const expectedBin = Math.floor(frame / 2 ** STEP_LOG2[y]);
        bandMax = Math.max(bandMax, Math.abs(out[i] - expectedBin));
        maxFrameError = Math.max(maxFrameError, Math.abs(out[i + 2] - frame));
      }
      perBand.push(bandMax);
    }
    return { frames, maxFrameError, perBand };
  }

  /** Worst bin error over contiguous runs at the start, middle and end of a file. */
  function worstBinError(frames: number): { perBand: number[]; maxFrameError: number } {
    const perBand = new Array(BANDS).fill(0);
    let maxFrameError = 0;
    for (const origin of [0, Math.floor(frames / 2), Math.max(0, frames - 1024)]) {
      const m = measure(frames, origin, 1);
      for (let b = 0; b < BANDS; b++) perBand[b] = Math.max(perBand[b], m.perBand[b]);
      maxFrameError = Math.max(maxFrameError, m.maxFrameError);
    }
    const spread = measure(frames);
    for (let b = 0; b < BANDS; b++) perBand[b] = Math.max(perBand[b], spread.perBand[b]);
    return { perBand, maxFrameError };
  }

  it("addresses every band's bins exactly below 2^24 frames", () => {
    for (const minutes of [1, 2, 4, 5]) {
      const frames = minutes * 60 * 48000;
      expect(frames).toBeLessThan(2 ** 24);
      const { perBand } = worstBinError(frames);
      expect(perBand).toEqual(new Array(BANDS).fill(0));
    }
  });

  it("mis-addresses bins past 2^24 frames", () => {
    const six = worstBinError(6 * 60 * 48000);
    expect(6 * 60 * 48000).toBeGreaterThan(2 ** 24);
    expect(six.perBand[0]).toBeGreaterThanOrEqual(1);

    const twenty = worstBinError(20 * 60 * 48000);
    expect(twenty.perBand[0]).toBeGreaterThanOrEqual(2);
  });

  // The limit is a property of the round trip, not of a duration: it is where
  // float32 stops naming every whole frame. Paging cannot lift it — unpacked UV
  // is file space, so `uv.x * frameCount` is formed before any window origin
  // comes off. Longer files need integer or view-local addressing, which is its
  // own piece of work.
  it("puts the ceiling at 2^24 frames, whatever the sample rate", () => {
    for (const sampleRate of [44100, 48000, 96000]) {
      const seconds = 2 ** 24 / sampleRate;
      expect(worstBinError(Math.floor(seconds * sampleRate)).perBand).toEqual(new Array(BANDS).fill(0));
      expect(worstBinError(Math.floor((seconds + 30) * sampleRate)).perBand[0]).toBeGreaterThanOrEqual(1);
      console.log(`[paging] exact addressing holds to ${seconds.toFixed(1)} s at ${sampleRate} Hz`);
    }
  });
});
