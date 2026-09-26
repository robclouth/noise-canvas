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
  WebGLRenderTarget,
} from "three";
import { afterAll, describe, expect, it } from "vitest";
import { createDefaultUniforms } from "../../effects/base-effect";
import passThroughVert from "../../glsl/pass-through.vert";
import probeFrag from "../../test/exact-turns-probe.frag";
import { createGL } from "../../test/render-harness";
import { metadataTextureRows } from "../band-layout";

/** A float as n · 2^e with n an integer, so products and sums of floats stay exact. */
type Dyadic = { n: bigint; e: number };

function dyadic(x: number): Dyadic {
  if (x === 0) return { n: 0n, e: 0 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const n = biased === 0 ? fraction : fraction | (1n << 52n);
  return { n: bits >> 63n ? -n : n, e: (biased === 0 ? 1 : biased) - 1075 };
}

function plus(a: Dyadic, b: Dyadic): Dyadic {
  const e = Math.min(a.e, b.e);
  return { n: (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e)), e };
}

function times(a: Dyadic, b: Dyadic): Dyadic {
  return { n: a.n * b.n, e: a.e + b.e };
}

function fractionOf(a: Dyadic): number {
  if (a.e >= 0) return 0;
  const one = 1n << BigInt(-a.e);
  return Number(((a.n % one) + one) % one) / 2 ** -a.e;
}

function valueOf(a: Dyadic): number {
  return Number(a.n) * 2 ** a.e;
}

/** How far apart two fractions of a turn sit around the circle. */
function turnDistance(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d - Math.round(d));
}

const CENTRES_HZ = [27.5, 440.1234, 1893.479, 11025.37, 21999.9];
const SAMPLE_RATES = [44100, 48000];
const KS = [1, -1, 0.8, 2 ** (5 / 12), -0.25, 1e-3, 4 / 3];
const WHOLES = [0, 1, 4095, 4096, 2 ** 24 - 1, 2 ** 24 + 1, 26_460_000, 158_760_000, 2 ** 30 + 12_345];
const OFFSETS = [0, 0.5, 12345.25, -3000.75, 4_194_303.5, 1234.5678];

type Case = { k: number; rate: [number, number]; whole: number; offset: number };

function cases(): Case[] {
  const out: Case[] = [];
  for (const sampleRate of SAMPLE_RATES) {
    // The rates as the metadata texture carries them.
    const rows = metadataTextureRows(
      { numBands: CENTRES_HZ.length, metadata: Float64Array.from(CENTRES_HZ.flatMap((hz) => [0, 1, 0, hz])) },
      sampleRate,
    );
    for (let band = 0; band < CENTRES_HZ.length; band++) {
      const rate: [number, number] = [rows[(CENTRES_HZ.length + band) * 4], rows[(CENTRES_HZ.length + band) * 4 + 1]];
      for (const k of KS) {
        for (const whole of WHOLES) {
          for (const offset of OFFSETS) out.push({ k: Math.fround(k), rate, whole, offset: Math.fround(offset) });
        }
      }
    }
  }
  return out;
}

/** turnsOver and phaseOfTurns of every case, as the shaders compute them. */
function runProbe(all: Case[]): Float32Array {
  const gl = createGL();
  const input = new Float32Array(all.length * 8);
  all.forEach(({ k, rate, whole, offset }, i) => {
    input.set([k, rate[0], rate[1], offset], i * 4);
    input.set([whole - (whole % 4096), whole % 4096, 0, 0], (all.length + i) * 4);
  });
  const probeTex = new DataTexture(input, all.length, 2, RGBAFormat, FloatType);
  probeTex.minFilter = NearestFilter;
  probeTex.magFilter = NearestFilter;
  probeTex.needsUpdate = true;
  const material = new RawShaderMaterial({
    uniforms: { ...createDefaultUniforms(), probeTex: { value: probeTex } },
    vertexShader: passThroughVert,
    fragmentShader: probeFrag,
    glslVersion: GLSL3,
  });
  const target = new WebGLRenderTarget(all.length, 1, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), material));
  gl.setRenderTarget(target);
  gl.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const out = new Float32Array(all.length * 4);
  gl.readRenderTargetPixels(target, 0, 0, all.length, 1, out);
  gl.setRenderTarget(null);
  target.dispose();
  material.dispose();
  probeTex.dispose();
  gl.dispose();
  return out;
}

const ALL = cases();
let probed: Float32Array | null = null;
const probe = (): Float32Array => (probed ??= runProbe(ALL));

describe("exact turns", () => {
  afterAll(() => {
    probed = null;
  });

  it("takes the fraction of k × rate × frames to a millionth of a turn at any position", () => {
    const out = probe();
    const misses: string[] = [];
    ALL.forEach(({ k, rate, whole, offset }, i) => {
      const exact = times(
        times(dyadic(k), plus(dyadic(rate[0]), dyadic(rate[1]))),
        plus(dyadic(whole), dyadic(offset)),
      );
      const off = turnDistance(out[i * 4], fractionOf(exact));
      if (!(off < 2e-6)) misses.push(`k ${k} rate ${rate[0]} whole ${whole} offset ${offset}: ${off} turns out`);
    });
    expect(misses.slice(0, 8), `${misses.length} of ${ALL.length} cases`).toEqual([]);
  });

  it("keeps whole turns while a float holds the phase, and only the fraction past that", () => {
    const out = probe();
    const misses: string[] = [];
    ALL.forEach(({ k, rate, whole, offset }, i) => {
      const exact = times(
        times(dyadic(k), plus(dyadic(rate[0]), dyadic(rate[1]))),
        plus(dyadic(whole), dyadic(offset)),
      );
      const turns = valueOf(exact);
      const phase = out[i * 4 + 2];
      if (Math.abs(turns) < 16_000) {
        const off = Math.abs(phase - 2 * Math.PI * turns);
        if (!(off < 0.01)) misses.push(`${turns} turns kept as ${phase}: ${off} rad out`);
      } else if (Math.abs(turns) > 17_000) {
        const off = turnDistance(phase / (2 * Math.PI), fractionOf(exact));
        if (!(Math.abs(phase) <= Math.PI + 1e-6 && off < 2e-6))
          misses.push(`${turns} turns as ${phase}: ${off} turns out`);
      }
    });
    expect(misses.slice(0, 8), `${misses.length} of ${ALL.length} cases`).toEqual([]);
  });
});
