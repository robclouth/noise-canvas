/**
 * Ramps the samples on both sides of a seam to zero, linearly over
 * `fadeSamples`, so a splice cannot click. Both sides reach silence exactly at
 * the seam.
 */
function declickSeam(channel: Float32Array, seam: number, fadeSamples: number): void {
  if (fadeSamples <= 0) return;
  for (let k = 0; k < fadeSamples; k++) {
    const factor = k / fadeSamples;
    const before = seam - 1 - k;
    const after = seam + k;
    if (before >= 0) channel[before] *= factor;
    if (after < channel.length) channel[after] *= factor;
  }
}

/**
 * Copies of `channels` with `[startSample, endSample)` removed and the gap
 * closed, declicked at the join.
 */
export function removeSpan(
  channels: Float32Array[],
  startSample: number,
  endSample: number,
  fadeSamples = 0,
): Float32Array[] {
  return channels.map((source) => {
    const start = Math.max(0, Math.min(source.length, Math.round(startSample)));
    const end = Math.max(start, Math.min(source.length, Math.round(endSample)));
    const result = new Float32Array(source.length - (end - start));
    result.set(source.subarray(0, start), 0);
    result.set(source.subarray(end), start);
    if (end > start) declickSeam(result, start, fadeSamples);
    return result;
  });
}

/**
 * Copies of `channels` with `insert`'s samples spliced in at `atSample`,
 * pushing everything after it later and declicking both seams. A channel the
 * insert does not carry repeats its first one, so mono material lands in both
 * sides of a stereo file.
 */
export function insertSpan(
  channels: Float32Array[],
  atSample: number,
  insert: Float32Array[],
  fadeSamples = 0,
): Float32Array[] {
  const insertLength = insert[0]?.length ?? 0;
  return channels.map((source, ch) => {
    const at = Math.max(0, Math.min(source.length, Math.round(atSample)));
    const result = new Float32Array(source.length + insertLength);
    result.set(source.subarray(0, at), 0);
    const inserted = insert[ch] ?? insert[0];
    if (inserted) result.set(inserted.subarray(0, insertLength), at);
    result.set(source.subarray(at), at + insertLength);
    if (insertLength > 0) {
      declickSeam(result, at, Math.min(fadeSamples, insertLength));
      declickSeam(result, at + insertLength, Math.min(fadeSamples, insertLength));
    }
    return result;
  });
}
