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
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
