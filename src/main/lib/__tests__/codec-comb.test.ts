import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const addon: { removeCodecComb?: (channels: Float32Array[]) => Float32Array[] } = require(
  join(__dirname, "../../../../build/Release/gaborator_addon.node"),
);

const RATE = 44100;
const LINE_HZ = RATE / 256;

/** Six seconds of seeded white noise at about −30 dBFS, plus sines at `tones` Hz of `amplitude` each. */
function signal(tones: number[], amplitude: number): Float32Array {
  const out = new Float32Array(RATE * 6);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 0.1;
    for (const hz of tones) out[i] += amplitude * Math.sin((2 * Math.PI * hz * i) / RATE + hz);
  }
  return out;
}

/** Power at `hz` over the middle four seconds, in dB. */
function powerAt(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / RATE;
  let re = 0;
  let im = 0;
  for (let i = RATE; i < RATE * 5; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return 10 * Math.log10(re * re + im * im);
}

/** How far `hz` stands over the level 20–40 Hz either side of it, in dB. */
function prominence(x: Float32Array, hz: number): number {
  const around = [-40, -30, -20, 20, 30, 40].map((offset) => 10 ** (powerAt(x, hz + offset) / 10));
  return powerAt(x, hz) - 10 * Math.log10(around.reduce((a, b) => a + b, 0) / around.length);
}

const ratioDb = (a: Float32Array, b: Float32Array): number => {
  let diff = 0;
  let ref = 0;
  for (let i = 0; i < a.length; i++) {
    diff += (a[i] - b[i]) ** 2;
    ref += b[i] ** 2;
  }
  return 10 * Math.log10(diff / ref);
};

describe.runIf(addon.removeCodecComb)("Codec comb removal", () => {
  const remove = (x: Float32Array): Float32Array => addon.removeCodecComb!([x])[0];

  it("removes steady lines at multiples of 44100/256 Hz above 2 kHz", () => {
    const lines = [66, 79, 95, 106].map((k) => k * LINE_HZ);
    const input = signal(lines, 0.003);
    const output = remove(input);
    for (const hz of lines) {
      expect(prominence(input, hz)).toBeGreaterThan(15);
      expect(prominence(output, hz)).toBeLessThan(3);
    }
  });

  it("leaves lines below 2 kHz and between the multiples alone", () => {
    const kept = [5 * LINE_HZ, 70.5 * LINE_HZ];
    const input = signal(kept, 0.003);
    const output = remove(input);
    for (const hz of kept) expect(Math.abs(prominence(output, hz) - prominence(input, hz))).toBeLessThan(0.5);
  });

  it("barely touches sound with no lines in it", () => {
    const input = signal([], 0);
    expect(ratioDb(remove(input), input)).toBeLessThan(-30);
  });
});
