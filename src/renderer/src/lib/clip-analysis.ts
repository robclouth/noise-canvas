/**
 * The parts of a file's analysis that attribution reads. `SpectrogramData`
 * satisfies it structurally; naming it here keeps this module free of the
 * renderer's store and so loadable outside the browser.
 */
export interface ClipAnalysisLayout {
  textureWidth: number;
  textureHeight: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  bandsPerOctave: number;
  metadata: Float32Array;
  synthesisMetadata: {
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

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

/**
 * How far below the buffer's ceiling a peak may sit and still count as one the
 * limiter is holding down. A quieter peak under the same gain reduction is the
 * envelope still releasing from an earlier one.
 */
const CEILING_TOLERANCE_DB = 1;

/** Gaussian atom is truncated beyond this many standard deviations. */
const ATOM_SIGMA_CUTOFF = 3;

/**
 * Locates the samples where the output overloaded.
 *
 * With the limiter engaged the buffer never exceeds the ceiling, so the
 * gain-reduction envelope is what marks them. Its release outlasts the peak that
 * triggered it and on dense material never returns to zero, so each hop is
 * judged on its own and counts only when its loudest sample reaches the ceiling.
 * With the limiter bypassed the overshoot is visible in the samples directly.
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

    // The ceiling the limiter is holding to, read off the buffer itself so it
    // needs no knowledge of the limiter's constant.
    let ceiling = 0;
    for (let i = 0; i < length; i++) ceiling = Math.max(ceiling, peakAt(i));
    const floor = ceiling * Math.pow(10, -CEILING_TOLERANCE_DB / 20);

    for (let p = 0; p < gainReductionDb.length; p++) {
      if (gainReductionDb[p] <= GAIN_REDUCTION_THRESHOLD_DB) continue;
      const start = Math.min(length - 1, p * hop);
      const end = Math.min(length, start + hop);
      let bestValue = -1;
      let bestIndex = start;
      for (let i = start; i < end; i++) {
        const v = peakAt(i);
        if (v > bestValue) {
          bestValue = v;
          bestIndex = i;
        }
      }
      if (bestValue < floor) continue;
      overloads.push({
        sample: bestIndex,
        sign: channels[0][bestIndex] >= 0 ? 1 : -1,
        excessDb: gainReductionDb[p],
      });
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
 * Values land in [-1, 1]: positive means the coefficient pushes the waveform
 * further past full scale, negative means it pulls it back.
 *
 * Magnitude combines two things. Within a single overload, contributions are
 * scaled against the strongest one, which is what ranks the coefficients at that
 * instant. That share is then multiplied by an absolute severity taken from how
 * far the sample actually overloaded, so the whole map fades as the overshoot is
 * reduced. Scaling the map to its own maximum instead would keep it saturated at
 * every stage — the worst remaining offender always reading full red — which
 * hides any progress until the overload disappears entirely.
 *
 * Where overloads overlap, the strongest single verdict wins rather than the sum:
 * a coefficient's tint should say how badly it drives the worst peak it takes
 * part in, not how many peaks it happens to touch.
 */
export function computeClipAttribution(
  spectrogramData: ClipAnalysisLayout,
  packedData: Float32Array,
  overloads: Overload[],
  overlap: number,
  fullTintDb: number,
): Float32Array {
  const { textureWidth, textureHeight, numBands, numChannels, sampleRate, bandsPerOctave, metadata } = spectrogramData;
  const { bandOffsets, bandStepLog2s, bandLengths } = spectrogramData.synthesisMetadata;

  const attribution = new Float32Array(textureWidth * textureHeight);
  if (overloads.length === 0) return attribution;

  // Per-band atom geometry, independent of which overload is being attributed.
  const sigmas = new Float64Array(numBands);
  const fractionalFreqs = new Float64Array(numBands);
  for (let band = 0; band < numBands; band++) {
    const centerFreqHz = metadata[band * 4 + 3];
    sigmas[band] = atomSigmaSamples(centerFreqHz, sampleRate, bandsPerOctave, overlap);
    fractionalFreqs[band] = centerFreqHz / sampleRate;
  }

  // Scratch buffers for one overload's contributions, reused across overloads.
  const touched: number[] = [];
  const contributions: number[] = [];

  for (const overload of overloads) {
    touched.length = 0;
    contributions.length = 0;
    let strongest = 0;

    const t0 = overload.sample;
    for (let band = 0; band < numBands; band++) {
      const sigma = sigmas[band];
      if (sigma <= 0) continue;

      const step = 1 << bandStepLog2s[band];
      const bandOffset = bandOffsets[band];
      const reach = ATOM_SIGMA_CUTOFF * sigma;
      const twoSigmaSquared = 2 * sigma * sigma;
      // The carrier is evaluated at absolute time, so every coefficient in the
      // band shares it for this overload.
      const carrierAngle = 2 * Math.PI * fractionalFreqs[band] * t0;
      const first = Math.max(0, Math.ceil((t0 - reach) / step));
      const last = Math.min(bandLengths[band] - 1, Math.floor((t0 + reach) / step));

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
        if (contribution === 0) continue;

        // Positive when the coefficient pushes the waveform in the direction it
        // already overshot.
        const signed = contribution * overload.sign;
        touched.push(index);
        contributions.push(signed);
        strongest = Math.max(strongest, Math.abs(signed));
      }
    }

    if (strongest <= 0) continue;
    const severity = Math.min(1, overload.excessDb / Math.max(fullTintDb, 1e-3));
    for (let k = 0; k < touched.length; k++) {
      const index = touched[k];
      const value = (contributions[k] / strongest) * severity;
      if (Math.abs(value) > Math.abs(attribution[index])) attribution[index] = value;
    }
  }

  return attribution;
}
