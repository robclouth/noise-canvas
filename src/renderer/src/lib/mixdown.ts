import { toChannelCount } from "./channel-mix";

/** The channel count and length a set of parts mixes down to: the widest and the longest. */
export function mixdownShape(parts: Float32Array[][]): { numChannels: number; length: number } {
  let numChannels = 0;
  let length = 0;
  for (const part of parts) {
    numChannels = Math.max(numChannels, part.length);
    length = Math.max(length, part[0]?.length ?? 0);
  }
  return { numChannels, length };
}

/**
 * Sums `parts` into one set of channels. Every part must already be at the same
 * sample rate. A part with fewer channels is fitted to the mix the same way a
 * file changing channel count is, and one that ends early runs out into silence.
 */
export function mixdown(parts: Float32Array[][]): Float32Array[] {
  const { numChannels, length } = mixdownShape(parts);
  if (numChannels === 0 || length === 0) return [];

  const mix = Array.from({ length: numChannels }, () => new Float32Array(length));
  for (const part of parts) {
    const fitted = toChannelCount(part, numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
      const source = fitted[ch];
      if (!source) continue;
      const target = mix[ch];
      for (let i = 0; i < source.length; i++) target[i] += source[i];
    }
  }
  return mix;
}
