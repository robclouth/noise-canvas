/** Copies of `channels` cut short, or padded with silence, to `targetSamples`. */
export function setChannelsLength(channels: Float32Array[], targetSamples: number): Float32Array[] {
  const target = Math.max(1, Math.round(targetSamples));
  return channels.map((source) => {
    if (source.length === target) return source;
    const result = new Float32Array(target);
    result.set(source.subarray(0, Math.min(source.length, target)), 0);
    return result;
  });
}
