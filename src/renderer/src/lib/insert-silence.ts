/** The sample index an insert splits `length` samples at, clamped inside it. */
export function silenceCutSample(length: number, cutSample: number): number {
  return Math.min(length, Math.max(0, Math.round(cutSample)));
}

/** Copies of `channels` with `padSamples` of silence spliced in at `cutSample`. */
export function insertSilence(channels: Float32Array[], cutSample: number, padSamples: number): Float32Array[] {
  if (padSamples <= 0) return channels;

  return channels.map((source) => {
    const cut = silenceCutSample(source.length, cutSample);
    const result = new Float32Array(source.length + padSamples);
    result.set(source.subarray(0, cut), 0);
    result.set(source.subarray(cut), cut + padSamples);
    return result;
  });
}
