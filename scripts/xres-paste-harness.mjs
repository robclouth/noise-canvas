// Calibration harness for the cross-resolution paste resampler in
// effect-common.glsl (the XRES_* constants). Run with: node scripts/xres-paste-harness.mjs
// after `npx node-gyp rebuild`. pasteInto() must mirror the shader's
// getTransformedSampleNeutral cross-resolution branch exactly, or the numbers
// mean nothing.
//
// Pipeline per test signal:
//   1. analyse at SRC_BPO (the source file)
//   2. run the shader's default paste on the CPU into a DEST_BPO layout
//   3. synthesize the pasted canvas through the addon
//   4. re-analyse the synthesized audio at DEST_BPO
//   5. compare against the direct DEST_BPO analysis of the original audio
//
// Controls: the direct DEST_BPO round trip (analysis→synthesis with no paste),
// and a same-resolution paste (DEST→DEST through the same CPU paste code),
// which validates the CPU mirror of the shader.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("../build/Release/gaborator_addon.node");

const SR = 48000;
const DUR = 2.0;
const N = Math.round(SR * DUR);
const MIN_FREQ = 27.5;
const SRC_BPO = 12;
const DEST_BPO = 60;
const TWO_PI = Math.PI * 2;

function makeTone(freq, amp = 0.4) {
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = amp * Math.sin((TWO_PI * freq * i) / SR);
  return sig;
}

function makeNoise(amp = 0.2, seedInit = 987654321) {
  const sig = new Float32Array(N);
  let seed = seedInit;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    sig[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return sig;
}

function bandFreq(analysis, band) {
  return analysis.metadata[band * 4 + 3];
}

// Shader mirror: interpolateComplex (log-mag blend, shortest-arc phase).
function interpolateComplex(m1, p1, m2, p2, amount) {
  const mag = Math.exp((1 - amount) * Math.log(m1 + 1e-9) + amount * Math.log(m2 + 1e-9));
  const dd = ((((p2 - p1 + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  return [mag, p1 + amount * dd];
}

// Read source band j at an absolute frame, matching sampleSourceInterp:
// scaledTime = frame / 2^step, clamped interp between adjacent bins.
function readSource(analysis, j, frame, chOffset) {
  const step = analysis.bandStepLog2s[j];
  const len = analysis.bandLengths[j];
  const off = analysis.bandOffsets[j];
  const scaled = frame / (1 << step);
  const t = Math.min(Math.max(scaled, 0), len - 1);
  const i0 = Math.floor(t);
  const frac = t - i0;
  const i1 = Math.min(i0 + 1, len - 1);
  const b0 = (off + i0) * 4 + chOffset;
  const b1 = (off + i1) * 4 + chOffset;
  return interpolateComplex(analysis.data[b0], analysis.data[b0 + 1], analysis.data[b1], analysis.data[b1 + 1], frac);
}

// Tuning constants for the cross-resolution resampler.
const TONAL_ATTEN_COEFF = 1.0; // exp(-c * offsetInDestBands^2)
const D2_SPREAD = 0.012;
const DEV_UNDO_CAP = 1.5;
const PEAK_LO_UP = 0.2;
const NOISE_MAKEUP = 1.65;
const PEAK_HI_UP = 0.7;
const PEAK_LO_DOWN = 0.3;
const PEAK_HI_DOWN = 0.7;
const STATS = { up: [], down: [] };

function smoothstep(lo, hi, x) {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

function statLine(arr) {
  if (!arr.length) return "n/a";
  const sorted = [...arr].sort((a, b) => a - b);
  const q = (f) => sorted[Math.floor(f * (sorted.length - 1))].toFixed(3);
  return `p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}`;
}

// Tonality from the mean |second difference| of the band's stored phase over
// its own grid. A tone scores ~1 at any resolution; band-limited noise
// wanders and scores low.
function tonalityAt(analysis, jFromTop, binIndex, chOffset) {
  const off = analysis.bandOffsets[jFromTop];
  const len = analysis.bandLengths[jFromTop];
  const phases = [];
  for (let i = 0; i < 5; i++) {
    const idx = Math.min(Math.max(binIndex - i, 0), len - 1);
    phases.push(analysis.data[(off + idx) * 4 + chOffset + 1]);
  }
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const d = phases[i] - 2 * phases[i + 1] + phases[i + 2];
    const wrapped = ((((d + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
    total += Math.abs(wrapped);
  }
  const mean = total / 3;
  // Absolute scale: a tone's second difference is numerically ~0; band-limited
  // noise wanders by >= ~0.03 rad per bin pair. The ulp term keeps very long
  // unwrapped phases (float32 quantisation ~ |phi|*1e-7 per read) from
  // misreading a tone as noise; it fails toward "tonal", the milder path.
  const centre = analysis.data[(off + Math.min(Math.max(binIndex, 0), len - 1)) * 4 + chOffset + 1];
  const spread = Math.max(D2_SPREAD, Math.abs(centre) * 4e-6);
  LAST_D2 = mean;
  return Math.exp(-(mean * mean) / (spread * spread));
}
let LAST_D2 = 0;

function hashRandom(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function wrapPi(p) {
  return ((((p + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

// Mirror of attractDevHz: two-sided central difference of the band's phase
// over its own grid, in Hz. Caller clamps to ±6% of the centre.
function devHzAt(analysis, jFromTop, binIndex, chOffset, sampleRate) {
  const off = analysis.bandOffsets[jFromTop];
  const len = analysis.bandLengths[jFromTop];
  const step = analysis.bandStepLog2s[jFromTop];
  const dtSec = (1 << step) / sampleRate;
  const i0 = Math.min(Math.max(binIndex - 1, 0), len - 1);
  const i1 = Math.min(Math.max(binIndex, 0), len - 1);
  const i2 = Math.min(Math.max(binIndex + 1, 0), len - 1);
  const p0 = analysis.data[(off + i0) * 4 + chOffset + 1];
  const p1 = analysis.data[(off + i1) * 4 + chOffset + 1];
  const p2 = analysis.data[(off + i2) * 4 + chOffset + 1];
  return ((wrapPi(p1 - p0) + wrapPi(p2 - p1)) * 0.5) / (TWO_PI * dtSec);
}

// CPU mirror of the shader's default paste: freq-preserving map, nearest source
// band, intended-ratio scaling + additive carrier re-anchor. When resample is
// true, adds the cross-resolution rule under test:
//   upsampling (dest finer): tonal duplicates attenuate by the dest atom
//   response, noise splits energy and decorrelates;
//   downsampling (dest coarser): tonal takes the loudest covered band, noise
//   sums covered energy.
function pasteInto(destAnalysis, srcAnalysis, resample) {
  const out = new Float32Array(destAnalysis.data.length);
  const destBands = destAnalysis.numBands;
  const srcBands = srcAnalysis.numBands;
  const srcLowest = bandFreq(srcAnalysis, srcBands - 1);
  const srcBpo = SRC_BPO_OF(srcAnalysis);
  const destBpo = SRC_BPO_OF(destAnalysis);
  const bpoRatio = destBpo / srcBpo;
  const crossBpo = Math.abs(bpoRatio - 1) > 1e-4;
  const destFrames = destAnalysis.numFrames;

  for (let k = 0; k < destBands; k++) {
    const fDest = bandFreq(destAnalysis, k);
    const srcIdxFromBottom = srcBpo * Math.log2(fDest / srcLowest);
    let j = Math.round(srcIdxFromBottom);
    j = Math.min(Math.max(j, 0), srcBands - 1);
    let frac = srcIdxFromBottom - j;
    if (Math.abs(frac) < 1e-3) frac = 0;
    const fSrc = bandFreq(srcAnalysis, srcBands - 1 - j);
    const fIdeal = fSrc * Math.pow(2, frac / srcBpo);
    const R = fDest / fIdeal;
    const mismatchHz = (fDest * (fSrc - fIdeal)) / fIdeal;

    const jFromTop = srcBands - 1 - j;
    const step = destAnalysis.bandStepLog2s[k];
    const len = destAnalysis.bandLengths[k];
    const off = destAnalysis.bandOffsets[k];
    const srcStep = srcAnalysis.bandStepLog2s[jFromTop];
    for (let i = 0; i < len; i++) {
      const frame = i * (1 << step);
      const tSec = (frame / destFrames) * ((destFrames - 1) / SR);
      for (const chOffset of [0, 2]) {
        let [mag, rawPhase] = readSource(srcAnalysis, jFromTop, frame, chOffset);
        let phase = rawPhase * R + TWO_PI * mismatchHz * tSec;

        if (resample && crossBpo) {
          const srcBin = Math.round(frame / (1 << srcStep));
          if (bpoRatio > 1) {
            // Upsampling: each source band feeds ~bpoRatio dest bands.
            // Phase smoothness decides tone vs noise — a tone's skirt in a
            // neighbouring band carries the tone's phase, so tails classify
            // as tonal and follow the measured frequency.
            const p = tonalityAt(srcAnalysis, jFromTop, srcBin, chOffset);
            const s = smoothstep(PEAK_LO_UP, PEAK_HI_UP, p);

            // Tonal part: attenuate by the dest atom response around the
            // MEASURED frequency, keep the re-anchored phase.
            const dev = devHzAt(srcAnalysis, jFromTop, srcBin, chOffset, SR);
            const fTrue = fSrc + Math.min(Math.max(dev, -0.06 * fSrc), 0.06 * fSrc);
            const offsetBands = destBpo * Math.log2(fTrue / fIdeal);
            // The source band's magnitude arrives pre-attenuated by the SOURCE
            // response at the content's distance from that band's centre. Undo
            // it (bounded) before applying the dest response, or a band read
            // through a skirt attenuates twice.
            const devSrcBands = srcBpo * Math.log2(fTrue / fSrc);
            const undo = Math.min(devSrcBands * devSrcBands, DEV_UNDO_CAP);
            const tonalMag2 = Math.exp(-2 * TONAL_ATTEN_COEFF * (offsetBands * offsetBands - undo));

            // Noise part: split the band's energy across the duplicates and
            // synthesize band-limited random phase at the dest band's own
            // rate (linear walk between per-block hashes over the atom
            // support), decorrelated per dest band. The source's wide-band
            // phase fluctuates too fast for the narrow dest atom and cancels.
            const noiseMag2 = (NOISE_MAKEUP * NOISE_MAKEUP) / bpoRatio;
            const blockDur = (0.7 * destBpo) / fDest;
            const tBlocks = tSec / blockDur;
            const b0 = Math.floor(tBlocks);
            const fb = tBlocks - b0;
            const noisePhase =
              TWO_PI *
              ((1 - fb) * hashRandom(k + 0.31, b0 * 0.173 + 0.5) + fb * hashRandom(k + 0.31, (b0 + 1) * 0.173 + 0.5));

            mag *= Math.sqrt(s * tonalMag2 + (1 - s) * noiseMag2);
            const dd = ((((noisePhase - phase + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
            phase = phase + (1 - s) * dd;
            if (STATS && mag > 0.005) STATS.up.push(LAST_D2);
          } else {
            // Downsampling: project the covered fine bands. Tonal content sums
            // amplitudes (coherent, normalised by sqrt(c/pi)); noise sums power.
            const halfSpan = 0.5 / bpoRatio + 3;
            let power = 0;
            let ampSum = 0;
            let maxMag = 0;
            let maxPhase = phase;
            let maxH = 0;
            for (let h = -8; h <= 8; h++) {
              if (Math.abs(h - frac) > halfSpan) continue;
              const jj = Math.min(Math.max(jFromTop - h, 0), srcBands - 1);
              const [m, ph] = readSource(srcAnalysis, jj, frame, chOffset);
              const dCoarse = (h - frac) * bpoRatio;
              const w = Math.exp(-TONAL_ATTEN_COEFF * dCoarse * dCoarse);
              power += w * w * m * m;
              ampSum += w * m;
              if (w * m > maxMag) {
                maxMag = w * m;
                maxPhase = ph;
                maxH = h;
              }
            }
            const p = (maxMag * maxMag) / (power + 1e-20);
            const s = smoothstep(PEAK_LO_DOWN, PEAK_HI_DOWN, p);
            const tonal = Math.sqrt(TONAL_ATTEN_COEFF / Math.PI) * ampSum;
            const noise = Math.sqrt(power);
            mag = Math.sqrt(s * tonal * tonal + (1 - s) * noise * noise);
            // Phase from the LOUDEST covered tap, rebased to this band's
            // carrier — the nearest tap can be silent, and magnitude written
            // with junk phase cancels in the synthesis.
            const jjMax = Math.min(Math.max(jFromTop - maxH, 0), srcBands - 1);
            const fMax = bandFreq(srcAnalysis, jjMax);
            phase = maxPhase * R + TWO_PI * ((fDest * (fMax - fIdeal)) / fIdeal) * tSec;
            if (STATS) STATS.down.push(p);
          }
        }

        const base = (off + i) * 4 + chOffset;
        out[base] = mag;
        out[base + 1] = phase;
      }
    }
  }
  return out;
}

const bpoBySize = new Map();
function SRC_BPO_OF(analysis) {
  return bpoBySize.get(analysis.numBands);
}

function rms(audio, fromSec = 0.5, toSec = 1.5) {
  const a = Math.round(fromSec * SR);
  const b = Math.round(toSec * SR);
  let s = 0;
  for (let i = a; i < b; i++) s += audio[i] * audio[i];
  return Math.sqrt(s / (b - a));
}

// Goertzel amplitude at freq over the middle second.
function toneAmp(audio, freq) {
  const a = Math.round(0.5 * SR);
  const b = Math.round(1.5 * SR);
  let re = 0;
  let im = 0;
  for (let i = a; i < b; i++) {
    const ph = (TWO_PI * freq * i) / SR;
    re += audio[i] * Math.cos(ph);
    im += audio[i] * Math.sin(ph);
  }
  const n = b - a;
  return (2 * Math.hypot(re, im)) / n;
}

// Per-band mean magnitude over the middle half, for profile printing.
function bandProfile(analysis, bandFrom, bandTo) {
  const prof = [];
  for (let b = bandFrom; b < bandTo; b++) {
    const len = analysis.bandLengths[b];
    const off = analysis.bandOffsets[b];
    let s = 0;
    const a = Math.floor(len * 0.25);
    const z = Math.floor(len * 0.75);
    for (let i = a; i < z; i++) s += analysis.data[(off + i) * 4];
    prof.push(s / (z - a));
  }
  return prof;
}

function nearestBand(analysis, freq) {
  let best = 0;
  let bestD = Infinity;
  for (let b = 0; b < analysis.numBands; b++) {
    const d = Math.abs(Math.log2(bandFreq(analysis, b) / freq));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

async function run() {
  const P_SRC = { bandsPerOctave: SRC_BPO, minFreq: MIN_FREQ };
  const P_DEST = { bandsPerOctave: DEST_BPO, minFreq: MIN_FREQ };

  for (const [label, audio, toneFreq] of [
    ["TONE 1000 Hz (0.2 src bands off-centre)", makeTone(1000), 1000],
    ["TONE 1017 Hz (0.5 src bands off-centre)", makeTone(1017), 1017],
    ["WHITE NOISE", makeNoise(), null],
  ]) {
    STATS.up.length = 0;
    STATS.down.length = 0;
    console.log(`\n=== ${label} ===`);
    const a12 = await addon.analyze([audio, audio], 2, SR, P_SRC);
    const a60 = await addon.analyze([audio, audio], 2, SR, P_DEST);
    bpoBySize.set(a12.numBands, SRC_BPO);
    bpoBySize.set(a60.numBands, DEST_BPO);

    const direct60 = (await addon.synthesize(a60.data, a60, SR, P_DEST, false, [])).channels[0];
    const direct12 = (await addon.synthesize(a12.data, a12, SR, P_SRC, false, [])).channels[0];
    console.log(
      `controls: RMS original=${rms(audio).toFixed(4)}  direct60=${rms(direct60).toFixed(4)}  direct12=${rms(direct12).toFixed(4)}` +
        (toneFreq ? `  | tone direct12=${toneAmp(direct12, toneFreq).toFixed(4)}` : ""),
    );

    for (const mode of [0, 1, 2]) {
      const modeName = ["off", "centre", "measured"][mode];
      const up = pasteInto(a60, a12, mode);
      const upSynth = (await addon.synthesize(up, a60, SR, P_DEST, false, [])).channels[0];
      const down = pasteInto(a12, a60, mode);
      const downSynth = (await addon.synthesize(down, a12, SR, P_SRC, false, [])).channels[0];

      let line = `mode=${modeName.padEnd(8)} 12→60: RMS=${rms(upSynth).toFixed(4)}`;
      if (toneFreq) line += ` tone=${toneAmp(upSynth, toneFreq).toFixed(4)}`;
      line += `   60→12: RMS=${rms(downSynth).toFixed(4)}`;
      if (toneFreq) line += ` tone=${toneAmp(downSynth, toneFreq).toFixed(4)}`;
      console.log(line);

      if (toneFreq) {
        const reUp = await addon.analyze([upSynth, upSynth], 2, SR, P_DEST);
        const c = nearestBand(a60, toneFreq);
        const direct = bandProfile(a60, c - 12, c + 13);
        const cross = bandProfile(reUp, c - 12, c + 13);
        const fmt = (arr) => arr.map((v) => (v >= 0.005 ? v.toFixed(3).slice(1) : "  . ")).join(" ");
        if (mode === 0) console.log(`   direct60 profile: ${fmt(direct)}`);
        console.log(`   12→60 re-profile: ${fmt(cross)}`);
      }
    }
    console.log(`   peakiness stats: up ${statLine(STATS.up)} | down ${statLine(STATS.down)}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
