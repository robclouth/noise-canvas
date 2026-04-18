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
    if (chunkId === "data") {
      dataOffset += 8;
      break;
    }
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
        const lo = buf[offset],
          mid = buf[offset + 1],
          hi = buf[offset + 2];
        const val = (((hi << 16) | (mid << 8) | lo) << 8) >> 8;
        sum += val / 8388608;
      } else if (bitsPerSample === 32) {
        sum += buf.readInt32LE(offset) / 2147483648;
      }
    }
    mono[i] = sum / numChannels;
  }

  return { samples: mono, sampleRate };
}

const DRUM_PATH =
  "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav";

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
  let sumA = 0,
    sumB = 0,
    sumAB = 0,
    sumA2 = 0,
    sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const cov = sumAB - (sumA * sumB) / n;
  const da = Math.sqrt(sumA2 - (sumA * sumA) / n);
  const db = Math.sqrt(sumB2 - (sumB * sumB) / n);
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
    modData,
    ar,
    sampleRate,
    { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ },
    false,
    [],
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
const makeReversalPhase = (brushLeft, brushRight) => (p, f, T) => -p - TWO_PI * f * (brushLeft + brushRight) * T;

// Correct shift using exact source/dest positions
const makeShiftPhase = (srcLeft, dstLeft) => (p, f, T) => p + TWO_PI * f * (srcLeft - dstLeft) * T;

// ─── Phase derivative (centered difference) ─────────────────────────────────

// 4-frame wide centered difference: (phase[k+2] - phase[k-2]) / 4
function computeWideDphi(data, offset, len, phaseOff) {
  const dphi = new Float64Array(len);
  for (let k = 2; k < len - 2; k++) {
    const iPrev = (offset + k - 2) * FPIX;
    const iNext = (offset + k + 2) * FPIX;
    dphi[k] = (data[iNext + phaseOff] - data[iPrev + phaseOff]) * 0.25;
  }
  // Edges: fall back to narrower estimates
  if (len >= 2) {
    dphi[0] = data[(offset + 1) * FPIX + phaseOff] - data[(offset + 0) * FPIX + phaseOff];
    dphi[len - 1] = data[(offset + len - 1) * FPIX + phaseOff] - data[(offset + len - 2) * FPIX + phaseOff];
  }
  if (len >= 3) {
    dphi[1] = (data[(offset + 2) * FPIX + phaseOff] - data[(offset + 0) * FPIX + phaseOff]) * 0.5;
    dphi[len - 2] = (data[(offset + len - 1) * FPIX + phaseOff] - data[(offset + len - 3) * FPIX + phaseOff]) * 0.5;
  }
  return dphi;
}

// Compute phase stability: |d²φ/dk²| — how much dphi changes between frames.
// High values = transient or noise (IF changing rapidly). Low = tonal (stable IF).
function computePhaseStability(dphi) {
  const stability = new Float64Array(dphi.length);
  for (let k = 1; k < dphi.length - 1; k++) {
    const d2phi = Math.abs(dphi[k + 1] - dphi[k - 1]) * 0.5;
    stability[k] = d2phi;
  }
  stability[0] = stability[Math.min(1, dphi.length - 1)];
  stability[dphi.length - 1] = stability[Math.max(0, dphi.length - 2)];
  return stability;
}

// Backward difference: dphi[k] = phase[k] - phase[k-1]
// Causal — only looks at the past. Onsets don't bleed backward.
function computeBackwardDphi(data, offset, len, phaseOff) {
  const dphi = new Float64Array(len);
  for (let k = 1; k < len; k++) {
    const iPrev = (offset + k - 1) * FPIX;
    const iCurr = (offset + k) * FPIX;
    dphi[k] = data[iCurr + phaseOff] - data[iPrev + phaseOff];
  }
  dphi[0] = dphi[Math.min(1, len - 1)];
  return dphi;
}

// Smooth dphi: box-filter the centered dphi over a window of N frames.
// Preserves the average IF offset (prevents band-center pull) while
// removing transient noise (prevents swooping).
function computeSmoothedDphi(data, offset, len, phaseOff, windowSize) {
  const raw = computeCenteredDphi(data, offset, len, phaseOff);
  const smoothed = new Float64Array(len);
  const half = Math.floor(windowSize / 2);
  for (let k = 0; k < len; k++) {
    let sum = 0,
      count = 0;
    for (let j = k - half; j <= k + half; j++) {
      if (j >= 0 && j < len) {
        sum += raw[j];
        count++;
      }
    }
    smoothed[k] = sum / count;
  }
  return smoothed;
}

// Wide finite difference: dphi = (phase[k+R] - phase[k-R]) / (2R)
// Same as smooth box filter for linear phase, but only needs 2 samples.
// This is what can be done in the shader with no extra texture reads.
function computeWideFiniteDphi(data, offset, len, phaseOff, radius) {
  const dphi = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    const lo = Math.max(0, k - radius);
    const hi = Math.min(len - 1, k + radius);
    const iLo = (offset + lo) * FPIX;
    const iHi = (offset + hi) * FPIX;
    dphi[k] = (data[iHi + phaseOff] - data[iLo + phaseOff]) / (hi - lo);
  }
  return dphi;
}

function computeForwardDphi(data, offset, len, phaseOff) {
  const dphi = new Float64Array(len);
  for (let k = 0; k < len - 1; k++) {
    const i0 = (offset + k) * FPIX;
    const i1 = (offset + k + 1) * FPIX;
    dphi[k] = data[i1 + phaseOff] - data[i0 + phaseOff];
  }
  dphi[len - 1] = dphi[Math.max(0, len - 2)];
  return dphi;
}

function computeCenteredDphi(data, offset, len, phaseOff) {
  const dphi = new Float64Array(len);
  for (let k = 1; k < len - 1; k++) {
    const iPrev = (offset + k - 1) * FPIX;
    const iNext = (offset + k + 1) * FPIX;
    dphi[k] = (data[iNext + phaseOff] - data[iPrev + phaseOff]) * 0.5;
  }
  // Edges: use forward/backward difference
  if (len >= 2) {
    const i0 = (offset + 0) * FPIX;
    const i1 = (offset + 1) * FPIX;
    dphi[0] = data[i1 + phaseOff] - data[i0 + phaseOff];
    const iN2 = (offset + len - 2) * FPIX;
    const iN1 = (offset + len - 1) * FPIX;
    dphi[len - 1] = data[iN1 + phaseOff] - data[iN2 + phaseOff];
  }
  return dphi;
}

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

// ─── Unified 2D transform ────────────────────────────────────────────────────
//
// General transform: any combination of scaleX, scaleY, shiftX, shiftY.
//
// The phase formula composes:
//   1. Frequency ratio r = f_dst / f_src: scale phase to match new frequency
//   2. Sign of scaleX: negate phase for reversal
//   3. Time shift: band-freq correction
//   4. Time stretch: IF correction
//   5. Sign of scaleY: negate phase for vertical flip
//   6. Reverse+stretch: add expectedAdvance to IF correction
//
// Combined: φ_dest = r · (signX · signY · φ_src + timeShiftCorr) + timeStretchCorr_scaled
//
// dphi modes: "forward", "centered", "wide4", "backward"
// confidence modes: "none", "mag", "stability", "both"
// anchorInterval: reset IF correction every N source frames (0 = no reset)
function applyUnified2D(
  data,
  ar,
  scaleX,
  scaleY,
  shiftXUv,
  shiftYUv,
  dphiMode = "centered",
  confMode = "none",
  anchorInterval = 0,
) {
  const { bandOffsets, bandLengths, bandStepLog2s, bandFreqsHz, numFrames, sampleRate } = ar;
  const T_total = (numFrames - 1) / sampleRate;
  const dest = new Float32Array(data.length);
  const signX = scaleX < 0 ? -1 : 1;
  const signY = scaleY < 0 ? -1 : 1;
  const absScaleX = Math.abs(scaleX);
  const absScaleY = Math.abs(scaleY);

  for (let bDst = 0; bDst < bandLengths.length; bDst++) {
    const dstFreq = bandFreqsHz[bDst];
    const dstOffset = bandOffsets[bDst];
    const dstLen = bandLengths[bDst];
    const dstStep = 1 << bandStepLog2s[bDst];

    // Find source band: invert the Y transform
    // In UV space, Y goes from 0 (high freq) to 1 (low freq)
    // scaleY > 1 compresses source → higher destination frequencies
    // scaleY < 0 flips + scales
    // For log-freq CQ: source freq = dest freq / |scaleY|
    // (scaleY sign handled by signY on the phase)
    const srcFreqTarget = dstFreq / absScaleY;
    if (srcFreqTarget <= 0 || srcFreqTarget < MIN_FREQ) continue;

    // Find closest source band
    let bSrc = 0;
    for (let i = 1; i < bandFreqsHz.length; i++) {
      if (Math.abs(bandFreqsHz[i] - srcFreqTarget) < Math.abs(bandFreqsHz[bSrc] - srcFreqTarget)) bSrc = i;
    }

    const srcFreq = bandFreqsHz[bSrc];
    const srcOffset = bandOffsets[bSrc];
    const srcLen = bandLengths[bSrc];
    const srcStep = 1 << bandStepLog2s[bSrc];

    // Frequency ratio for phase scaling
    const freqRatio = dstFreq / srcFreq;

    for (let ch = 0; ch < 2; ch++) {
      const phaseOff = ch === 0 ? 1 : 3;
      const magOff = ch === 0 ? 0 : 2;

      let dphi;
      if (dphiMode === "wide4") dphi = computeWideDphi(data, srcOffset, srcLen, phaseOff);
      else if (dphiMode === "forward") dphi = computeForwardDphi(data, srcOffset, srcLen, phaseOff);
      else if (dphiMode === "backward") dphi = computeBackwardDphi(data, srcOffset, srcLen, phaseOff);
      else if (dphiMode.startsWith("smooth")) {
        const w = parseInt(dphiMode.slice(6)) || 8;
        dphi = computeSmoothedDphi(data, srcOffset, srcLen, phaseOff, w);
      } else if (dphiMode.startsWith("wf")) {
        const r = parseInt(dphiMode.slice(2)) || 16;
        dphi = computeWideFiniteDphi(data, srcOffset, srcLen, phaseOff, r);
      } else if (dphiMode.startsWith("wt")) {
        // Time-based: "wt50" = 50ms radius, converted to frames per band
        const ms = parseInt(dphiMode.slice(2)) || 50;
        const radiusFrames = Math.max(1, Math.round(((ms / 1000) * sampleRate) / srcStep));
        dphi = computeWideFiniteDphi(data, srcOffset, srcLen, phaseOff, radiusFrames);
      } else if (dphiMode.startsWith("wfrac")) {
        // Fraction of band length: "wfrac25" = 25% of bandLength as radius
        const pct = parseInt(dphiMode.slice(5)) || 25;
        const radiusFrames = Math.max(1, Math.round((srcLen * pct) / 100));
        dphi = computeWideFiniteDphi(data, srcOffset, srcLen, phaseOff, radiusFrames);
      } else dphi = computeCenteredDphi(data, srcOffset, srcLen, phaseOff);
      const phaseStab = confMode === "stability" || confMode === "both" ? computePhaseStability(dphi) : null;

      for (let kDst = 0; kDst < dstLen; kDst++) {
        const dstTimeUv = (kDst * dstStep) / (numFrames - 1);

        // Invert X transform: mirrors shader's pivot/scale/offset logic
        // For whole-file brush (pivot=0, brushSize=1):
        //   sourceUv = dstUv / scaleX + (scaleX < 0 ? 1 : 0) + shiftXUv
        const srcTimeUv = dstTimeUv / scaleX + (scaleX < 0 ? 1.0 : 0.0) + shiftXUv;
        if (srcTimeUv < -0.01 || srcTimeUv > 1.01) continue;

        // Map to source frame
        const srcKFloat = (srcTimeUv * (numFrames - 1)) / srcStep;
        const srcK0 = Math.floor(srcKFloat);
        const srcK1 = Math.min(srcK0 + 1, srcLen - 1);
        const frac = srcKFloat - srcK0;

        if (srcK0 < 0 || srcK0 >= srcLen) continue;

        const idx0 = (srcOffset + srcK0) * FPIX;
        const idx1 = (srcOffset + srcK1) * FPIX;
        const dstIdx = (dstOffset + kDst) * FPIX;

        // Interpolate magnitude
        dest[dstIdx + magOff] = data[idx0 + magOff] * (1 - frac) + data[idx1 + magOff] * frac;

        // Interpolate source phase and phase derivative
        const srcPhase = data[idx0 + phaseOff] * (1 - frac) + data[idx1 + phaseOff] * frac;
        const srcDphi = dphi[srcK0] * (1 - frac) + dphi[Math.min(srcK1, srcLen - 2)] * frac;

        // === Compose phase corrections ===

        let phase;

        if (confMode === "scale" || confMode === "blend") {
          // Scale-by-S: scaleX × signY × φ_src (handles stretch + reversal)
          const sclPhase = scaleX * signY * srcPhase;

          // Additive: signX × signY × φ_src + carrier correction
          let addPhase = signX * signY * srcPhase;
          if (signX < 0) {
            addPhase += -TWO_PI * srcFreq * (srcTimeUv + dstTimeUv) * T_total;
          } else {
            const shiftOffset = srcTimeUv - dstTimeUv / Math.max(scaleX, 1e-5);
            addPhase += TWO_PI * srcFreq * shiftOffset * T_total;
          }

          if (confMode === "blend") {
            // Blend: additive near |scaleX|=1, scale-by-S when stretching
            const stretchAmount = Math.min(Math.abs(absScaleX - 1) * 4, 1);
            phase = addPhase * (1 - stretchAmount) + sclPhase * stretchAmount;
          } else {
            phase = sclPhase;
          }

          phase *= freqRatio;
        } else {
          // Additive IF correction approach (original)
          // 1. Sign (reversal in X and/or Y)
          phase = signX * signY * srcPhase;

          // 2. Time shift/reversal correction (band-freq based)
          if (signX > 0) {
            const shiftOffset = srcTimeUv - dstTimeUv / scaleX;
            phase += TWO_PI * srcFreq * shiftOffset * T_total;
          } else {
            phase += -TWO_PI * srcFreq * (srcTimeUv + dstTimeUv) * T_total;
          }

          // 3. Time stretch IF correction
          if (absScaleX > 1e-5 && Math.abs(absScaleX - 1) > 1e-5) {
            let effectiveDphi = srcDphi;
            if (signX < 0) {
              const expectedAdvance = (TWO_PI * srcFreq * srcStep) / sampleRate;
              effectiveDphi += expectedAdvance;
            }
            let stretchFrames = (dstTimeUv * (1 - 1 / absScaleX) * (numFrames - 1)) / srcStep;
            if (anchorInterval === -1) stretchFrames = 0;
            else if (anchorInterval > 0) stretchFrames = Math.min(stretchFrames, anchorInterval);
            phase += effectiveDphi * stretchFrames;
          }

          // 4. Frequency ratio scaling (pitch change)
          phase *= freqRatio;
        }

        dest[dstIdx + phaseOff] = phase;
      }
    }
  }
  return dest;
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

      const dphi = computeCenteredDphi(data, offset, len, phaseOff);

      // Shift correction: band-freq for the constant shift offset
      const shiftConst = srcLeftUv - dstLeftUv / scaleX;
      const bandFreqCorr = TWO_PI * freq * shiftConst * T_total;

      for (let k = kDstStart; k < kDstEnd; k++) {
        const dstUv = (k * bandStep) / (numFrames - 1);

        // Source UV from the transform: brush-relative scaling + offset
        const srcUv = (dstUv - dstLeftUv) / scaleX + srcLeftUv;

        // Bounds check source
        if (srcUv < srcLeftUv - 0.001 || srcUv > srcRightUv + 0.001) continue;

        const srcKFloat = (srcUv * (numFrames - 1)) / bandStep;
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
        const stretchFrames = ((dstUv - dstLeftUv) * (1 - 1 / scaleX) * (numFrames - 1)) / bandStep;
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

      const dphi = computeCenteredDphi(data, offset, len, phaseOff);

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
        const srcKFloat = len - 1 - k / absScaleX;
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
        const srcDphi = dphi[Math.min(srcK0, len - 2)] * (1 - frac) + dphi[Math.min(srcK1, len - 2)] * frac;

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
        const stretchFrames = (dstUv * (1 - 1 / absScaleX) * (numFrames - 1)) / bandStep;
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
  const ar = await addon.analyze([signal], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
  console.log(`  ${ar.numBands} bands, ${ar.numFrames} frames\n`);

  const roundTrip = await synthesize(ar.data.slice(), ar, SR);
  const ceiling = pearsonCorrelation(roundTrip, signal);
  console.log(`Round-trip ceiling: r=${ceiling.toFixed(6)}\n`);

  // ─── TEST 1: Partial reversal with off-centre brush (BL+BR ≠ 1) ─────────────
  //
  // Brush [0.1, 0.4]: BL + BR = 0.5, so t_start + t_end = 0.5 * T_total.
  // Old fix uses T_total (2× too large) — should be clearly wrong.
  // Correct formula uses 0.5 * T_total.
  const BL = 0.1,
    BR = 0.4;
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
  const SRC_L = 0.25,
    SRC_R = 0.45;
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
  console.log(
    `  Rubberband: ${rbStretched.samples.length} samples (${(rbStretched.samples.length / SR).toFixed(3)} s)`,
  );

  // Also analyze rubberband output with gaborator to get a "ceiling" correlation
  const rbAnalysis = await addon.analyze([rbStretched.samples], 1, SR, {
    bandsPerOctave: BANDS_PER_OCTAVE,
    minFreq: MIN_FREQ,
  });
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
  for (let i = 0; i < sineLen; i++) sineSignal[i] = Math.sin((TWO_PI * sineFreq * i) / SR);
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
    let diffCount = 0,
      maxDiff = 0;
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
      console.log(
        `    440Hz band: idx=${bandIdx}, freq=${sineAr.bandFreqsHz[bandIdx].toFixed(1)}, len=${bLen}, step=${bStep}`,
      );
      // Print first few original and stretched values
      for (let k = 0; k < Math.min(5, bLen); k++) {
        const srcK = Math.round(k / STRETCH);
        const oi = (bOff + k) * FPIX;
        const si = (bOff + srcK) * FPIX;
        console.log(
          `      k=${k} srcK=${srcK}: orig=[${sineAr.data[oi].toFixed(4)}, ${sineAr.data[oi + 1].toFixed(4)}] stretched=[${sineStretched[oi].toFixed(4)}, ${sineStretched[oi + 1].toFixed(4)}]`,
        );
      }
      // Print last few
      for (let k = bLen - 3; k < bLen; k++) {
        const srcK = Math.round(k / STRETCH);
        const oi = (bOff + k) * FPIX;
        console.log(
          `      k=${k} srcK=${srcK}: orig=[${sineAr.data[oi].toFixed(4)}, ${sineAr.data[oi + 1].toFixed(4)}] stretched=[${sineStretched[oi].toFixed(4)}, ${sineStretched[oi + 1].toFixed(4)}]`,
        );
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
  await evalStretch("NN identity phase", applyTimeStretchNN(ar.data, ar, STRETCH, stretchPhaseIdentity));

  // 2. NN + Neutral V2 (uses band freq — overcorrects)
  await evalStretch(
    "NN Neutral V2: φ+2π·f·(src-dst)·T",
    applyTimeStretchNN(ar.data, ar, STRETCH, stretchPhaseNeutralV2),
  );

  // 3. Lerp + identity
  await evalStretch("Lerp identity phase", applyTimeStretchLerp(ar.data, ar, STRETCH, stretchPhaseIdentity));

  // 4. Lerp + Neutral V2
  await evalStretch("Lerp Neutral V2", applyTimeStretchLerp(ar.data, ar, STRETCH, stretchPhaseNeutralV2));

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
  await evalStretch("Phase propagation (cumulative)", applyTimeStretchPhaseProp(ar.data, ar, STRETCH));

  // 7. Unified (shift+stretch decomposition) — whole file 2x stretch
  console.log();
  await evalStretch("Unified (whole file, scaleX=2)", applyUnifiedPhaseCorrection(ar.data, ar, STRETCH, 0, 0.5, 0, 1));

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
    try {
      unlinkSync(tmpRev);
    } catch {}
    try {
      unlinkSync(resolve(__dirname, "test-tmp-rev-stretched.wav"));
    } catch {}
  }

  // 10. Partial stretch — stretch middle section [0.2, 0.4] by 2x → [0.2, 0.6]
  console.log("\n  --- Unified formula: partial stretch [0.2,0.4] 2x → [0.2,0.6] ---");
  {
    const pSrcL = 0.2,
      pSrcR = 0.4,
      pScale = 2.0;
    const pDstL = pSrcL,
      pDstR = pSrcL + (pSrcR - pSrcL) * pScale;
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
    try {
      unlinkSync("test-tmp-chunk.wav");
    } catch {}
    try {
      unlinkSync("test-tmp-chunk-stretched.wav");
    } catch {}
  }

  writeWav("test-out-stretch-rubberband.wav", rbStretched.samples, SR);
  try {
    unlinkSync(tmpIn);
  } catch {}
  try {
    unlinkSync(tmpOut);
  } catch {}

  // ─── TEST 5: Unified 2D transform — all combinations ─────────────────────
  console.log(`\n=== TEST 5: Unified 2D transform ===\n`);

  // Phase-invariant correlation helper (handles constant phase offset)
  function phaseInvariantCorr(a, b, freqHz) {
    const rSin = pearsonCorrelation(a, b);
    // Generate cos version of target
    const cosTarget = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) cosTarget[i] = Math.cos((TWO_PI * freqHz * i) / SR);
    const rCos = pearsonCorrelation(a, cosTarget);
    return Math.sqrt(rSin * rSin + rCos * rCos);
  }

  // Helper: evaluate unified2D and compute respec + rb correlation
  async function evalUnified(label, scaleX, scaleY, shiftXUv, shiftYUv, rbRef) {
    const result = applyUnified2D(ar.data, ar, scaleX, scaleY, shiftXUv, shiftYUv);
    const synth = await synthesize(result, ar, SR);

    // Spectral preservation (re-analyze)
    const reAr = await addon.analyze([synth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const reProfile = spectralProfile(reAr.data, reAr);
    // Shift the reference profile to account for pitch change
    const pitchBands = Math.abs(scaleY) !== 1 ? -Math.round(BANDS_PER_OCTAVE * Math.log2(Math.abs(scaleY))) : 0;
    const shiftedProfile = pitchBands !== 0 ? shiftProfile(origProfile, pitchBands) : origProfile;
    const rSpec = pearsonCorrelation(reProfile, shiftedProfile);

    let rbStr = "";
    if (rbRef) {
      const minLen = Math.min(synth.length, rbRef.length);
      const rRB = pearsonCorrelation(synth.slice(0, minLen), rbRef.slice(0, minLen));
      rbStr = ` rb=${rRB.toFixed(4)}`;
    }

    const tag = rSpec > 0.95 ? "✓✓" : rSpec > 0.9 ? "✓" : "";
    console.log(`  respec=${rSpec.toFixed(4)}${rbStr}  ${label}  ${tag}`);
    writeWav(`test-out-unified-${label.slice(0, 30).replace(/[^a-z0-9]/gi, "_")}.wav`, synth, SR);
    return { synth, rSpec };
  }

  // --- Sine sanity checks ---
  console.log("  --- Sine sanity checks (phase-invariant) ---");
  {
    // Pure pitch: 440 → 880 (+12st)
    const sine440data = applyUnified2D(sineAr.data, sineAr, 1, 2, 0, 0);
    const sine880synth = await synthesize(sine440data, sineAr, SR);
    const target880 = new Float32Array(sineLen);
    for (let i = 0; i < sineLen; i++) target880[i] = Math.sin((TWO_PI * 880 * i) / SR);
    const r880 = phaseInvariantCorr(sine880synth, target880, 880);
    console.log(`    440→880 (pitch×2):     r_env=${r880.toFixed(4)}${r880 > 0.9 ? " ✓✓✓" : ""}`);

    // Pure pitch: 440 → 220 (-12st)
    const sine220data = applyUnified2D(sineAr.data, sineAr, 1, 0.5, 0, 0);
    const sine220synth = await synthesize(sine220data, sineAr, SR);
    const target220 = new Float32Array(sineLen);
    for (let i = 0; i < sineLen; i++) target220[i] = Math.sin((TWO_PI * 220 * i) / SR);
    const r220 = phaseInvariantCorr(sine220synth, target220, 220);
    console.log(`    440→220 (pitch×0.5):   r_env=${r220.toFixed(4)}${r220 > 0.9 ? " ✓✓✓" : ""}`);

    // Pure time stretch: 440Hz, 2× stretch should still be 440Hz
    const sine2xdata = applyUnified2D(sineAr.data, sineAr, 2, 1, 0, 0);
    const sine2xsynth = await synthesize(sine2xdata, sineAr, SR);
    const r440stretch = phaseInvariantCorr(sine2xsynth, sineSignal, 440);
    console.log(`    440Hz 2× stretch:      r_env=${r440stretch.toFixed(4)}${r440stretch > 0.9 ? " ✓✓✓" : ""}`);

    // Pitch + stretch: 440→880 and 2× stretch
    const sinePSdata = applyUnified2D(sineAr.data, sineAr, 2, 2, 0, 0);
    const sinePSsynth = await synthesize(sinePSdata, sineAr, SR);
    const rPS = phaseInvariantCorr(sinePSsynth, target880, 880);
    console.log(`    440→880 + 2× stretch:  r_env=${rPS.toFixed(4)}${rPS > 0.9 ? " ✓✓✓" : ""}`);

    // Reverse: 440Hz reversed should still be 440Hz
    const sineRevdata = applyUnified2D(sineAr.data, sineAr, -1, 1, 0, 0);
    const sineRevsynth = await synthesize(sineRevdata, sineAr, SR);
    const rRev = phaseInvariantCorr(sineRevsynth, sineSignal, 440);
    console.log(`    440Hz reversed:        r_env=${rRev.toFixed(4)}${rRev > 0.9 ? " ✓✓✓" : ""}`);

    // Rev + stretch: 440Hz, scaleX=-2
    const sineRS = applyUnified2D(sineAr.data, sineAr, -2, 1, 0, 0);
    const sineRSsynth = await synthesize(sineRS, sineAr, SR);
    const rRS = phaseInvariantCorr(sineRSsynth, sineSignal, 440);
    console.log(`    440Hz rev+2× stretch:  r_env=${rRS.toFixed(4)}${rRS > 0.9 ? " ✓✓✓" : ""}`);

    // Pitch flip: scaleY=-1 should mirror frequencies
    const sineFlipY = applyUnified2D(sineAr.data, sineAr, 1, -1, 0, 0);
    const sineFlipSynth = await synthesize(sineFlipY, sineAr, SR);
    const rFlipY = phaseInvariantCorr(sineFlipSynth, sineSignal, 440);
    console.log(`    440Hz pitch flip Y:    r_env=${rFlipY.toFixed(4)}${rFlipY > 0.9 ? " ✓✓✓" : ""}`);
  }

  // --- Drum loop: compare IF estimation and confidence strategies ---
  console.log("\n  --- Drum loop: dphi estimation × confidence strategies ---");

  const variants = [
    ["identity (no IF)", "centered", "none", -1],
    ["additive wf32", "wf32", "none", 0],
    ["scale-by-S", "centered", "scale", 0],
    ["blended", "centered", "blend", 0],
  ];

  const stretchTests = [
    ["scaleX=1 (identity)", 1, 1],
    ["scaleX=-1 (reverse)", -1, 1],
    ["scaleX=2 (stretch)", 2, 1],
    ["scaleX=-2 (rev+str)", -2, 1],
    ["scaleX=2 scaleY=2", 2, 2],
  ];

  async function synthAndProfile(synthData, sy) {
    const synth = await synthesize(synthData, ar, SR);
    const reAr = await addon.analyze([synth], 1, SR, { bandsPerOctave: BANDS_PER_OCTAVE, minFreq: MIN_FREQ });
    const pitchBands = Math.abs(sy) !== 1 ? -Math.round(BANDS_PER_OCTAVE * Math.log2(Math.abs(sy))) : 0;
    const refProfile = pitchBands !== 0 ? shiftProfile(origProfile, pitchBands) : origProfile;
    const rSpec = pearsonCorrelation(spectralProfile(reAr.data, reAr), refProfile);
    return { synth, rSpec };
  }

  for (const [label, sx, sy] of stretchTests) {
    console.log(`\n  ${label}:`);
    for (const [vName, dMode, cMode, anchor] of variants) {
      let d;
      if (anchor === -1) {
        // Identity: no IF correction at all (anchorInterval=1 effectively zeros it)
        d = applyUnified2D(ar.data, ar, sx, sy, 0, 0, dMode, cMode, 1);
      } else {
        d = applyUnified2D(ar.data, ar, sx, sy, 0, 0, dMode, cMode, anchor);
      }
      const { synth, rSpec } = await synthAndProfile(d, sy);
      console.log(`    respec=${rSpec.toFixed(4)}  ${vName}`);
      const safe = `${label}_${vName}`.replace(/[^a-z0-9]/gi, "_");
      writeWav(`test-out-v-${safe}.wav`, synth, SR);
    }
  }

  // Shift test: compare only the destination chunk region (whole-file function
  // fills beyond the chunk, which is correct — the shader limits via brush weight)
  console.log("\n  --- Unified: shift regression (chunk region only) ---");
  for (const dstLeft of DST_POSITIONS) {
    const shiftUv = SRC_L - dstLeft;
    const result = applyUnified2D(ar.data, ar, 1, 1, shiftUv, 0);
    const synth = await synthesize(result, ar, SR);
    const gt = timeDomainShift(signal, SRC_L, SRC_R, dstLeft);
    // Compare only the destination chunk region
    const dStart = Math.round(dstLeft * signal.length);
    const dEnd = Math.round((dstLeft + (SRC_R - SRC_L)) * signal.length);
    const synthChunk = synth.slice(dStart, dEnd);
    const gtChunk = gt.slice(dStart, dEnd);
    const r = pearsonCorrelation(synthChunk, gtChunk);
    console.log(`  shift [${SRC_L},${SRC_R}]→${dstLeft}: r=${r.toFixed(4)}`);
  }

  // ─── WAV output ──────────────────────────────────────────────────────────────
  console.log("\nWriting WAVs...");
  writeWav("test-out-original.wav", signal, SR);
  writeWav("test-out-gt-partial-rev.wav", gtPartialRev, SR);
  writeWav("test-out-gt-full-rev.wav", gtFullRev, SR);

  const bestRevFn = makeReversalPhase(BL, BR);
  writeWav(
    "test-out-partial-rev-correct.wav",
    await synthesize(applyPartialReversal(ar.data, ar, BL, BR, bestRevFn), ar, SR),
    SR,
  );
  writeWav(
    "test-out-partial-rev-old-fix.wav",
    await synthesize(applyPartialReversal(ar.data, ar, BL, BR, phaseOldFix), ar, SR),
    SR,
  );

  for (const dstLeft of DST_POSITIONS) {
    const synth = await synthesize(
      applyTimeShift(ar.data, ar, SRC_L, SRC_R, dstLeft, makeShiftPhase(SRC_L, dstLeft)),
      ar,
      SR,
    );
    writeWav(`test-out-shift-to-${dstLeft.toFixed(2)}.wav`, synth, SR);
  }

  console.log("  Wrote test-out-*.wav\n");
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
