/**
 * Fit audio channels to `channelCount`. Mixing down to one channel sums every
 * channel at equal weight; adding channels copies the last one across them.
 * Returns the same arrays when the count already matches.
 */
export function toChannelCount(channels: Float32Array[], channelCount: number): Float32Array[] {
  if (channels.length === 0 || channels.length === channelCount) return channels;

  if (channelCount === 1) {
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    }
    return [mono];
  }

  return Array.from({ length: channelCount }, (_, ch) => new Float32Array(channels[Math.min(ch, channels.length - 1)]));
}
