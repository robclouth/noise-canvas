import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";

import { SpectrogramData } from "../store/types";

/**
 * Broadband onset map for a spectrogram. Detects onsets from the analysis
 * coefficients (spectral flux normalized by trailing energy, so hits out of
 * silence score high while amplitude wobble inside a decaying tail scores low),
 * then bakes a 1-row float texture mapping any time position to its nearest
 * onset: R = onset time in seconds, G = onset strength 0..1 (BA unused).
 * Transient-aware effects (transform "Punchy" algorithm) re-anchor phase at
 * the mapped onset with a single texture fetch.
 *
 * Computed from the ORIGINAL analysis data, so onsets painted after load are
 * not seen until re-analysis. Cached per SpectrogramData; a map texture is
 * ~64 KB so cache entries dying with their spectrogram is fine.
 */

export type Onset = { timeSec: number; strength: number };

const BIN_SEC = 0.001;
const TRAIL_BINS = 40;
const MIN_SEPARATION_SEC = 0.05;
const RIDGE_SEARCH_BINS = 8;
const MAX_TEX_WIDTH = 4096;

export function detectOnsets(spec: SpectrogramData): Onset[] {
  const { packedData, metadata, synthesisMetadata, numFrames, sampleRate, numBands } = spec;
  const { bandOffsets, bandStepLog2s, bandLengths } = synthesisMetadata;

  const durationSec = numFrames / sampleRate;
  const nBins = Math.max(1, Math.ceil(durationSec / BIN_SEC));
  const flux = new Float64Array(nBins);
  const energy = new Float64Array(nBins);

  for (let b = 0; b < numBands; b++) {
    const freq = metadata[b * 4 + 3];
    if (!(freq > 0)) continue;
    const offset = bandOffsets[b];
    const len = bandLengths[b];
    const stride = 1 << bandStepLog2s[b];
    const binsPerCoeff = stride / sampleRate / BIN_SEC;
    let prev = 0;
    for (let k = 0; k < len; k++) {
      const i = (offset + k) * 4;
      const mag = (packedData[i] + packedData[i + 2]) * 0.5;
      const bin = Math.min(nBins - 1, Math.floor(k * binsPerCoeff));
      energy[bin] += mag;
      const d = mag - prev;
      if (k > 0 && d > 0) flux[bin] += d;
      prev = mag;
    }
  }

  let globalMean = 0;
  for (let i = 0; i < nBins; i++) globalMean += energy[i];
  globalMean /= nBins;
  const eps = globalMean * 0.05 + 1e-9;

  // Relative flux against an exponentially trailing energy estimate.
  const rel = new Float64Array(nBins);
  const alpha = 1 / TRAIL_BINS;
  let trail = 0;
  for (let i = 0; i < nBins; i++) {
    rel[i] = flux[i] / (trail + eps);
    trail += alpha * (energy[i] - trail);
  }

  let maxRel = 0;
  let maxFlux = 0;
  for (let i = 0; i < nBins; i++) {
    if (rel[i] > maxRel) maxRel = rel[i];
    if (flux[i] > maxFlux) maxFlux = flux[i];
  }
  if (maxFlux <= 0 || maxRel <= 0) return [];

  const onsets: Onset[] = [];
  for (let i = 1; i < nBins - 1; i++) {
    const isPeak = rel[i] > rel[i - 1] && rel[i] >= rel[i + 1];
    if (!isPeak || rel[i] <= maxRel * 0.25 || flux[i] <= maxFlux * 0.05) continue;
    if (onsets.length > 0 && i * BIN_SEC - onsets[onsets.length - 1].timeSec < MIN_SEPARATION_SEC) continue;
    // Flux peaks on the rising edge, before the ridge centre. Anchor the onset
    // on the energy peak within the next few bins so phase locks land on the
    // ridge instead of ahead of it.
    let bestBin = i;
    let bestEnergy = energy[i];
    for (let j = i + 1; j < Math.min(nBins, i + 1 + RIDGE_SEARCH_BINS); j++) {
      if (energy[j] > bestEnergy) {
        bestEnergy = energy[j];
        bestBin = j;
      }
    }
    // Sub-bin refinement: parabolic vertex through the energy peak and its
    // neighbours. A timing error ε displaces the transported transient by
    // (α−1)·ε for pitch ratio α, so raw bin quantization (±0.5 ms) costs
    // several ms of attack displacement at large downward shifts.
    const eL = bestBin > 0 ? energy[bestBin - 1] : 0;
    const eR = bestBin < nBins - 1 ? energy[bestBin + 1] : 0;
    const denom = eL - 2 * bestEnergy + eR;
    const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (eL - eR)) / denom)) : 0;
    onsets.push({ timeSec: (bestBin + 0.5 + delta) * BIN_SEC, strength: Math.min(1, rel[i] / (maxRel * 0.5)) });
  }
  return onsets;
}

const mapCache = new WeakMap<SpectrogramData, DataTexture>();

export function getOnsetMapTexture(spec: SpectrogramData): DataTexture {
  const cached = mapCache.get(spec);
  if (cached) return cached;

  const onsets = detectOnsets(spec);
  const durationSec = spec.numFrames / spec.sampleRate;
  const width = Math.max(1, Math.min(MAX_TEX_WIDTH, Math.ceil(durationSec / BIN_SEC)));
  const data = new Float32Array(width * 4);

  if (onsets.length > 0) {
    let cursor = 0;
    for (let x = 0; x < width; x++) {
      const t = ((x + 0.5) / width) * durationSec;
      while (
        cursor < onsets.length - 1 &&
        Math.abs(onsets[cursor + 1].timeSec - t) <= Math.abs(onsets[cursor].timeSec - t)
      ) {
        cursor++;
      }
      data[x * 4] = onsets[cursor].timeSec;
      data[x * 4 + 1] = onsets[cursor].strength;
    }
  }

  const texture = new DataTexture(data, width, 1, RGBAFormat, FloatType);
  texture.internalFormat = "RGBA32F";
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  mapCache.set(spec, texture);
  return texture;
}
