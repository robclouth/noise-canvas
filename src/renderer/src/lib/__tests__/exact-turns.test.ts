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
import { createDefaultUniforms, splitRatio } from "../../effects/base-effect";
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
/** Factors as a float and its remainder: plain floats, and the dest-per-source-frame ratios of mixed sample rates. */
const KS: [number, number][] = [
  ...[1, -1, 0.8, 2 ** (5 / 12), -0.25, 1e-3, 4 / 3].map((k): [number, number] => [Math.fround(k), 0]),
  ...[
    [48000, 44100],
    [44100, 48000],
    [96000, 44100],
  ].map(([dest, source]): [number, number] => {
    const ratio = splitRatio(dest, source);
    return [ratio.x, ratio.y];
  }),
];
const WHOLES = [0, 1, 4095, 4096, 2 ** 24 - 1, 2 ** 24 + 1, 26_460_000, 158_760_000, 2 ** 30 + 12_345];
const OFFSETS = [0, 0.5, 12345.25, -3000.75, 4_194_303.5, 1234.5678];
const SECONDS = [0, 0.375, 1.2345678, 537.123, 600.01, 1234.5678, 3599.999, -2.5];
const PROBE_SAMPLE_RATES = [44100, 48000, 96000];

type Case = { k: [number, number]; rate: [number, number]; whole: number; offset: number };

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
          for (const offset of OFFSETS) out.push({ k, rate, whole, offset: Math.fround(offset) });
        }
      }
    }
  }
  return out;
}

function exactTurns({ k, rate, whole, offset }: Case): Dyadic {
  return times(
    times(plus(dyadic(k[0]), dyadic(k[1])), plus(dyadic(rate[0]), dyadic(rate[1]))),
    plus(dyadic(whole), dyadic(offset)),
  );
}

/** The probe shader over one case per column, two input rows each, in `mode`. */
function runProbe(input: Float32Array, width: number, mode: number): Float32Array {
  const gl = createGL();
  const probeTex = new DataTexture(input, width, 2, RGBAFormat, FloatType);
  probeTex.minFilter = NearestFilter;
  probeTex.magFilter = NearestFilter;
  probeTex.needsUpdate = true;
  const material = new RawShaderMaterial({
    uniforms: { ...createDefaultUniforms(), probeTex: { value: probeTex }, probeMode: { value: mode } },
    vertexShader: passThroughVert,
    fragmentShader: probeFrag,
    glslVersion: GLSL3,
  });
  const target = new WebGLRenderTarget(width, 1, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), material));
  gl.setRenderTarget(target);
  gl.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const out = new Float32Array(width * 4);
  gl.readRenderTargetPixels(target, 0, 0, width, 1, out);
  gl.setRenderTarget(null);
  target.dispose();
  material.dispose();
  probeTex.dispose();
  gl.dispose();
  return out;
}

/** turnsOver and phaseOfTurns of every case, as the shaders compute them. */
function probeTurns(all: Case[]): Float32Array {
  const input = new Float32Array(all.length * 8);
  all.forEach(({ k, rate, whole, offset }, i) => {
    input.set([k[0], rate[0], rate[1], offset], i * 4);
    input.set([whole - (whole % 4096), whole % 4096, k[1], 0], (all.length + i) * 4);
  });
  return runProbe(input, all.length, 0);
}

const ALL = cases();
let probed: Float32Array | null = null;
const probe = (): Float32Array => (probed ??= probeTurns(ALL));

describe("exact turns", () => {
  afterAll(() => {
    probed = null;
  });

  it("takes the fraction of k × rate × frames to a millionth of a turn at any position", () => {
    const out = probe();
    const misses: string[] = [];
    ALL.forEach((c, i) => {
      const off = turnDistance(out[i * 4], fractionOf(exactTurns(c)));
      if (!(off < 2e-6))
        misses.push(`k ${c.k} rate ${c.rate[0]} whole ${c.whole} offset ${c.offset}: ${off} turns out`);
    });
    expect(misses.slice(0, 8), `${misses.length} of ${ALL.length} cases`).toEqual([]);
  });

  it("keeps whole turns while a float holds the phase, and only the fraction past that", () => {
    const out = probe();
    const misses: string[] = [];
    ALL.forEach((c, i) => {
      const exact = exactTurns(c);
      const turns = valueOf(exact);
      const phase = out[i * 4 + 2];
      if (Math.abs(turns) < 130_000) {
        const off = Math.abs(phase - 2 * Math.PI * turns);
        if (!(off < 0.07)) misses.push(`${turns} turns kept as ${phase}: ${off} rad out`);
      } else if (Math.abs(turns) > 132_000) {
        const off = turnDistance(phase / (2 * Math.PI), fractionOf(exact));
        if (!(Math.abs(phase) <= Math.PI + 1e-6 && off < 2e-6))
          misses.push(`${turns} turns as ${phase}: ${off} turns out`);
      }
    });
    expect(misses.slice(0, 8), `${misses.length} of ${ALL.length} cases`).toEqual([]);
  });

  it("splits seconds times a sample rate into whole frames and the rest exactly", () => {
    const all = SECONDS.flatMap((sec) =>
      PROBE_SAMPLE_RATES.map((sampleRate) => ({ sec: Math.fround(sec), sampleRate })),
    );
    const input = new Float32Array(all.length * 8);
    all.forEach(({ sec, sampleRate }, i) => input.set([sec, sampleRate, 0, 0], i * 4));
    const out = runProbe(input, all.length, 1);
    const misses: string[] = [];
    all.forEach(({ sec, sampleRate }, i) => {
      const exact = times(dyadic(sec), dyadic(sampleRate));
      const whole = Math.floor(valueOf(exact));
      const part = fractionOf(exact);
      const gotWhole = out[i * 4] * 4096 + out[i * 4 + 1];
      if (gotWhole !== whole || !(Math.abs(out[i * 4 + 2] - part) < 1e-6)) {
        misses.push(`${sec} s at ${sampleRate}: ${gotWhole} + ${out[i * 4 + 2]}, not ${whole} + ${part}`);
      }
    });
    expect(misses).toEqual([]);
  });
});
