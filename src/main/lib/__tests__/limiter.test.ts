import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Exercise the real baked limiter (applyLookaheadLimiter, via the applyLimiter
// test hook) on signals that stress inter-sample true-peak detection. The limiter
// must keep the reconstructed (inter-sample) peak below 0 dBFS so playback
// resampling and the DAC cannot clip — clipping here is the audible "crackle near
// max". Pure tones are the easy case for true-peak detection; broadband and
// near-Nyquist content is where a too-short detection FIR under-reads and lets
// peaks slip over full scale.

const require = createRequire(import.meta.url);
const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  applyLimiter: (
    channels: Float32Array[],
    sampleRate: number,
    attackMs?: number,
    holdMs?: number,
    releaseMs?: number,
  ) => Float32Array[];
};

const SR = 48000;

// Independent oracle: reconstruct the bandlimited signal at many fractional
// sample positions with a long windowed-sinc and take the largest magnitude.
// Deliberately higher resolution than any detector the limiter could use, so it
// reports the true inter-sample peak rather than re-deriving the limiter's own
// estimate.
function measureTruePeak(ch: Float32Array, oversample = 32, halfTaps = 24): number {
  const kernels: number[][] = [];
  for (let ph = 0; ph < oversample; ph++) {
    const d = ph / oversample;
    const k: number[] = [];
    for (let t = 0; t < 2 * halfTaps; t++) {
      const x = t - halfTaps + 1 - d;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / halfTaps);
      k.push(sinc * win);
    }
    kernels.push(k);
  }
  let peak = 0;
  for (let i = halfTaps; i + halfTaps < ch.length; i++) {
    for (let ph = 0; ph < oversample; ph++) {
      let acc = 0;
      for (let t = 0; t < 2 * halfTaps; t++) acc += ch[i + t - halfTaps + 1] * kernels[ph][t];
      peak = Math.max(peak, Math.abs(acc));
    }
  }
  return peak;
}

function limit(signal: Float32Array): Float32Array {
  // Channel-linked: feed identical L/R, as the synthesis path does for the gain curve.
  const out = addon.applyLimiter([signal, Float32Array.from(signal)], SR);
  return out[0];
}

const fill = (make: (i: number) => number): Float32Array => {
  const b = new Float32Array(SR);
  for (let i = 0; i < b.length; i++) b[i] = make(i);
  return b;
};

const cases: Array<{ name: string; signal: Float32Array }> = [
  {
    name: "loud sine 1kHz",
    signal: fill((i) => 0.99 * Math.sin((2 * Math.PI * 1000 * i) / SR)),
  },
  {
    name: "near-Nyquist tone 21kHz",
    signal: fill((i) => Math.sin((2 * Math.PI * 21000 * i) / SR)),
  },
  {
    name: "dense high partials 8k..23k",
    signal: fill((i) => {
      let s = 0;
      for (let f = 8000; f <= 23000; f += 900) s += Math.sin((2 * Math.PI * f * i) / SR + f);
      return 1.3 * (s / 4);
    }),
  },
  {
    name: "boosted broadband noise",
    signal: (() => {
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed / 0x7fffffff) * 2 - 1;
      };
      return fill(() => 1.5 * rnd());
    })(),
  },
  {
    // High-frequency-heavy content (bright spectral painting) — the hardest case
    // for true-peak detection, where a too-short/too-coarse detector under-reads
    // the inter-sample peak and lets it slip to 0 dBFS.
    name: "boosted near-Nyquist noise",
    signal: (() => {
      let seed = 777;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed / 0x7fffffff) * 2 - 1;
      };
      const white = fill(() => rnd());
      // First difference is a crude high-pass, concentrating energy near Nyquist.
      const hp = new Float32Array(SR);
      for (let i = 1; i < SR; i++) hp[i] = 3 * (white[i] - white[i - 1]);
      return hp;
    })(),
  },
];

describe("baked true-peak limiter", () => {
  for (const { name, signal } of cases) {
    it(`keeps the inter-sample peak safely under 0 dBFS: ${name}`, () => {
      const peak = measureTruePeak(limit(signal));
      // Must not clip on playback, with real headroom to spare. The -1.5 dBTP
      // ceiling plus an accurate detector keeps even pathological full-scale
      // content near 0.9; a value approaching 1.0 means the detector is
      // under-reading again (the "crackle near max" regression).
      expect(peak).toBeLessThan(0.95);
    });
  }

  it("does not reduce gain on signals already below the ceiling", () => {
    const quiet = fill((i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const out = limit(quiet);
    let maxAbs = 0;
    for (const v of out) maxAbs = Math.max(maxAbs, Math.abs(v));
    // Unchanged (within float noise): a quiet signal passes through at unity gain.
    expect(maxAbs).toBeCloseTo(0.5, 3);
  });

  it("applies a smooth gain envelope — no kink clicks at the peaks it catches", () => {
    // A tremolo tone boosted well over the ceiling: the limiter engages on every
    // crest, so its gain envelope ramps up and down constantly. If those ramps meet
    // at sharp corners (piecewise-linear kinks), multiplying the audio by them
    // injects a broadband click at each crest — the "soft crackle at the clip
    // points". The gain envelope must be smooth enough that this artifact stays
    // inaudible.
    const input = fill((i) => {
      const trem = 0.6 + 0.4 * Math.sin((2 * Math.PI * 7 * i) / SR);
      return 3.0 * trem * Math.sin((2 * Math.PI * 500 * i) / SR);
    });
    const out = limit(input);

    // Recover the gain the limiter applied, then compare it to a lightly smoothed
    // copy of itself. The residual (what smoothing removes) is exactly the kink
    // content; scaled by the signal it is the injected click. A smooth envelope
    // leaves almost nothing behind.
    const N = input.length;
    const gain = new Float32Array(N);
    for (let i = 0; i < N; i++) gain[i] = Math.abs(input[i]) > 1e-4 ? out[i] / input[i] : i > 0 ? gain[i - 1] : 1;

    const sigma = 6;
    const radius = sigma * 3;
    const kernel: number[] = [];
    let ksum = 0;
    for (let t = -radius; t <= radius; t++) {
      const w = Math.exp((-t * t) / (2 * sigma * sigma));
      kernel.push(w);
      ksum += w;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

    let artifact = 0;
    for (let i = radius; i < N - radius; i++) {
      let smoothed = 0;
      for (let t = -radius; t <= radius; t++) smoothed += gain[i + t] * kernel[t + radius];
      artifact = Math.max(artifact, Math.abs(input[i] * (gain[i] - smoothed)));
    }
    // Before the gain-envelope smoothing this artifact was ~-31 dBFS (audible); the
    // smoothed envelope keeps it well below -45 dBFS.
    expect(20 * Math.log10(artifact)).toBeLessThan(-45);
  });
});
