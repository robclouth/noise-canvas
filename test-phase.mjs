/**
 * test-reversal.mjs
 *
 * Tests phase correction strategies for:
 *   1. Partial reversal — brush NOT centred on t=T/2, so BL+BR ≠ 1 (exposes wrong T)
 *   2. Time shift — same chunk moved to three different positions (shift-invariance)
 *   3. Full reversal regression
 *
 * Key insight: for a reversal within [t_start, t_end]:
 *   φ_dest = -φ_src - 2π * f * (t_start + t_end)
 *
 * The "old fix" uses T_total instead of (t_start+t_end), which only works when the
 * brush spans the full file (t_start=0, t_end=T → t_start+t_end = T).
 *
 * Run: node test-reversal.mjs
 */

import { createRequire } from "module";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const addon = require(resolve(__dirname, "build/Release/gaborator_addon.node"));

const BANDS_PER_OCTAVE = 24;
const MIN_FREQ = 27.5;
const TWO_PI = 2 * Math.PI;
const FPIX = 4; // [magL, phaseL, magR, phaseR] per pixel

// ─── WAV loader ───────────────────────────────────────────────────────────────

function loadWav(filePath) {
  const buf = readFileSync(filePath);
  const sampleRate = buf.readUInt32LE(24);
  const numChannels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);

  let dataOffset = 12;
  while (dataOffset < buf.length - 8) {
    const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
    const chunkSize = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === "data") { dataOffset += 8; break; }
    dataOffset += 8 + chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((buf.length - dataOffset) / (bytesPerSample * numChannels));
  const mono = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = dataOffset + (i * numChannels + ch) * bytesPerSample;
      if (bitsPerSample === 16) {
        sum += buf.readInt16LE(offset) / 32768;
      } else if (bitsPerSample === 24) {
        const lo = buf[offset], mid = buf[offset + 1], hi = buf[offset + 2];
        const val = (hi << 16 | mid << 8 | lo) << 8 >> 8;
        sum += val / 8388608;
      } else if (bitsPerSample === 32) {
        sum += buf.readInt32LE(offset) / 2147483648;
      }
    }
    mono[i] = sum / numChannels;
  }

  return { samples: mono, sampleRate };
}

const DRUM_PATH = "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav";

// ─── Metrics ──────────────────────────────────────────────────────────────────

// Computes average magnitude per band — measures spectral shape preservation
function spectralProfile(data, ar) {
  const profile = new Float64Array(ar.bandLengths.length);
  for (let b = 0; b < ar.bandLengths.length; b++) {
    const offset = ar.bandOffsets[b];
    const len = ar.bandLengths[b];
    let sum = 0;
    for (let k = 0; k < len; k++) {
      sum += data[(offset + k) * FPIX]; // mag L
    }
    profile[b] = sum / len;
  }
  return profile;
}

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]; sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const cov = sumAB - sumA * sumB / n;
  const da = Math.sqrt(sumA2 - sumA * sumA / n);
  const db = Math.sqrt(sumB2 - sumB * sumB / n);
  return cov / (da * db + 1e-12);
}

// ─── Time-domain ground truths ────────────────────────────────────────────────

function timeDomainReverse(signal, brushLeft, brushRight) {
  const N = signal.length;
  const start = Math.round(brushLeft * N);
  const end = Math.round(brushRight * N);
  const out = signal.slice();
  for (let i = start; i < end; i++) {
    out[i] = signal[start + (end - 1 - i)];
  }
  return out;
}

function timeDomainShift(signal, srcLeft, srcRight, dstLeft) {
  const N = signal.length;
  const srcStart = Math.round(srcLeft * N);
  const srcEnd = Math.round(srcRight * N);
  const dstStart = Math.round(dstLeft * N);
  const len = srcEnd - srcStart;
  const out = new Float32Array(N);
  for (let i = 0; i < len; i++) {
    const d = dstStart + i;
    if (d >= 0 && d < N) out[d] = signal[srcStart + i];
  }
  return out;
}

// ─── Spectrogram operations ───────────────────────────────────────────────────

/**
 * Reverse frames within [brushLeft, brushRight].
 * phaseTransform(srcPhase, freq, T_total) → dstPhase
 * Using exact brush values avoids rounding errors from frame→UV conversion.
 */
function applyPartialReversal(data, ar, brushLeft, brushRight, phaseTransform) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);
  dest.set(data);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    const kStart = Math.round((brushLeft * (numFrames - 1)) / bandStep);
    const kEnd = Math.round((brushRight * (numFrames - 1)) / bandStep);
    const kS = Math.max(0, kStart);
    const kE = Math.min(len, kEnd);

    for (let k = kS; k < kE; k++) {
      const srcK = kStart + kEnd - k;
      if (srcK < 0 || srcK >= len) continue;

      const srcIdx = (offset + srcK) * FPIX;
      const dstIdx = (offset + k) * FPIX;

      dest[dstIdx + 0] = data[srcIdx + 0];
      dest[dstIdx + 2] = data[srcIdx + 2];
      dest[dstIdx + 1] = phaseTransform(data[srcIdx + 1], freq, T_total);
      dest[dstIdx + 3] = phaseTransform(data[srcIdx + 3], freq, T_total);
    }
  }
  return dest;
}

/**
 * Shift [srcLeft, srcRight] → [dstLeft, dstLeft + chunkWidth]. Zeros elsewhere.
 * phaseTransform(srcPhase, freq, T_total) → dstPhase
 */
function applyTimeShift(data, ar, srcLeft, srcRight, dstLeft, phaseTransform) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    const kSrcStart = Math.round((srcLeft * (numFrames - 1)) / bandStep);
    const kSrcEnd = Math.round((srcRight * (numFrames - 1)) / bandStep);
    const kDstStart = Math.round((dstLeft * (numFrames - 1)) / bandStep);
    const chunkLen = kSrcEnd - kSrcStart;

    for (let i = 0; i < chunkLen; i++) {
      const srcK = kSrcStart + i;
      const dstK = kDstStart + i;
      if (srcK < 0 || srcK >= len) continue;
      if (dstK < 0 || dstK >= len) continue;

      const srcIdx = (offset + srcK) * FPIX;
      const dstIdx = (offset + dstK) * FPIX;

      dest[dstIdx + 0] = data[srcIdx + 0];
      dest[dstIdx + 2] = data[srcIdx + 2];
      dest[dstIdx + 1] = phaseTransform(data[srcIdx + 1], freq, T_total);
      dest[dstIdx + 3] = phaseTransform(data[srcIdx + 3], freq, T_total);
    }
  }
  return dest;
}

async function synthesize(modData, ar, sampleRate) {
  const result = await addon.synthesize(
    modData, ar, sampleRate,
    { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ },
    false, []
  );
  return result.channels[0];
}

// ─── WAV writer ───────────────────────────────────────────────────────────────

function writeWav(filename, samples, sampleRate) {
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
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const scale = peak > 0 ? 32767 / peak : 1;
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * scale))), 44 + i * 2);
  }
  writeFileSync(filename, buf);
}

// ─── Phase strategies ─────────────────────────────────────────────────────────
//
// The correct formula for reversal within [brushLeft, brushRight]:
//   φ_dest = -φ_src - 2π * f * (brushLeft + brushRight) * T_total
//
// The correct formula for a time shift from srcLeft to dstLeft:
//   φ_dest = φ_src + 2π * f * (srcLeft - dstLeft) * T_total
//
// The "old fix" uses T_total directly (equivalent to brushLeft=0, brushRight=1).
// It's only correct when the brush spans the ENTIRE file.

const phaseIdentity = (p) => p;
const phaseNegate = (p) => -p;
const phaseOldFix = (p, f, T) => -p - TWO_PI * f * T;

// Correct reversal using exact brush boundaries
const makeReversalPhase = (brushLeft, brushRight) =>
  (p, f, T) => -p - TWO_PI * f * (brushLeft + brushRight) * T;

// Correct shift using exact source/dest positions
const makeShiftPhase = (srcLeft, dstLeft) =>
  (p, f, T) => p + TWO_PI * f * (srcLeft - dstLeft) * T;

// ─── Rubberband reference ────────────────────────────────────────────────────

function rubberbandStretch(inputPath, outputPath, timeRatio, pitchSemitones = 0) {
  let cmd = `rubberband -t ${timeRatio}`;
  if (pitchSemitones !== 0) cmd += ` -p ${pitchSemitones}`;
  cmd += ` "${inputPath}" "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });
  return loadWav(outputPath);
}

// ─── Spectrogram time stretch ────────────────────────────────────────────────
//
// Stretches the spectrogram by scaleX (e.g. 2.0 = twice as long).
// For each destination frame k_dst, the source frame is k_dst / scaleX.
// We use nearest-neighbour sampling for simplicity.
// phaseTransform(srcPhase, freq, srcUv, dstUv, T_total) → dstPhase

// Pitch shift: move each band's data to the band at freq × freqRatio
// phaseTransformFn(srcPhase, srcFreqHz, dstFreqHz, time) → dstPhase
function applyPitchShift(data, ar, freqRatio, phaseTransformFn) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  // Build a mapping: for each destination band, find the source band
  for (let bDst = 0; bDst < bandLengths.length; bDst++) {
    const dstFreq = bandFreqsHz[bDst];
    const srcFreq = dstFreq / freqRatio; // what source frequency maps here

    // Find closest source band
    let bSrc = 0;
    for (let i = 1; i < bandFreqsHz.length; i++) {
      if (Math.abs(bandFreqsHz[i] - srcFreq) < Math.abs(bandFreqsHz[bSrc] - srcFreq)) bSrc = i;
    }

    const srcOffset = bandOffsets[bSrc];
    const srcLen = bandLengths[bSrc];
    const srcStep = 1 << bandStepLog2s[bSrc];
    const srcFreqActual = bandFreqsHz[bSrc];

    const dstOffset = bandOffsets[bDst];
    const dstLen = bandLengths[bDst];
    const dstStep = 1 << bandStepLog2s[bDst];

    for (let kDst = 0; kDst < dstLen; kDst++) {
      // Map destination frame to source frame (same time position)
      const dstTime = (kDst * dstStep) / (numFrames - 1); // UV 0-1
      const srcKFloat = (dstTime * (numFrames - 1)) / srcStep;
      const srcK0 = Math.floor(srcKFloat);
      const srcK1 = Math.min(srcK0 + 1, srcLen - 1);
      const frac = srcKFloat - srcK0;

      if (srcK0 < 0 || srcK0 >= srcLen) continue;

      const idx0 = (srcOffset + srcK0) * FPIX;
      const idx1 = (srcOffset + srcK1) * FPIX;
      const dstIdx = (dstOffset + kDst) * FPIX;

      // Interpolate magnitude
      dest[dstIdx + 0] = data[idx0 + 0] * (1 - frac) + data[idx1 + 0] * frac;
      dest[dstIdx + 2] = data[idx0 + 2] * (1 - frac) + data[idx1 + 2] * frac;

      // Interpolate phase
      const srcPhaseL = data[idx0 + 1] * (1 - frac) + data[idx1 + 1] * frac;
      const srcPhaseR = data[idx0 + 3] * (1 - frac) + data[idx1 + 3] * frac;

      const t = dstTime * T_total;
      dest[dstIdx + 1] = phaseTransformFn(srcPhaseL, srcFreqActual, dstFreq, t);
      dest[dstIdx + 3] = phaseTransformFn(srcPhaseR, srcFreqActual, dstFreq, t);
    }
  }
  return dest;
}

// Shift a spectral profile by N bands (for comparing pitch-shifted output)
function shiftProfile(profile, shiftBands) {
  const shifted = new Float64Array(profile.length);
  for (let i = 0; i < profile.length; i++) {
    const srcI = i - shiftBands;
    if (srcI >= 0 && srcI < profile.length) shifted[i] = profile[srcI];
  }
  return shifted;
}

// Nearest-neighbour stretch with arbitrary phase transform
function applyTimeStretchNN(data, ar, scaleX, phaseTransformFn) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    for (let k = 0; k < len; k++) {
      const srcK = Math.round(k / scaleX);
      if (srcK < 0 || srcK >= len) continue;

      const dstUv = (k * bandStep) / (numFrames - 1);
      const srcUv = (srcK * bandStep) / (numFrames - 1);

      const srcIdx = (offset + srcK) * FPIX;
      const dstIdx = (offset + k) * FPIX;

      dest[dstIdx + 0] = data[srcIdx + 0];
      dest[dstIdx + 2] = data[srcIdx + 2];
      dest[dstIdx + 1] = phaseTransformFn(data[srcIdx + 1], freq, srcUv, dstUv, T_total);
      dest[dstIdx + 3] = phaseTransformFn(data[srcIdx + 3], freq, srcUv, dstUv, T_total);
    }
  }
  return dest;
}

// Linear interpolation stretch with arbitrary phase transform
function applyTimeStretchLerp(data, ar, scaleX, phaseTransformFn) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    for (let k = 0; k < len; k++) {
      const srcKFloat = k / scaleX;
      const srcK0 = Math.floor(srcKFloat);
      const srcK1 = srcK0 + 1;
      const frac = srcKFloat - srcK0;

      if (srcK0 < 0 || srcK1 >= len) continue;

      const idx0 = (offset + srcK0) * FPIX;
      const idx1 = (offset + srcK1) * FPIX;
      const dstIdx = (offset + k) * FPIX;

      // Linearly interpolate magnitude
      dest[dstIdx + 0] = data[idx0 + 0] * (1 - frac) + data[idx1 + 0] * frac;
      dest[dstIdx + 2] = data[idx0 + 2] * (1 - frac) + data[idx1 + 2] * frac;

      // Interpolated source phase and UV
      const srcPhaseL = data[idx0 + 1] * (1 - frac) + data[idx1 + 1] * frac;
      const srcPhaseR = data[idx0 + 3] * (1 - frac) + data[idx1 + 3] * frac;
      const srcUv = (srcKFloat * bandStep) / (numFrames - 1);
      const dstUv = (k * bandStep) / (numFrames - 1);

      dest[dstIdx + 1] = phaseTransformFn(srcPhaseL, freq, srcUv, dstUv, T_total);
      dest[dstIdx + 3] = phaseTransformFn(srcPhaseR, freq, srcUv, dstUv, T_total);
    }
  }
  return dest;
}

// Unified phase correction for any transform (shift, stretch, or both).
//
// The total phase correction decomposes into two parts:
//   1. Band-freq correction for SHIFT: 2π·f_b·shiftOffset·T
//      (where shiftOffset = sourceUv - destUv/scaleX)
//   2. IF correction for STRETCH: dφ/dk × scaleFrameDiff
//      (where scaleFrameDiff = destK × (1 - 1/scaleX))
//
// For pure shift (scaleX=1): only band-freq applies, IF correction is 0
// For pure stretch (no shift): only IF correction applies, band-freq is 0
// For both: both corrections apply
// Unified phase correction: handles shift, stretch, or both, within a specified region.
// srcLeftUv/srcRightUv: source region bounds (UV 0-1)
// dstLeftUv/dstRightUv: destination region bounds (UV 0-1)
// scaleX: stretch factor (destination pixels per source pixel)
function applyUnifiedPhaseCorrection(data, ar, scaleX, srcLeftUv, srcRightUv, dstLeftUv, dstRightUv) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    // Destination frame range
    const kDstStart = Math.max(0, Math.round((dstLeftUv * (numFrames - 1)) / bandStep));
    const kDstEnd = Math.min(len, Math.round((dstRightUv * (numFrames - 1)) / bandStep));

    for (let ch = 0; ch < 2; ch++) {
      const phaseOff = ch === 0 ? 1 : 3;
      const magOff = ch === 0 ? 0 : 2;

      // Pre-compute phase differences
      const dphi = new Float64Array(len);
      for (let k = 0; k < len - 1; k++) {
        const i0 = (offset + k) * FPIX;
        const i1 = (offset + k + 1) * FPIX;
        dphi[k] = data[i1 + phaseOff] - data[i0 + phaseOff];
      }
      dphi[len - 1] = dphi[Math.max(0, len - 2)];

      // Shift correction: band-freq for the constant shift offset
      const shiftConst = srcLeftUv - dstLeftUv / scaleX;
      const bandFreqCorr = TWO_PI * freq * shiftConst * T_total;

      for (let k = kDstStart; k < kDstEnd; k++) {
        const dstUv = (k * bandStep) / (numFrames - 1);

        // Source UV from the transform: brush-relative scaling + offset
        const srcUv = (dstUv - dstLeftUv) / scaleX + srcLeftUv;

        // Bounds check source
        if (srcUv < srcLeftUv - 0.001 || srcUv > srcRightUv + 0.001) continue;

        const srcKFloat = srcUv * (numFrames - 1) / bandStep;
        const srcK0 = Math.floor(srcKFloat);
        const srcK1 = Math.min(srcK0 + 1, len - 1);
        const frac = srcKFloat - srcK0;

        if (srcK0 < 0 || srcK1 >= len) continue;

        const idx0 = (offset + srcK0) * FPIX;
        const idx1 = (offset + srcK1) * FPIX;
        const dstIdx = (offset + k) * FPIX;

        // Interpolate magnitude
        dest[dstIdx + magOff] = data[idx0 + magOff] * (1 - frac) + data[idx1 + magOff] * frac;

        // Interpolate source phase and phase derivative
        const srcPhase = data[idx0 + phaseOff] * (1 - frac) + data[idx1 + phaseOff] * frac;
        const srcDphi = dphi[srcK0] * (1 - frac) + dphi[srcK1] * frac;

        // Stretch correction: IF-based, brush-relative
        const stretchFrames = (dstUv - dstLeftUv) * (1 - 1 / scaleX) * (numFrames - 1) / bandStep;
        const ifCorr = srcDphi * stretchFrames;

        dest[dstIdx + phaseOff] = srcPhase + bandFreqCorr + ifCorr;
      }
    }
  }
  return dest;
}

// IF-corrected stretch: uses instantaneous frequency offset from source phase
// derivative to compute the correct phase at each stretched output frame.
//
// Key insight: for stretching WITHOUT pitch change, the correction should use
// the IF offset (f_actual - f_band), NOT the band center frequency.
// φ_dest(k) = φ_src(k/S) + dφ/dt_src × (k - k/S)
// where dφ/dt is the source phase derivative (= 2π × IF_offset)
function applyTimeStretchIFCorrected(data, ar, scaleX) {
  const { bandOffsets, bandLengths, bandStepLog2s, numFrames, sampleRate } = ar;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const bandStep = 1 << bandStepLog2s[b];

    for (let ch = 0; ch < 2; ch++) {
      const phaseOff = ch === 0 ? 1 : 3;
      const magOff = ch === 0 ? 0 : 2;

      // Pre-compute phase differences between adjacent source frames
      const dphi = new Float64Array(len);
      for (let k = 0; k < len - 1; k++) {
        const i0 = (offset + k) * FPIX;
        const i1 = (offset + k + 1) * FPIX;
        dphi[k] = data[i1 + phaseOff] - data[i0 + phaseOff];
      }
      dphi[len - 1] = dphi[Math.max(0, len - 2)];

      for (let k = 0; k < len; k++) {
        const srcKFloat = k / scaleX;
        const srcK0 = Math.floor(srcKFloat);
        const srcK1 = Math.min(srcK0 + 1, len - 1);
        const frac = srcKFloat - srcK0;

        if (srcK0 < 0 || srcK0 >= len) continue;

        const idx0 = (offset + srcK0) * FPIX;
        const idx1 = (offset + srcK1) * FPIX;
        const dstIdx = (offset + k) * FPIX;

        // Interpolate magnitude
        dest[dstIdx + magOff] = data[idx0 + magOff] * (1 - frac) + data[idx1 + magOff] * frac;

        // Interpolate source phase and phase derivative
        const srcPhase = data[idx0 + phaseOff] * (1 - frac) + data[idx1 + phaseOff] * frac;
        const srcDphi = dphi[srcK0] * (1 - frac) + dphi[srcK1] * frac;

        // Correction: phase should advance by dφ/frame × (k - k/S) extra frames
        // This accounts for the IF offset from the band center
        const extraFrames = k - srcKFloat;
        dest[dstIdx + phaseOff] = srcPhase + srcDphi * extraFrames;
      }
    }
  }
  return dest;
}

// Reverse + stretch with IF correction
// scaleX is the ABSOLUTE scale (positive), reversal is implicit
// Mirrors source frames AND applies IF stretch correction
function applyRevStretchIF(data, ar, absScaleX) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];

    for (let ch = 0; ch < 2; ch++) {
      const phaseOff = ch === 0 ? 1 : 3;
      const magOff = ch === 0 ? 0 : 2;

      // Pre-compute phase differences for IF estimation
      const dphi = new Float64Array(len);
      for (let k = 0; k < len - 1; k++) {
        const i0 = (offset + k) * FPIX;
        const i1 = (offset + k + 1) * FPIX;
        dphi[k] = data[i1 + phaseOff] - data[i0 + phaseOff];
      }
      dphi[len - 1] = dphi[Math.max(0, len - 2)];

      for (let k = 0; k < len; k++) {
        // Reverse + stretch: source is mirrored and compressed
        // For whole-file: srcK = (len-1) - k/absScaleX
        const srcKFloat = (len - 1) - k / absScaleX;
        const srcK0 = Math.floor(srcKFloat);
        const srcK1 = Math.min(srcK0 + 1, len - 1);
        const frac = srcKFloat - srcK0;

        if (srcK0 < 0 || srcK1 >= len) continue;

        const idx0 = (offset + srcK0) * FPIX;
        const idx1 = (offset + srcK1) * FPIX;
        const dstIdx = (offset + k) * FPIX;

        // Interpolate magnitude
        dest[dstIdx + magOff] = data[idx0 + magOff] * (1 - frac) + data[idx1 + magOff] * frac;

        // Interpolate source phase and phase derivative
        const srcPhase = data[idx0 + phaseOff] * (1 - frac) + data[idx1 + phaseOff] * frac;
        const srcDphi = dphi[Math.min(srcK0, len - 2)] * (1 - frac)
                      + dphi[Math.min(srcK1, len - 2)] * frac;

        // UV positions for reversal correction
        const dstUv = (k * bandStep) / (numFrames - 1);
        const srcUv = (srcKFloat * bandStep) / (numFrames - 1);

        // 1. Reversal correction: -φ_src - 2π·f·(srcUv+dstUv)·T
        const revCorr = -TWO_PI * freq * (srcUv + dstUv) * T_total;

        // 2. Stretch correction: (dphi + expectedAdvance) × stretchFrames
        // For reversal, the time-varying part of -2π·f·(srcUv+dstUv) introduces
        // an f_b component that doesn't cancel when |S|≠1
        const dt = bandStep / sampleRate;
        const expectedAdvance = TWO_PI * freq * dt;
        const stretchFrames = dstUv * (1 - 1 / absScaleX) * (numFrames - 1) / bandStep;
        const ifCorr = (srcDphi + expectedAdvance) * stretchFrames;

        dest[dstIdx + phaseOff] = -srcPhase + revCorr + ifCorr;
      }
    }
  }
  return dest;
}

// Phase propagation stretch: estimates instantaneous frequency from source
// phase differences and propagates phase at that rate in the output
function applyTimeStretchPhaseProp(data, ar, scaleX) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const dest = new Float32Array(data.length);

  for (let b = 0; b < bandLengths.length; b++) {
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const freq = bandFreqsHz[b];
    const bandStep = 1 << bandStepLog2s[b];
    const dt = bandStep / sampleRate; // time between adjacent frames in this band

    // For L and R channels
    for (let ch = 0; ch < 2; ch++) {
      const phaseOff = ch === 0 ? 1 : 3;
      const magOff = ch === 0 ? 0 : 2;

      // Pre-compute instantaneous frequency offset for each source frame
      // IF = f_band + dφ_global / (2π · dt)
      const ifOffset = new Float64Array(len);
      for (let k = 0; k < len - 1; k++) {
        const idx0 = (offset + k) * FPIX;
        const idx1 = (offset + k + 1) * FPIX;
        let dphi = data[idx1 + phaseOff] - data[idx0 + phaseOff];
        // Unwrap phase difference to [-π, π]
        dphi = dphi - Math.round(dphi / TWO_PI) * TWO_PI;
        ifOffset[k] = dphi / (TWO_PI * dt);
      }
      ifOffset[len - 1] = ifOffset[Math.max(0, len - 2)];

      // Propagate phase in output
      let prevPhase = 0;
      for (let k = 0; k < len; k++) {
        const srcKFloat = k / scaleX;
        const srcK0 = Math.floor(srcKFloat);
        const srcK1 = Math.min(srcK0 + 1, len - 1);
        const frac = srcKFloat - srcK0;

        if (srcK0 < 0 || srcK0 >= len) continue;

        const idx0 = (offset + srcK0) * FPIX;
        const idx1 = (offset + srcK1) * FPIX;
        const dstIdx = (offset + k) * FPIX;

        // Interpolate magnitude
        dest[dstIdx + magOff] = data[idx0 + magOff] * (1 - frac) + data[idx1 + magOff] * frac;

        if (k === 0) {
          // Seed with source phase at position 0
          prevPhase = data[idx0 + phaseOff];
          dest[dstIdx + phaseOff] = prevPhase;
        } else {
          // Interpolate the IF offset at source position
          const ifOff = ifOffset[srcK0] * (1 - frac) + ifOffset[srcK1] * frac;
          // Total instantaneous frequency
          const totalIF = freq + ifOff;
          // Phase advance for one output frame at this IF
          // In global phase convention, a pure tone at f_band has dφ/dt = 0
          // An off-center component has dφ/dt = 2π · (IF - f_band) = 2π · ifOff
          // Output frame spacing is dt (same as source)
          const phaseAdvance = TWO_PI * ifOff * dt;
          prevPhase += phaseAdvance;
          dest[dstIdx + phaseOff] = prevPhase;
        }
      }
    }
  }
  return dest;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading drum sample...");
  const { samples: signal, sampleRate: SR } = loadWav(DRUM_PATH);
  console.log(`  ${signal.length} samples @ ${SR} Hz  (${(signal.length / SR).toFixed(2)} s)\n`);

  console.log("Analyzing with Gaborator...");
  const ar = await addon.analyze(
    [signal], 1, SR,
    { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ }
  );
  console.log(`  ${ar.numBands} bands, ${ar.numFrames} frames\n`);

  const roundTrip = await synthesize(ar.data.slice(), ar, SR);
  const ceiling = pearsonCorrelation(roundTrip, signal);
  console.log(`Round-trip ceiling: r=${ceiling.toFixed(6)}\n`);

  // ─── TEST 1: Partial reversal with off-centre brush (BL+BR ≠ 1) ─────────────
  //
  // Brush [0.1, 0.4]: BL + BR = 0.5, so t_start + t_end = 0.5 * T_total.
  // Old fix uses T_total (2× too large) — should be clearly wrong.
  // Correct formula uses 0.5 * T_total.
  const BL = 0.1, BR = 0.4;
  console.log(`=== TEST 1: Partial reversal [${BL}, ${BR}]  (BL+BR = ${BL + BR}, not 1.0) ===`);
  console.log(`  Old fix applies 2π·f·T_total but correct is 2π·f·${BL + BR}·T_total\n`);

  const gtPartialRev = timeDomainReverse(signal, BL, BR);

  const reversalStrategies = [
    { name: "identity (no phase change)", fn: phaseIdentity },
    { name: "negate only  (-φ)", fn: phaseNegate },
    { name: "-φ - 2π·f·T_total  [old — only correct for BL+BR=1]", fn: phaseOldFix },
    { name: `-φ - 2π·f·${BL + BR}·T_total  [correct for this brush]`, fn: makeReversalPhase(BL, BR) },
  ];

  for (const s of reversalStrategies) {
    const synth = await synthesize(applyPartialReversal(ar.data, ar, BL, BR, s.fn), ar, SR);
    const r = pearsonCorrelation(synth, gtPartialRev);
    const mark = r > 0.95 ? " ✓✓✓" : r > 0.8 ? " ✓" : "";
    console.log(`  r=${r.toFixed(6)}  ${s.name}${mark}`);
  }

  // ─── TEST 2: Time shift — invariance across positions ────────────────────────
  const SRC_L = 0.25, SRC_R = 0.45;
  const DST_POSITIONS = [0.0, 0.3, 0.6];
  console.log(`\n=== TEST 2: Time shift [${SRC_L}, ${SRC_R}] → three positions ===`);
  console.log("  Correct formula: φ_dest = φ_src + 2π·f·(srcLeft - dstLeft)·T\n");

  const shiftStrategies = [
    { name: "identity (no phase change)", fn: () => phaseIdentity },
    { name: "-φ - 2π·f·T  [reversal formula — wrong for shift]", fn: () => phaseOldFix },
    { name: "φ + 2π·f·(srcLeft - dstLeft)·T  [correct]", fn: (dstL) => makeShiftPhase(SRC_L, dstL) },
  ];

  for (const s of shiftStrategies) {
    const rs = [];
    for (const dstLeft of DST_POSITIONS) {
      const gt = timeDomainShift(signal, SRC_L, SRC_R, dstLeft);
      const synth = await synthesize(applyTimeShift(ar.data, ar, SRC_L, SRC_R, dstLeft, s.fn(dstLeft)), ar, SR);
      rs.push(pearsonCorrelation(synth, gt));
    }
    const variance = Math.max(...rs) - Math.min(...rs);
    const tag = variance < 0.02 ? " ✓ invariant" : " ✗ position-dependent";
    console.log(`  [${rs.map((r) => r.toFixed(4)).join(", ")}]  variance=${variance.toFixed(4)}${tag}  ${s.name}`);
  }

  // ─── TEST 3: Full reversal regression (BL+BR = 1, old fix should match correct) ──
  console.log("\n=== TEST 3: Full reversal [0, 1]  (BL+BR = 1, old fix and correct are equivalent) ===\n");

  const gtFullRev = new Float32Array(signal.slice().reverse());

  const fullRevStrategies = [
    { name: "identity", fn: phaseIdentity },
    { name: "negate only  (-φ)", fn: phaseNegate },
    { name: "-φ - 2π·f·T_total  [old fix]", fn: phaseOldFix },
    { name: "-φ - 2π·f·1.0·T_total  [correct, same as old for full reversal]", fn: makeReversalPhase(0, 1) },
  ];

  for (const s of fullRevStrategies) {
    const synth = await synthesize(applyPartialReversal(ar.data, ar, 0, 1, s.fn), ar, SR);
    const r = pearsonCorrelation(synth, gtFullRev);
    const mark = r > 0.95 ? " ✓✓✓" : r > 0.8 ? " ✓" : "";
    console.log(`  r=${r.toFixed(6)}  ${s.name}${mark}`);
  }

  // ─── TEST 4: Time stretch (2×) — compare against rubberband ─────────────────
  const STRETCH = 2.0;
  console.log(`\n=== TEST 4: Time stretch ${STRETCH}× — rubberband as reference ===\n`);

  const tmpIn = resolve(__dirname, "test-tmp-input.wav");
  const tmpOut = resolve(__dirname, "test-tmp-stretched.wav");
  writeWav(tmpIn, signal, SR);
  const rbStretched = rubberbandStretch(tmpIn, tmpOut, STRETCH);
  console.log(`  Rubberband: ${rbStretched.samples.length} samples (${(rbStretched.samples.length / SR).toFixed(3)} s)`);

  // Also analyze rubberband output with gaborator to get a "ceiling" correlation
  const rbAnalysis = await addon.analyze(
    [rbStretched.samples], 1, SR,
    { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ }
  );
  const rbRoundTrip = await synthesize(rbAnalysis.data.slice(), rbAnalysis, SR);
  const rbCeiling = pearsonCorrelation(rbRoundTrip.slice(0, rbStretched.samples.length), rbStretched.samples);
  console.log(`  Rubberband round-trip ceiling: r=${rbCeiling.toFixed(6)}\n`);

  // Phase transform functions for stretch
  const stretchPhaseIdentity = (p) => p;
  const stretchPhaseNeutralV2 = (p, f, srcUv, dstUv, T) => p + TWO_PI * f * (srcUv - dstUv) * T;

  // Sanity check: 1x stretch should reproduce the original
  {
    const id = (p) => p;
    const data1x = applyTimeStretchNN(ar.data, ar, 1.0, id);
    const synth1x = await synthesize(data1x, ar, SR);
    const r1x = pearsonCorrelation(synth1x, signal);
    console.log(`  Sanity: 1x stretch NN → r=${r1x.toFixed(6)} (should be ~0.999)\n`);
  }

  // Sine wave for sanity checks (hoisted so IF-corrected test can use it)
  const sineFreq = 440;
  const sineDur = 1.0;
  const sineLen = Math.round(sineDur * SR);
  const sineSignal = new Float32Array(sineLen);
  for (let i = 0; i < sineLen; i++) sineSignal[i] = Math.sin(TWO_PI * sineFreq * i / SR);
  const sineAr = await addon.analyze([sineSignal], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });

  {
    console.log("  --- Sine wave sanity check ---");
    const sineStretched = applyTimeStretchNN(sineAr.data, sineAr, STRETCH, (p) => p);
    const sineSynth = await synthesize(sineStretched, sineAr, SR);

    const sineRoundTrip = await synthesize(sineAr.data.slice(), sineAr, SR);
    const rSineRT = pearsonCorrelation(sineRoundTrip, sineSignal);
    const rSineStretch = pearsonCorrelation(sineSynth, sineSignal);
    console.log(`    Sine round-trip: r=${rSineRT.toFixed(6)}`);
    console.log(`    Sine 2x stretch (identity phase): r=${rSineStretch.toFixed(6)}`);
    console.log(`    sineSynth length=${sineSynth.length}, sineSignal length=${sineSignal.length}`);

    // Check: is the stretched data different from original?
    let diffCount = 0, maxDiff = 0;
    for (let i = 0; i < sineAr.data.length; i++) {
      const d = Math.abs(sineStretched[i] - sineAr.data[i]);
      if (d > 1e-10) diffCount++;
      if (d > maxDiff) maxDiff = d;
    }
    console.log(`    Data diff: ${diffCount}/${sineAr.data.length} values differ, maxDiff=${maxDiff.toFixed(8)}`);

    // Check specific band near 440Hz
    let bandIdx = 0;
    for (let i = 1; i < sineAr.bandFreqsHz.length; i++) {
      if (Math.abs(sineAr.bandFreqsHz[i] - 440) < Math.abs(sineAr.bandFreqsHz[bandIdx] - 440)) bandIdx = i;
    }
    if (bandIdx >= 0) {
      const bOff = sineAr.bandOffsets[bandIdx];
      const bLen = sineAr.bandLengths[bandIdx];
      const bStep = 1 << sineAr.bandStepLog2s[bandIdx];
      console.log(`    440Hz band: idx=${bandIdx}, freq=${sineAr.bandFreqsHz[bandIdx].toFixed(1)}, len=${bLen}, step=${bStep}`);
      // Print first few original and stretched values
      for (let k = 0; k < Math.min(5, bLen); k++) {
        const srcK = Math.round(k / STRETCH);
        const oi = (bOff + k) * FPIX;
        const si = (bOff + srcK) * FPIX;
        console.log(`      k=${k} srcK=${srcK}: orig=[${sineAr.data[oi].toFixed(4)}, ${sineAr.data[oi+1].toFixed(4)}] stretched=[${sineStretched[oi].toFixed(4)}, ${sineStretched[oi+1].toFixed(4)}]`);
      }
      // Print last few
      for (let k = bLen - 3; k < bLen; k++) {
        const srcK = Math.round(k / STRETCH);
        const oi = (bOff + k) * FPIX;
        console.log(`      k=${k} srcK=${srcK}: orig=[${sineAr.data[oi].toFixed(4)}, ${sineAr.data[oi+1].toFixed(4)}] stretched=[${sineStretched[oi].toFixed(4)}, ${sineStretched[oi+1].toFixed(4)}]`);
      }
    }
    console.log();
    writeWav("test-out-sine-original.wav", sineSignal, SR);
    writeWav("test-out-sine-stretched.wav", sineSynth, SR);
  }

  // Compute spectral profile of original for comparison
  const origProfile = spectralProfile(ar.data, ar);

  // Helper to evaluate a stretch strategy
  // Key metric: re-analyze the synthesized audio and check if the spectral
  // profile matches the original. Banding = certain bands get cancelled by
  // wrong phases, causing dips/peaks in the re-analyzed spectrum.
  async function evalStretch(name, stretchedData) {
    const synth = await synthesize(stretchedData, ar, SR);
    const minLen = Math.min(synth.length, rbStretched.samples.length);
    const rRB = pearsonCorrelation(synth.slice(0, minLen), rbStretched.samples.slice(0, minLen));

    // Re-analyze to detect phase-induced spectral artifacts
    const reAr = await addon.analyze([synth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const reProfile = spectralProfile(reAr.data, reAr);
    const rReSpec = pearsonCorrelation(reProfile, origProfile);

    const tag = rReSpec > 0.99 ? "✓✓✓" : rReSpec > 0.95 ? "✓✓" : rReSpec > 0.9 ? "✓" : "";
    console.log(`  respec=${rReSpec.toFixed(4)} rb=${rRB.toFixed(4)}  ${name}  ${tag}`);
    const safeName = name.slice(0, 30).replace(/[^a-z0-9]/gi, "_");
    writeWav(`test-out-stretch-${safeName}.wav`, synth, SR);
    return { rRB, rReSpec };
  }

  console.log("  [spec = spectral shape preservation, rb = waveform vs rubberband]\n");

  // 1. NN + identity (current broken state)
  await evalStretch("NN identity phase",
    applyTimeStretchNN(ar.data, ar, STRETCH, stretchPhaseIdentity));

  // 2. NN + Neutral V2 (uses band freq — overcorrects)
  await evalStretch("NN Neutral V2: φ+2π·f·(src-dst)·T",
    applyTimeStretchNN(ar.data, ar, STRETCH, stretchPhaseNeutralV2));

  // 3. Lerp + identity
  await evalStretch("Lerp identity phase",
    applyTimeStretchLerp(ar.data, ar, STRETCH, stretchPhaseIdentity));

  // 4. Lerp + Neutral V2
  await evalStretch("Lerp Neutral V2",
    applyTimeStretchLerp(ar.data, ar, STRETCH, stretchPhaseNeutralV2));

  // 5. IF-corrected (uses phase derivative, not band freq)
  console.log();
  const ifData = applyTimeStretchIFCorrected(ar.data, ar, STRETCH);
  await evalStretch("IF-corrected: φ+dφ/dk×(k-k/S)", ifData);

  // Sine check for IF-corrected
  const sineIFData = applyTimeStretchIFCorrected(sineAr.data, sineAr, STRETCH);
  const sineIFSynth = await synthesize(sineIFData, sineAr, SR);
  const rSineIF = pearsonCorrelation(sineIFSynth, sineSignal);
  console.log(`  (sine check: r=${rSineIF.toFixed(6)}${rSineIF > 0.99 ? " ✓✓✓" : ""})`);

  // 6. Phase propagation
  await evalStretch("Phase propagation (cumulative)",
    applyTimeStretchPhaseProp(ar.data, ar, STRETCH));

  // 7. Unified (shift+stretch decomposition) — whole file 2x stretch
  console.log();
  await evalStretch("Unified (whole file, scaleX=2)",
    applyUnifiedPhaseCorrection(ar.data, ar, STRETCH, 0, 0.5, 0, 1));

  // 8. Test unified approach on SHIFT
  console.log("\n  --- Unified formula: shift test ---");
  const chunkWidth = SRC_R - SRC_L;
  for (const dstLeft of DST_POSITIONS) {
    const gt = timeDomainShift(signal, SRC_L, SRC_R, dstLeft);
    const shifted = applyUnifiedPhaseCorrection(ar.data, ar, 1.0, SRC_L, SRC_R, dstLeft, dstLeft + chunkWidth);
    const synth = await synthesize(shifted, ar, SR);
    const r = pearsonCorrelation(synth, gt);
    console.log(`  shift [${SRC_L},${SRC_R}]→${dstLeft}: r=${r.toFixed(4)}`);
  }

  // 9. Reverse + stretch (scaleX = -2)
  console.log("\n  --- Reverse + stretch (scaleX=-2) ---");
  {
    // For reverse+stretch of whole file: source [0, 0.5] reversed+stretched → [0, 1]
    // Ground truth: reverse the first half, then stretch it to fill full duration
    const gtRevStretch = timeDomainReverse(signal, 0, 0.5);
    // Use rubberband on the reversed first half
    const tmpRev = resolve(__dirname, "test-tmp-rev.wav");
    const revHalf = gtRevStretch.slice(0, Math.round(0.5 * signal.length));
    writeWav(tmpRev, revHalf, SR);
    const rbRevStretched = rubberbandStretch(tmpRev, resolve(__dirname, "test-tmp-rev-stretched.wav"), 2.0);

    // Our approach: reverse+stretch using unified formula (should handle scaleX=-2)
    // For scaleX=-2, the mapping is: srcUv = mirror - destUv/|S|
    // We simulate by passing scaleX=-2 to applyUnifiedPhaseCorrection
    // But applyUnifiedPhaseCorrection doesn't handle negative scaleX yet.
    // Let me add a dedicated reverse+stretch function that matches the shader logic.

    // For now, test with the Neutral V2 formula to verify banding
    const revStretchNV2 = (p, f, srcUv, dstUv, T) => -p + TWO_PI * f * (-srcUv - dstUv) * T;
    const revStretchNN = applyTimeStretchNN(ar.data, ar, -STRETCH, revStretchNV2);
    const synthRevNN = await synthesize(revStretchNN, ar, SR);
    const reArRevNN = await addon.analyze([synthRevNN], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const reProfileRevNN = spectralProfile(reArRevNN.data, reArRevNN);
    const rSpecRevNN = pearsonCorrelation(reProfileRevNN, origProfile);
    console.log(`  respec=${rSpecRevNN.toFixed(4)}  Rev+Stretch NV2 (band freq, no IF corr) — expect banding`);

    // Now with IF stretch correction added to the reversal
    // Formula: -φ_src - 2π·f·(srcUv+dstUv)·T + dphi·stretchFrames
    // This requires the applyTimeStretchNN to also compute dphi...
    // Let me use a custom function
    const revStretchIF = applyRevStretchIF(ar.data, ar, STRETCH);
    const synthRevIF = await synthesize(revStretchIF, ar, SR);
    const reArRevIF = await addon.analyze([synthRevIF], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const reProfileRevIF = spectralProfile(reArRevIF.data, reArRevIF);
    const rSpecRevIF = pearsonCorrelation(reProfileRevIF, origProfile);
    console.log(`  respec=${rSpecRevIF.toFixed(4)}  Rev+Stretch IF-corrected — should fix banding`);

    writeWav("test-out-rev-stretch-nv2.wav", synthRevNN, SR);
    writeWav("test-out-rev-stretch-if.wav", synthRevIF, SR);
    try { unlinkSync(tmpRev); } catch {}
    try { unlinkSync(resolve(__dirname, "test-tmp-rev-stretched.wav")); } catch {}
  }

  // 10. Partial stretch — stretch middle section [0.2, 0.4] by 2x → [0.2, 0.6]
  console.log("\n  --- Unified formula: partial stretch [0.2,0.4] 2x → [0.2,0.6] ---");
  {
    const pSrcL = 0.2, pSrcR = 0.4, pScale = 2.0;
    const pDstL = pSrcL, pDstR = pSrcL + (pSrcR - pSrcL) * pScale;
    const partialData = applyUnifiedPhaseCorrection(ar.data, ar, pScale, pSrcL, pSrcR, pDstL, pDstR);
    const partialSynth = await synthesize(partialData, ar, SR);

    // Use rubberband on just that chunk as reference
    const chunkStart = Math.round(pSrcL * signal.length);
    const chunkEnd = Math.round(pSrcR * signal.length);
    const chunk = signal.slice(chunkStart, chunkEnd);
    writeWav("test-tmp-chunk.wav", chunk, SR);
    const rbChunk = rubberbandStretch("test-tmp-chunk.wav", "test-tmp-chunk-stretched.wav", pScale);

    // Compare the destination region
    const dstStart = Math.round(pDstL * signal.length);
    const dstEnd = Math.round(pDstR * signal.length);
    const ourChunk = partialSynth.slice(dstStart, dstEnd);
    const minLen = Math.min(ourChunk.length, rbChunk.samples.length);
    const rPartial = pearsonCorrelation(ourChunk.slice(0, minLen), rbChunk.samples.slice(0, minLen));

    // Re-analyze for spectral check
    const reAr = await addon.analyze([partialSynth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const reProfile = spectralProfile(reAr.data, reAr);
    const rReSpec = pearsonCorrelation(reProfile, origProfile);

    console.log(`  respec=${rReSpec.toFixed(4)} rb=${rPartial.toFixed(4)}  Partial stretch`);
    writeWav("test-out-partial-stretch.wav", partialSynth, SR);
    try { unlinkSync("test-tmp-chunk.wav"); } catch {}
    try { unlinkSync("test-tmp-chunk-stretched.wav"); } catch {}
  }

  writeWav("test-out-stretch-rubberband.wav", rbStretched.samples, SR);
  try { unlinkSync(tmpIn); } catch {}
  try { unlinkSync(tmpOut); } catch {}

  // ─── TEST 5: Pitch shift — compare against rubberband ─────────────────────
  const PITCH_SEMITONES = [7, 12, -12]; // fifth up, octave up, octave down
  console.log(`\n=== TEST 5: Pitch shift — rubberband as reference ===\n`);

  // Sine sanity check: 440Hz → 880Hz (+12 semitones)
  {
    console.log("  --- Sine pitch shift: 440Hz → 880Hz (+12 st) ---");
    const target880 = new Float32Array(sineLen);
    for (let i = 0; i < sineLen; i++) target880[i] = Math.sin(TWO_PI * 880 * i / SR);

    const strategies880 = [
      { name: "identity", fn: (p) => p },
      { name: "band-freq: φ+2π(f_src-f_dst)t", fn: (p, fS, fD, t) => p + TWO_PI * (fS - fD) * t },
      { name: "scale phase: φ·(f_dst/f_src)", fn: (p, fS, fD) => p * (fD / fS) },
    ];
    // Phase-invariant correlation: sqrt(r_sin² + r_cos²)
    const cos880 = new Float32Array(sineLen);
    for (let i = 0; i < sineLen; i++) cos880[i] = Math.cos(TWO_PI * 880 * i / SR);

    for (const s of strategies880) {
      const pitched = applyPitchShift(sineAr.data, sineAr, 2.0, s.fn);
      const synth = await synthesize(pitched, sineAr, SR);
      const rSin = pearsonCorrelation(synth, target880);
      const rCos = pearsonCorrelation(synth, cos880);
      const rEnv = Math.sqrt(rSin * rSin + rCos * rCos); // phase-invariant amplitude
      console.log(`    r_env=${rEnv.toFixed(6)} (sin=${rSin.toFixed(3)}, cos=${rCos.toFixed(3)})  ${s.name}${rEnv > 0.9 ? " ✓✓✓" : ""}`);

      if (s.name === "scale phase: φ·(f_dst/f_src)") {
        // Check output properties
        let rms = 0;
        for (let i = 0; i < synth.length; i++) rms += synth[i] * synth[i];
        rms = Math.sqrt(rms / synth.length);
        console.log(`      RMS=${rms.toFixed(6)} (target RMS=${(1 / Math.sqrt(2)).toFixed(6)})`);
        console.log(`      First 10 samples: [${Array.from(synth.slice(0, 10)).map(v => v.toFixed(4)).join(", ")}]`);

        // Re-analyze the output to see where energy is
        const reAr = await addon.analyze([synth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
        const top5 = [];
        for (let b = 0; b < reAr.bandLengths.length; b++) {
          let sum = 0;
          const off = reAr.bandOffsets[b];
          for (let k = 0; k < reAr.bandLengths[b]; k++) sum += reAr.data[(off + k) * FPIX];
          top5.push({ b, freq: reAr.bandFreqsHz[b], avg: sum / reAr.bandLengths[b] });
        }
        top5.sort((a, b) => b.avg - a.avg);
        console.log(`      Top 5 bands in re-analysis:`);
        for (let i = 0; i < 5; i++) {
          console.log(`        band ${top5[i].b}: ${top5[i].freq.toFixed(1)}Hz  avg=${top5[i].avg.toFixed(4)}`);
        }
        writeWav("test-out-pitch-sine-880-scaled.wav", synth, SR);
      }
      if (s.name === "identity") {
        // Debug: find where energy ended up
        let maxMag = 0, maxBand = 0;
        for (let b = 0; b < sineAr.bandLengths.length; b++) {
          let sum = 0;
          const off = sineAr.bandOffsets[b];
          for (let k = 0; k < sineAr.bandLengths[b]; k++) sum += pitched[(off + k) * FPIX];
          const avg = sum / sineAr.bandLengths[b];
          if (avg > maxMag) { maxMag = avg; maxBand = b; }
        }
        console.log(`    → Energy peak: band ${maxBand}, freq ${sineAr.bandFreqsHz[maxBand].toFixed(1)}Hz, avgMag=${maxMag.toFixed(4)}`);

        // What does the 880Hz analysis look like?
        const ar880 = await addon.analyze([target880], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
        let maxMag880 = 0, maxBand880 = 0;
        for (let b = 0; b < ar880.bandLengths.length; b++) {
          let sum = 0;
          const off = ar880.bandOffsets[b];
          for (let k = 0; k < ar880.bandLengths[b]; k++) sum += ar880.data[(off + k) * FPIX];
          const avg = sum / ar880.bandLengths[b];
          if (avg > maxMag880) { maxMag880 = avg; maxBand880 = b; }
        }
        console.log(`    → 880Hz ref:   band ${maxBand880}, freq ${ar880.bandFreqsHz[maxBand880].toFixed(1)}Hz, avgMag=${maxMag880.toFixed(4)}`);
        writeWav("test-out-pitch-sine-880-identity.wav", synth, SR);
        writeWav("test-out-pitch-sine-880-target.wav", target880, SR);
      }
    }
    console.log();
  }

  for (const semitones of PITCH_SEMITONES) {
    const freqRatio = Math.pow(2, semitones / 12);
    console.log(`  --- ${semitones > 0 ? "+" : ""}${semitones} semitones (freq ×${freqRatio.toFixed(4)}) ---`);

    // Rubberband reference
    writeWav(tmpIn, signal, SR);
    const rbPitched = rubberbandStretch(tmpIn, tmpOut, 1.0, semitones);
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}

    // Gaborator pitch shift: move each band's data to the band at freq × freqRatio
    // phaseTransformFn(srcPhase, srcFreqHz, dstFreqHz, t) → dstPhase
    const strategies = [
      {
        name: "identity (copy phase)",
        fn: (p) => p,
      },
      {
        name: "band-freq correction: φ + 2π·(f_src-f_dst)·t",
        fn: (p, fSrc, fDst, t) => p + TWO_PI * (fSrc - fDst) * t,
      },
      {
        name: "scale phase by ratio: φ·(f_dst/f_src)",
        fn: (p, fSrc, fDst) => p * (fDst / fSrc),
      },
    ];

    for (const s of strategies) {
      const pitched = applyPitchShift(ar.data, ar, freqRatio, s.fn);
      const synth = await synthesize(pitched, ar, SR);

      const minLen = Math.min(synth.length, rbPitched.samples.length);
      const rRB = pearsonCorrelation(synth.slice(0, minLen), rbPitched.samples.slice(0, minLen));

      // Re-analyze to check spectral shape
      const reAr = await addon.analyze([synth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
      const reProfile = spectralProfile(reAr.data, reAr);
      // Compare against a shifted version of the original profile
      // Gaborator bands go high→low freq, so pitch UP = shift to LOWER indices = negative shiftBands
      const shiftedOrigProfile = shiftProfile(origProfile, -Math.round((BANDS_PER_OCTAVE * semitones) / 12));
      const rSpec = pearsonCorrelation(reProfile, shiftedOrigProfile);

      const tag = rRB > 0.8 ? "✓✓✓" : rRB > 0.5 ? "✓✓" : rRB > 0.3 ? "✓" : "";
      console.log(`    rb=${rRB.toFixed(4)} spec=${rSpec.toFixed(4)}  ${s.name}  ${tag}`);
      const safeName = `pitch_${semitones}_${s.name.slice(0, 15).replace(/[^a-z0-9]/gi, "_")}`;
      writeWav(`test-out-${safeName}.wav`, synth, SR);
    }
    writeWav(`test-out-pitch_${semitones}_rubberband.wav`, rbPitched.samples, SR);
    console.log();
  }

  // ─── WAV output ──────────────────────────────────────────────────────────────
  console.log("\nWriting WAVs...");
  writeWav("test-out-original.wav", signal, SR);
  writeWav("test-out-gt-partial-rev.wav", gtPartialRev, SR);
  writeWav("test-out-gt-full-rev.wav", gtFullRev, SR);

  const bestRevFn = makeReversalPhase(BL, BR);
  writeWav("test-out-partial-rev-correct.wav",
    await synthesize(applyPartialReversal(ar.data, ar, BL, BR, bestRevFn), ar, SR), SR);
  writeWav("test-out-partial-rev-old-fix.wav",
    await synthesize(applyPartialReversal(ar.data, ar, BL, BR, phaseOldFix), ar, SR), SR);

  for (const dstLeft of DST_POSITIONS) {
    const synth = await synthesize(
      applyTimeShift(ar.data, ar, SRC_L, SRC_R, dstLeft, makeShiftPhase(SRC_L, dstLeft)), ar, SR
    );
    writeWav(`test-out-shift-to-${dstLeft.toFixed(2)}.wav`, synth, SR);
  }

  console.log("  Wrote test-out-*.wav\n");
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
