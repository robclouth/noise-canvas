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
 * `[timeSec, salience]` onset pairs with `[startSec, endSec)` removed and
 * later times pulled earlier — the same move `removeSpan` makes on the audio.
 * Pairs within `guardSec` of the seam are dropped: the declick fades reshape
 * that sliver.
 */
export function removeOnsetSpan(onsets: Float32Array, startSec: number, endSec: number, guardSec = 0): Float32Array {
  const out: number[] = [];
  const span = Math.max(0, endSec - startSec);
  for (let i = 0; i + 1 < onsets.length; i += 2) {
    const time = onsets[i];
    if (time >= startSec - guardSec && time < endSec + guardSec) continue;
    out.push(time >= endSec ? time - span : time, onsets[i + 1]);
  }
  return new Float32Array(out);
}

/**
 * `[timeSec, salience]` onset pairs with `insert`'s pairs (in the insert's own
 * time, 0 at its start) spliced in at `atSec`, pushing later times back — the
 * same move `insertSpan` makes on the audio. Pairs within `guardSec` of a seam
 * are dropped.
 */
export function insertOnsetSpan(
  onsets: Float32Array,
  atSec: number,
  spanSec: number,
  insert: Float32Array,
  guardSec = 0,
): Float32Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < onsets.length; i += 2) {
    const time = onsets[i];
    if (Math.abs(time - atSec) < guardSec) continue;
    if (time < atSec) out.push(time, onsets[i + 1]);
  }
  for (let i = 0; i + 1 < insert.length; i += 2) {
    const time = insert[i];
    if (time < guardSec || time > spanSec - guardSec) continue;
    out.push(atSec + time, insert[i + 1]);
  }
  for (let i = 0; i + 1 < onsets.length; i += 2) {
    const time = onsets[i];
    if (Math.abs(time - atSec) < guardSec) continue;
    if (time >= atSec) out.push(time + spanSec, onsets[i + 1]);
  }
  return new Float32Array(out);
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
