import type { SpectrogramData } from "../store/types";

/**
 * Attributes clipping (or limiter gain reduction) back onto individual
 * spectrogram coefficients.
 *
 * Clipping is a time-domain event: the sample value is the sum of every
 * partial's contribution at that instant, so no single band is on its own
 * "responsible". What can be computed exactly is each coefficient's *signed*
 * contribution to the offending sample, which separates partials pushing the
 * peak outwards from partials pulling it back in. Attenuating the latter makes
 * clipping worse, so the sign is the useful part.
 *
 * Under the global phase convention used by the analysis, a coefficient of
 * magnitude m and phase p in a band centred at frequency f contributes
 *
 *     m * envelope(t0 - tCoef) * cos(2*pi*f*t0 + p)
 *
 * to the waveform at absolute sample t0, where envelope is the band's Gaussian
 * atom. Summing that over every coefficient reproduces the sample value.
 */

/** A sample at which the output overshot full scale, or the limiter pulled it back. */
export interface Overload {
  /** Absolute sample index of the peak. */
  sample: number;
  /** Sign of the waveform at the peak: +1 or -1. */
  sign: number;
  /** How far past full scale the peak went, in dB. */
  excessDb: number;
}

/** Gain reduction below which a hop is not considered an overload. */
const GAIN_REDUCTION_THRESHOLD_DB = 0.1;

/** Hop length of the gain-reduction envelope produced by the baked limiter. */
const GAIN_REDUCTION_HOP_SECONDS = 0.005;

/** Cap on how many overloads are attributed, strongest first. */
const MAX_OVERLOADS = 512;

/** Gaussian atom is truncated beyond this many standard deviations. */
const ATOM_SIGMA_CUTOFF = 3;

/**
 * Locates the samples where the output overloaded.
 *
 * With the limiter engaged the buffer never exceeds the ceiling, so the
 * gain-reduction envelope is what marks the overloaded regions; the peak within
 * each region is still at the same sample because the limiter's gain curve is
 * smooth and holds across it. With the limiter bypassed the overshoot is
 * visible in the samples directly.
 */
export function findOverloads(
  channels: Float32Array[],
  sampleRate: number,
  gainReductionDb: Float32Array | null,
): Overload[] {
  if (channels.length === 0 || channels[0].length === 0) return [];
  const length = channels[0].length;

  // Channel-linked, matching the limiter: one envelope over the loudest channel.
  const peakAt = (i: number): number => {
    let m = 0;
    for (const channel of channels) m = Math.max(m, Math.abs(channel[i]));
    return m;
  };

  const useGainReduction = gainReductionDb !== null && gainReductionDb.length > 0;
  const overloads: Overload[] = [];

  if (useGainReduction) {
    const hop = Math.max(1, Math.round(sampleRate * GAIN_REDUCTION_HOP_SECONDS));
    let regionStart = -1;
    for (let p = 0; p <= gainReductionDb.length; p++) {
      const active = p < gainReductionDb.length && gainReductionDb[p] > GAIN_REDUCTION_THRESHOLD_DB;
      if (active && regionStart < 0) regionStart = p;
      if (!active && regionStart >= 0) {
        const start = Math.min(length - 1, regionStart * hop);
        const end = Math.min(length, p * hop);
        let bestValue = -1;
        let bestIndex = start;
        let worstDb = 0;
        for (let q = regionStart; q < p; q++) worstDb = Math.max(worstDb, gainReductionDb[q]);
        for (let i = start; i < end; i++) {
          const v = peakAt(i);
          if (v > bestValue) {
            bestValue = v;
            bestIndex = i;
          }
        }
        overloads.push({
          sample: bestIndex,
          sign: channels[0][bestIndex] >= 0 ? 1 : -1,
          excessDb: worstDb,
        });
        regionStart = -1;
      }
    }
  } else {
    let regionStart = -1;
    for (let i = 0; i <= length; i++) {
      const active = i < length && peakAt(i) >= 1;
      if (active && regionStart < 0) regionStart = i;
      if (!active && regionStart >= 0) {
        let bestValue = -1;
        let bestIndex = regionStart;
        for (let j = regionStart; j < i; j++) {
          const v = peakAt(j);
          if (v > bestValue) {
            bestValue = v;
            bestIndex = j;
          }
        }
        overloads.push({
          sample: bestIndex,
          sign: channels[0][bestIndex] >= 0 ? 1 : -1,
          excessDb: 20 * Math.log10(Math.max(bestValue, 1)),
        });
        regionStart = -1;
      }
    }
  }

  if (overloads.length > MAX_OVERLOADS) {
    overloads.sort((a, b) => b.excessDb - a.excessDb);
    overloads.length = MAX_OVERLOADS;
  }
  return overloads;
}

/**
 * Standard deviation, in samples, of a band's Gaussian atom. The analysis sets
 * each filter's frequency-domain standard deviation to `overlap` times the local
 * band spacing; the time-domain width is its reciprocal.
 */
function atomSigmaSamples(centerFreqHz: number, sampleRate: number, bandsPerOctave: number, overlap: number): number {
  const fractionalFreq = centerFreqHz / sampleRate;
  const spacing = Math.pow(2, 1 / bandsPerOctave) - 1;
  const frequencySd = overlap * fractionalFreq * spacing;
  if (frequencySd <= 0) return 0;
  return 1 / (2 * Math.PI * frequencySd);
}

/**
 * Builds a per-coefficient map of signed contribution to the overloaded samples,
 * in the same packed layout as the spectrogram data so it can be uploaded as a
 * texture and read with the existing packed-coordinate helpers.
 *
 * Values are normalized to [-1, 1]: positive means the coefficient pushes the
 * waveform further past full scale, negative means it pulls it back.
 */
export function computeClipAttribution(
  spectrogramData: SpectrogramData,
  packedData: Float32Array,
  overloads: Overload[],
  overlap: number,
): Float32Array {
  const { textureWidth, textureHeight, numBands, numChannels, sampleRate, bandsPerOctave, metadata } = spectrogramData;
  const { bandOffsets, bandStepLog2s, bandLengths } = spectrogramData.synthesisMetadata;

  const attribution = new Float32Array(textureWidth * textureHeight);
  if (overloads.length === 0) return attribution;

  for (let band = 0; band < numBands; band++) {
    const centerFreqHz = metadata[band * 4 + 3];
    const sigma = atomSigmaSamples(centerFreqHz, sampleRate, bandsPerOctave, overlap);
    if (sigma <= 0) continue;

    const fractionalFreq = centerFreqHz / sampleRate;
    const stepLog2 = bandStepLog2s[band];
    const step = 1 << stepLog2;
    const bandLength = bandLengths[band];
    const bandOffset = bandOffsets[band];
    const reach = ATOM_SIGMA_CUTOFF * sigma;
    const twoSigmaSquared = 2 * sigma * sigma;

    for (const overload of overloads) {
      const t0 = overload.sample;
      // The carrier is evaluated at absolute time, so it is shared by every
      // coefficient in the band for this overload.
      const carrierAngle = 2 * Math.PI * fractionalFreq * t0;
      const first = Math.max(0, Math.ceil((t0 - reach) / step));
      const last = Math.min(bandLength - 1, Math.floor((t0 + reach) / step));

      for (let j = first; j <= last; j++) {
        const index = bandOffset + j;
        if (index >= attribution.length) break;
        const dt = j * step - t0;
        const envelope = Math.exp(-(dt * dt) / twoSigmaSquared);
        if (envelope < 1e-4) continue;

        // Take the louder channel: the limiter is channel-linked, so either
        // channel's partials can be what drives the peak.
        let contribution = 0;
        for (let channel = 0; channel < numChannels; channel++) {
          const magnitude = packedData[index * 4 + channel * 2];
          const phase = packedData[index * 4 + channel * 2 + 1];
          const value = magnitude * envelope * Math.cos(carrierAngle + phase);
          if (Math.abs(value) > Math.abs(contribution)) contribution = value;
        }

        // Positive when the coefficient pushes the waveform in the direction it
        // already overshot, weighted by how badly that sample overloaded.
        attribution[index] += contribution * overload.sign * overload.excessDb;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < attribution.length; i++) peak = Math.max(peak, Math.abs(attribution[i]));
  if (peak > 0) {
    for (let i = 0; i < attribution.length; i++) attribution[i] /= peak;
  }
  return attribution;
}
