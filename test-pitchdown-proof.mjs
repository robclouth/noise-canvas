/**
 * pitchdown-proof.mjs
 *
 * Proves (or disproves) transient preservation strategies for vertical
 * translation (pitch shift down) in the Gaborator coefficient domain,
 * using the real analysis/synthesis addon — no shader, pure audio.
 *
 * Pipeline:
 *   impulse → analyze → band-mask to [4k,16k] → resynth  = "click" (thin hat)
 *   ground truth: same impulse masked to [500,2000]      = ideal 3-oct-down click
 *   algorithms: shift coefficients down 3 octaves with different phase rules,
 *   resynthesize, measure sharpness vs ground truth, export WAVs.
 *
 * Run: node pitchdown-proof.mjs
 */

import { createRequire } from "module";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";

const PROJECT = "/Users/rob/Documents/Projects/Music/Tools/noise-canvas";
const OUT_DIR = new URL("./test-audio/pitchdown-proof/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const require = createRequire(import.meta.url);
const addon = require(resolve(PROJECT, "build/Release/gaborator_addon.node"));

const SR = 48000;
const BPO = 36; // app default "Balanced"
const MIN_FREQ = 27.5;
const TWO_PI = 2 * Math.PI;
const FPIX = 4; // [magL, phaseL, magR, phaseR]

const DURATION_S = 2.0;
const IMPULSE_T = 0.5;

const SHIFT_OCTAVES = 3;
const SHIFT_BANDS = SHIFT_OCTAVES * BPO;

// Band mask ranges (Hz)
const HI_LO = 4000,
  HI_HI = 16000;
const GT_LO = HI_LO / 2 ** SHIFT_OCTAVES,
  GT_HI = HI_HI / 2 ** SHIFT_OCTAVES;

// ─── Signal builders ─────────────────────────────────────────────────────────

function makeImpulse(tSec = IMPULSE_T) {
  const n = Math.round(DURATION_S * SR);
  const x = new Float32Array(n);
  x[Math.round(tSec * SR)] = 1;
  return x;
}

// Worst case for a 1ms-binned onset detector: the impulse sits mid-bin,
// ~0.5ms from any bin edge. Sample 24025 = 500.5208ms.
const OFFGRID_T = 24025 / SR;

function makeNoiseHat(decayS = 0.08) {
  const n = Math.round(DURATION_S * SR);
  const x = new Float32Array(n);
  const start = Math.round(IMPULSE_T * SR);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x40000000 - 1;
  };
  for (let i = start; i < n; i++) {
    const t = (i - start) / SR;
    x[i] = rand() * Math.exp(-t / decayS);
  }
  return x;
}

// ─── Coefficient helpers ─────────────────────────────────────────────────────

async function analyze(signal) {
  return addon.analyze([signal], 1, SR, { bandsPerOctave: BPO, minFreq: MIN_FREQ });
}

async function synth(data, ar) {
  const result = await addon.synthesize(data, ar, SR, { bandsPerOctave: BPO, minFreq: MIN_FREQ }, false, []);
  return result.channels[0];
}

// Smooth band mask: keep [loHz, hiHz], raised-cosine rolloff over `edgeBands`.
function bandMask(data, ar, loHz, hiHz, edgeBands = 6) {
  const out = new Float32Array(data.length);
  out.set(data);
  for (let b = 0; b < ar.numBands; b++) {
    const f = ar.bandFreqsHz[b];
    let g;
    if (f >= loHz && f <= hiHz) g = 1;
    else {
      const dOct = f < loHz ? Math.log2(loHz / Math.max(f, 1e-6)) : Math.log2(f / hiHz);
      const dBands = dOct * BPO;
      g = dBands >= edgeBands ? 0 : 0.5 * (1 + Math.cos((Math.PI * dBands) / edgeBands));
    }
    const off = ar.bandOffsets[b],
      len = ar.bandLengths[b];
    for (let k = 0; k < len; k++) {
      out[(off + k) * FPIX + 0] *= g;
      out[(off + k) * FPIX + 2] *= g;
    }
  }
  return out;
}

// Measured per-band peak coefficient magnitude for a unit impulse — gives the
// band normalization empirically so mag moved between bands can be corrected.
function atomPeaks(impulseAr) {
  const peaks = new Float64Array(impulseAr.numBands);
  for (let b = 0; b < impulseAr.numBands; b++) {
    const off = impulseAr.bandOffsets[b],
      len = impulseAr.bandLengths[b];
    let p = 0;
    for (let k = 0; k < len; k++) p = Math.max(p, impulseAr.data[(off + k) * FPIX]);
    peaks[b] = p;
  }
  return peaks;
}

// ─── Onset detection (broadband spectral flux on a 1ms grid) ─────────────────

function detectOnsets(data, ar, { refine = true } = {}) {
  const nBins = Math.ceil((ar.numFrames / SR) * 1000);
  const flux = new Float64Array(nBins);
  const energy = new Float64Array(nBins);
  for (let b = 0; b < ar.numBands; b++) {
    const off = ar.bandOffsets[b],
      len = ar.bandLengths[b];
    const stride = 1 << ar.bandStepLog2s[b];
    for (let k = 0; k < len; k++) {
      const bin = Math.min(nBins - 1, Math.floor(((k * stride) / SR) * 1000));
      const m = data[(off + k) * FPIX];
      energy[bin] += m;
      if (k > 0) {
        const d = m - data[(off + k - 1) * FPIX];
        if (d > 0) flux[bin] += d;
      }
    }
  }
  // Relative flux: increase vs trailing energy. A hit out of silence scores
  // high; amplitude wobble inside a decaying tail scores low.
  const TRAIL_MS = 40;
  const rel = new Float64Array(nBins);
  let trail = 0;
  const alpha = 1 / TRAIL_MS;
  let globalMean = 0;
  for (const v of energy) globalMean += v;
  globalMean /= nBins;
  const eps = globalMean * 0.05 + 1e-9;
  for (let i = 0; i < nBins; i++) {
    rel[i] = flux[i] / (trail + eps);
    trail += alpha * (energy[i] - trail);
  }
  const onsets = [];
  const maxRel = Math.max(...rel);
  const maxFlux = Math.max(...flux);
  for (let i = 1; i < nBins - 1; i++) {
    if (rel[i] > rel[i - 1] && rel[i] >= rel[i + 1] && rel[i] > maxRel * 0.25 && flux[i] > maxFlux * 0.05) {
      if (onsets.length && i / 1000 - onsets[onsets.length - 1].t < 0.05) continue;
      // Flux peaks on the rising edge, before the ridge centre. Refine to the
      // energy peak within the next few ms so the lock anchor sits on the ridge.
      let bestBin = i,
        bestE = energy[i];
      for (let j = i; j < Math.min(nBins, i + 9); j++) {
        if (energy[j] > bestE) {
          bestE = energy[j];
          bestBin = j;
        }
      }
      // Sub-bin refinement: parabolic vertex through the energy peak and its
      // neighbours. T error ε displaces the transported click by (α−1)·ε, so
      // bin-edge quantization (±0.5ms) costs several ms at 3-octave shifts.
      let t;
      if (refine) {
        const eL = bestBin > 0 ? energy[bestBin - 1] : 0;
        const eR = bestBin < nBins - 1 ? energy[bestBin + 1] : 0;
        const denom = eL - 2 * bestE + eR;
        const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (eL - eR)) / denom)) : 0;
        t = (bestBin + 0.5 + delta) / 1000;
      } else {
        t = bestBin / 1000;
      }
      onsets.push({ t, strength: Math.min(1, rel[i] / (maxRel * 0.5)) });
    }
  }
  return onsets;
}

// ─── The vertical shift ──────────────────────────────────────────────────────
//
// Dest band b reads source band b - SHIFT_BANDS (content moves DOWN: dest freq
// = src freq / 8). Coefficient k of band b sits at frame time k * 2^stepLog2.
// phaseRule(ctx) → phase for the dest coefficient. ctx has everything.

// How tonal the source is at a coefficient, mirroring sourceTonality in
// effect-common.glsl: the second difference of unwrapped phase is near zero for
// a steady partial and scattered across the circle for noise.
const TONALITY_SPREAD = 0.6;

function tonality(data, bandOffset, k) {
  const phaseAt = (j) => data[(bandOffset + Math.max(0, k - j)) * FPIX + 1];
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const d = phaseAt(i) - 2 * phaseAt(i + 1) + phaseAt(i + 2);
    total += Math.abs(((((d + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI);
  }
  const mean = total / 3;
  return Math.exp(-(mean * mean) / (TONALITY_SPREAD * TONALITY_SPREAD));
}

function shiftDown(data, ar, peaks, phaseRule, opts = {}) {
  const out = new Float32Array(data.length); // silence outside written bands
  const rand = mulberry32(98765);
  for (let bDest = 0; bDest < ar.numBands; bDest++) {
    const bSrc = bDest - SHIFT_BANDS;
    if (bSrc < 0 || bSrc >= ar.numBands) continue;
    const fDest = ar.bandFreqsHz[bDest];
    const fSrc = ar.bandFreqsHz[bSrc];
    if (fDest <= 0 || fSrc <= 0) continue; // skip DC band
    const offD = ar.bandOffsets[bDest],
      lenD = ar.bandLengths[bDest];
    const offS = ar.bandOffsets[bSrc],
      lenS = ar.bandLengths[bSrc];
    const strideD = 1 << ar.bandStepLog2s[bDest];
    const strideS = 1 << ar.bandStepLog2s[bSrc];
    const gain = opts.magCorrect ? peaks[bDest] / Math.max(peaks[bSrc], 1e-12) : 1;
    for (let k = 0; k < lenD; k++) {
      const tSec = (k * strideD) / SR;
      // same absolute time in the source band's grid (exact for dyadic ratios)
      const kSrcF = (tSec * SR) / strideS;
      const k0 = Math.floor(kSrcF);
      if (k0 < 0 || k0 >= lenS) continue;
      const frac = kSrcF - k0;
      const i0 = (offS + Math.min(k0, lenS - 1)) * FPIX;
      const i1 = (offS + Math.min(k0 + 1, lenS - 1)) * FPIX;
      const mag = (data[i0] * (1 - frac) + data[i1] * frac) * gain;
      if (mag <= 0) continue;
      const srcPhase = data[i0 + 1];
      const phase = phaseRule({
        mag,
        srcPhase,
        fDest,
        fSrc,
        tSec,
        bDest,
        rand,
        tonality: tonality(data, offS, Math.min(k0, lenS - 1)),
      });
      const iD = (offD + k) * FPIX;
      out[iD + 0] = mag;
      out[iD + 1] = phase;
      out[iD + 2] = mag;
      out[iD + 3] = phase;
    }
  }
  return out;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Phase rules ─────────────────────────────────────────────────────────────

const ruleCopy = (ctx) => ctx.srcPhase;

// Current shader "Neutral": scale unwrapped phase by freq ratio
const ruleScale = (ctx) => ctx.srcPhase * (ctx.fDest / ctx.fSrc);

// App-like: Neutral then blended 95% toward the (empty) canvas phase = 0
const ruleScaleBlend = (ctx) => ctx.srcPhase * (ctx.fDest / ctx.fSrc) * 0.05;

const ruleRandom = (ctx) => ctx.rand() * TWO_PI;

// Onset lock: within Gaussian support of the nearest onset, pull toward the
// impulse relation φ = −2π·f·T; elsewhere randomized. Blend in complex domain.
function makeOnsetLock(onsets, { supportGain = 0.7, sigmaFloor = 0.002 } = {}) {
  return (ctx) => {
    let best = 0,
      bestT = 0;
    for (const o of onsets) {
      // Window matched to the SOURCE band's support: that is the width of the
      // attack ridge in the copied-down data. Using the dest support would
      // lock tail noise into a coherent spike.
      const sigma = Math.max((BPO * supportGain) / ctx.fSrc, sigmaFloor);
      const d = (ctx.tSec - o.t) / sigma;
      const w = o.strength * Math.exp(-d * d);
      if (w > best) {
        best = w;
        bestT = o.t;
      }
    }
    const lockPhase = -TWO_PI * ctx.fDest * bestT;
    const randPhase = ctx.rand() * TWO_PI;
    const w = Math.min(best, 1);
    const re = w * Math.cos(lockPhase) + (1 - w) * Math.cos(randPhase);
    const im = w * Math.sin(lockPhase) + (1 - w) * Math.sin(randPhase);
    return Math.atan2(im, re);
  };
}

// Onset transport: near an onset, re-anchor the source's phase DEVIATION from
// the impulse relation at the new frequency: φ = −2π·f_dest·T + (φ_src + 2π·f_src·T).
// A coherent click stays coherent, a noisy attack stays noisy — the source's own
// transient character is transported instead of an impulse being imposed.
// Purely additive: never multiplies phase, so unwrap ambiguity (2πn) cancels.
function makeOnsetTransport(onsets, { supportGain = 0.7, sigmaFloor = 0.002 } = {}) {
  return (ctx) => {
    let best = 0,
      bestT = 0;
    for (const o of onsets) {
      const sigma = Math.max((BPO * supportGain) / ctx.fSrc, sigmaFloor);
      const d = (ctx.tSec - o.t) / sigma;
      const w = o.strength * Math.exp(-d * d);
      if (w > best) {
        best = w;
        bestT = o.t;
      }
    }
    const lockPhase = -TWO_PI * ctx.fDest * bestT + ctx.srcPhase + TWO_PI * ctx.fSrc * bestT;
    const randPhase = ctx.rand() * TWO_PI;
    const w = Math.min(best, 1);
    const re = w * Math.cos(lockPhase) + (1 - w) * Math.cos(randPhase);
    const im = w * Math.sin(lockPhase) + (1 - w) * Math.sin(randPhase);
    return Math.atan2(im, re);
  };
}

// Hybrid (shader algorithm 6, the default): onset transport where there is an
// onset, the neutral scaled phase everywhere else, blended along the shortest
// arc between them so a sample with no onset comes out exactly as neutral.
function makeHybrid(onsets, { supportGain = 0.7, sigmaFloor = 0.002 } = {}) {
  return (ctx) => {
    let w = 0;
    let bestT = 0;
    for (const o of onsets) {
      const sigma = Math.max((BPO * supportGain) / ctx.fSrc, sigmaFloor);
      const d = (ctx.tSec - o.t) / sigma;
      const weight = o.strength * Math.exp(-d * d);
      if (weight > w) {
        w = weight;
        bestT = o.t;
      }
    }
    w = Math.min(w, 1);
    const neutral = ruleScale(ctx);
    // Away from an onset, noise is re-randomized and tonal content is left on
    // the neutral rule; both blends run along the shortest arc.
    const shortest = (a, b) => ((((a - b + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
    const base = neutral + (1 - ctx.tonality) * shortest(ctx.rand() * TWO_PI, neutral);
    if (w <= 0) return base;
    const lock = -TWO_PI * ctx.fDest * bestT + ctx.srcPhase + TWO_PI * ctx.fSrc * bestT;
    return base + w * shortest(lock, base);
  };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function envelope(x, winMs = 1) {
  const win = Math.max(1, Math.round((winMs / 1000) * SR));
  const env = new Float32Array(Math.ceil(x.length / win));
  for (let i = 0; i < env.length; i++) {
    let m = 0;
    for (let j = i * win; j < Math.min(x.length, (i + 1) * win); j++) m = Math.max(m, Math.abs(x[j]));
    env[i] = m;
  }
  return env;
}

// Shortest window (ms) around the energy peak containing 90% of total energy
function e90ms(x) {
  const e = new Float64Array(x.length);
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    e[i] = x[i] * x[i];
    total += e[i];
  }
  if (total <= 0) return Infinity;
  // cumulative
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + e[i];
  const target = total * 0.9;
  let best = x.length;
  let lo = 0;
  for (let hi = 0; hi < x.length; hi++) {
    while (cum[hi + 1] - cum[lo] >= target) {
      best = Math.min(best, hi - lo + 1);
      lo++;
    }
  }
  return (best / SR) * 1000;
}

function crest(x) {
  let peak = 0,
    sum = 0,
    n = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > 1e-6) {
      peak = Math.max(peak, a);
      sum += a * a;
      n++;
    }
  }
  return n ? peak / Math.sqrt(sum / n) : 0;
}

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0,
    sb = 0,
    sab = 0,
    sa2 = 0,
    sb2 = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
    sab += a[i] * b[i];
    sa2 += a[i] * a[i];
    sb2 += b[i] * b[i];
  }
  const cov = sab - (sa * sb) / n;
  return cov / (Math.sqrt(sa2 - (sa * sa) / n) * Math.sqrt(sb2 - (sb * sb) / n) + 1e-12);
}

// Envelope correlation, maximized over ±maxLag bins so sub-envelope-bin onset
// timing error doesn't tank the score for spike-like signals.
function lagCorr(a, b, maxLag = 10) {
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const n = Math.min(a.length, b.length) - Math.abs(lag);
    let sa = 0,
      sb = 0,
      sab = 0,
      sa2 = 0,
      sb2 = 0;
    for (let i = 0; i < n; i++) {
      const x = a[lag > 0 ? i + lag : i];
      const y = b[lag > 0 ? i : i - lag];
      sa += x;
      sb += y;
      sab += x * y;
      sa2 += x * x;
      sb2 += y * y;
    }
    const cov = sab - (sa * sb) / n;
    const r = cov / (Math.sqrt(sa2 - (sa * sa) / n) * Math.sqrt(sb2 - (sb * sb) / n) + 1e-12);
    best = Math.max(best, r);
  }
  return best;
}

function spectralProfile(data, ar) {
  const p = new Float64Array(ar.numBands);
  for (let b = 0; b < ar.numBands; b++) {
    const off = ar.bandOffsets[b],
      len = ar.bandLengths[b];
    let s = 0;
    for (let k = 0; k < len; k++) s += data[(off + k) * FPIX];
    p[b] = s / len;
  }
  return p;
}

function peakDb(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return 20 * Math.log10(p + 1e-12);
}

function peakTimeMs(x) {
  let p = 0,
    pi = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) {
      p = a;
      pi = i;
    }
  }
  return (pi / SR) * 1000;
}

// Fraction of total energy arriving before onsetSec − 5ms ("whoosh-in")
function preEcho(x, onsetSec) {
  const cut = Math.round((onsetSec - 0.005) * SR);
  let pre = 0,
    total = 0;
  for (let i = 0; i < x.length; i++) {
    const e = x[i] * x[i];
    total += e;
    if (i < cut) pre += e;
  }
  return total > 0 ? pre / total : 0;
}

// ─── WAV writer (16-bit, normalized to −1 dBFS, prints original peak) ────────

function writeWav(name, samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const scale = peak > 0 ? (32767 * 0.891) / peak : 1;
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * scale))), 44 + i * 2);
  }
  writeFileSync(join(OUT_DIR, name), buf);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runCase(label, signal, fileTag, { refine = true, eventT = IMPULSE_T } = {}) {
  console.log(`\n════ ${label} ════`);
  const ar = await analyze(signal);
  console.log(
    `  ${ar.numBands} bands, ${ar.numFrames} frames, band0=${ar.bandFreqsHz[0].toFixed(0)}Hz … band[last]=${ar.bandFreqsHz[ar.numBands - 1].toFixed(1)}Hz`,
  );

  const imp = await analyze(makeImpulse());
  const peaks = atomPeaks(imp);

  // Source material: band-limited to HI range
  const hiData = bandMask(ar.data, ar, HI_LO, HI_HI);
  const hiAudio = await synth(hiData.slice(), ar);
  writeWav(`${fileTag}-1-source-hi.wav`, hiAudio);

  // Ground truth: ideal 3-oct-down = original masked to GT range
  const gtData = bandMask(ar.data, ar, GT_LO, GT_HI);
  const gtAudio = await synth(gtData.slice(), ar);
  writeWav(`${fileTag}-2-groundtruth-down3oct.wav`, gtAudio);
  const gtEnv = envelope(gtAudio);
  const gtProfile = spectralProfile(gtData, ar);
  console.log(
    `  ground truth: E90=${e90ms(gtAudio).toFixed(1)}ms crest=${crest(gtAudio).toFixed(1)} peak=${peakDb(gtAudio).toFixed(1)}dB`,
  );

  const onsets = detectOnsets(hiData, ar, { refine });
  console.log(
    `  onsets detected: ${onsets.map((o) => `${(o.t * 1000).toFixed(2)}ms(s=${o.strength.toFixed(2)})`).join(", ") || "none"}  (true event: ${(eventT * 1000).toFixed(2)}ms, refine=${refine})`,
  );

  // Diagnostic: how atom peak magnitude varies across the 3-octave move
  const bMid = ar.bandFreqsHz.findIndex((f) => f <= 1000);
  console.log(`  mag correction 8kHz→1kHz band: ×${(peaks[bMid] / peaks[bMid - SHIFT_BANDS]).toFixed(3)}`);

  const rules = [
    ["copy", ruleCopy],
    ["scale-neutral", ruleScale],
    ["scale-destblend", ruleScaleBlend],
    ["random", ruleRandom],
    ["onsetlock", makeOnsetLock(onsets)],
    ["onset-transport", makeOnsetTransport(onsets)],
    ["hybrid", makeHybrid(onsets)],
  ];

  const gtPeakMs = peakTimeMs(gtAudio);
  console.log(
    `  ${"rule".padEnd(16)} ${"E90ms".padStart(8)} ${"crest".padStart(7)} ${"envCorr".padStart(8)} ${"specCorr".padStart(9)} ${"preEcho%".padStart(9)} ${"pkΔms".padStart(7)} ${"peakdB".padStart(7)}`,
  );
  let idx = 3;
  for (const [name, rule] of rules) {
    const shifted = shiftDown(ar.data, ar, peaks, rule, { magCorrect: true });
    const audio = await synth(shifted.slice(), ar);
    writeWav(`${fileTag}-${idx}-${name}.wav`, audio);
    idx++;
    const ec = lagCorr(envelope(audio), gtEnv);
    const sc = corr(spectralProfile(shifted, ar), gtProfile);
    const pe = preEcho(audio, eventT);
    const pk = peakTimeMs(audio) - gtPeakMs;
    console.log(
      `  ${name.padEnd(16)} ${e90ms(audio).toFixed(1).padStart(8)} ${crest(audio).toFixed(1).padStart(7)} ${ec.toFixed(3).padStart(8)} ${sc.toFixed(3).padStart(9)} ${(pe * 100).toFixed(2).padStart(9)} ${pk.toFixed(2).padStart(7)} ${peakDb(audio).toFixed(1).padStart(7)}`,
    );
  }
}

// ─── Time-shift experiment: multi-scale grid smear hypothesis ────────────────
//
// Shift a broadband click by a non-dyadic ΔT with the mathematically exact
// carrier correction (φ += 2π·f·ΔT). Any residual smear comes from per-band
// grid interpolation at different strides — the "different analysis scales"
// hypothesis. Then test ridge re-anchoring as the fix.

function timeShift(data, ar, dtSec, mode, onsets) {
  const out = new Float32Array(data.length);
  for (let b = 0; b < ar.numBands; b++) {
    const f = ar.bandFreqsHz[b];
    if (f <= 0) continue;
    const off = ar.bandOffsets[b],
      len = ar.bandLengths[b];
    const stride = 1 << ar.bandStepLog2s[b];
    for (let k = 0; k < len; k++) {
      const tDest = (k * stride) / SR;
      const tSrc = tDest - dtSec;
      const kSrcF = (tSrc * SR) / stride;
      const k0 = Math.floor(kSrcF);
      if (k0 < 0 || k0 + 1 >= len) continue;
      const frac = kSrcF - k0;
      const i0 = (off + k0) * FPIX;
      const i1 = (off + k0 + 1) * FPIX;
      const mag = data[i0] * (1 - frac) + data[i1] * frac;
      if (mag <= 0) continue;
      let phase;
      if (mode === "identity") {
        phase = data[i0 + 1] * (1 - frac) + data[i1 + 1] * frac;
      } else if (mode === "exact") {
        phase = data[i0 + 1] * (1 - frac) + data[i1 + 1] * frac + TWO_PI * f * dtSec;
      } else if (mode === "exact-nnphase") {
        const inn = frac < 0.5 ? i0 : i1;
        phase = data[inn + 1] + TWO_PI * f * dtSec;
      } else if (mode === "relock") {
        phase = data[i0 + 1] * (1 - frac) + data[i1 + 1] * frac + TWO_PI * f * dtSec;
        let best = 0,
          bestT = 0;
        for (const o of onsets) {
          const sigma = Math.max((BPO * 0.7) / f, 0.002);
          const d = (tSrc - o.t) / sigma;
          const w = o.strength * Math.exp(-d * d);
          if (w > best) {
            best = w;
            bestT = o.t;
          }
        }
        if (best > 0) {
          // Deviation measured at the nearest coefficient (no phase interp),
          // re-anchored at the shifted onset time.
          const inn = frac < 0.5 ? i0 : i1;
          const target = -TWO_PI * f * (bestT + dtSec) + data[inn + 1] + TWO_PI * f * bestT;
          const w = Math.min(best, 1);
          const re = w * Math.cos(target) + (1 - w) * Math.cos(phase);
          const im = w * Math.sin(target) + (1 - w) * Math.sin(phase);
          phase = Math.atan2(im, re);
        }
      }
      const iD = (off + k) * FPIX;
      out[iD + 0] = mag;
      out[iD + 1] = phase;
      out[iD + 2] = mag;
      out[iD + 3] = phase;
    }
  }
  return out;
}

async function runTimeShift() {
  const DT = 0.237;
  console.log(`\n════ TIME SHIFT (broadband click 200–16k Hz, ΔT=${DT * 1000}ms, non-dyadic) ════`);
  const ar = await analyze(makeImpulse());
  const clickData = bandMask(ar.data, ar, 200, 16000);
  const clickAudio = await synth(clickData.slice(), ar);
  writeWav("ts-1-source.wav", clickAudio);
  const gt = new Float32Array(clickAudio.length);
  const off = Math.round(DT * SR);
  for (let i = 0; i + off < gt.length; i++) gt[i + off] = clickAudio[i];
  writeWav("ts-2-groundtruth.wav", gt);
  const onsetT = IMPULSE_T + DT;
  console.log(
    `  ground truth: E90=${e90ms(gt).toFixed(1)}ms crest=${crest(gt).toFixed(1)} preEcho=${(preEcho(gt, onsetT) * 100).toFixed(2)}%`,
  );
  const onsets = detectOnsets(clickData, ar);
  const gtEnv = envelope(gt);
  console.log(
    `  ${"mode".padEnd(15)} ${"E90ms".padStart(8)} ${"crest".padStart(7)} ${"envCorr".padStart(8)} ${"preEcho%".padStart(9)} ${"peakdB".padStart(7)}`,
  );
  let idx = 3;
  for (const mode of ["identity", "exact", "exact-nnphase", "relock"]) {
    const shifted = timeShift(clickData, ar, DT, mode, onsets);
    const audio = await synth(shifted.slice(), ar);
    writeWav(`ts-${idx}-${mode}.wav`, audio);
    idx++;
    console.log(
      `  ${mode.padEnd(15)} ${e90ms(audio).toFixed(1).padStart(8)} ${crest(audio).toFixed(1).padStart(7)} ${lagCorr(envelope(audio), gtEnv).toFixed(3).padStart(8)} ${(preEcho(audio, onsetT) * 100).toFixed(2).padStart(9)} ${peakDb(audio).toFixed(1).padStart(7)}`,
    );
  }
}

async function main() {
  await runCase("CLICK (band-limited impulse 4–16 kHz → down 3 oct)", makeImpulse(), "click");
  await runCase(
    "CLICK OFF-GRID (impulse at 500.52ms, mid-bin) — detector WITHOUT sub-bin refinement",
    makeImpulse(OFFGRID_T),
    "clickoffgrid-raw",
    { refine: false, eventT: OFFGRID_T },
  );
  await runCase(
    "CLICK OFF-GRID (impulse at 500.52ms, mid-bin) — detector WITH parabolic refinement",
    makeImpulse(OFFGRID_T),
    "clickoffgrid-refined",
    { refine: true, eventT: OFFGRID_T },
  );
  await runCase("HAT (noise burst 4–16 kHz, 80ms decay → down 3 oct)", makeNoiseHat(), "hat");
  await runTimeShift();
  console.log(`\nWAVs written to: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
