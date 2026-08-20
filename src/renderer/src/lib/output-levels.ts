/** Slice of output the strip resolves, matching the limiter's envelope hop. */
export const LEVEL_HOP_SECONDS = 0.005;

/**
 * Reconstruction ripple the synthesis round trip can add to full-scale
 * material on its own (measured up to ~0.7 dB on peak-normalised noise).
 * Sample peaks within it do not count as over.
 */
export const OVER_TOLERANCE_DB = 1;

export interface OutputLevels {
  /** Peak sample magnitude per hop, linear, where 1 is full scale. */
  peaks: Float32Array;
  /**
   * dB the samples pass full scale beyond the tolerance, per hop; 0 where
   * the output stayed inside headroom.
   */
  overDb: Float32Array;
}

/**
 * Per-hop peak level of a whole buffer, and how far it ran out of headroom.
 *
 * Nothing limits the output as a whole any more, so a slice past full scale
 * (beyond the round trip's own ripple) is the only thing that counts as
 * overloaded here. A commit measures its own window and splices the result
 * in; this is for the passes that replace the whole buffer.
 */
export function computeOutputLevels(audioBuffer: AudioBuffer | undefined): OutputLevels | null {
  if (!audioBuffer) return null;

  const { sampleRate, length, numberOfChannels } = audioBuffer;
  const hop = Math.max(1, Math.round(sampleRate * LEVEL_HOP_SECONDS));
  const points = Math.max(1, Math.ceil(length / hop));

  const peaks = new Float32Array(points);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const samples = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const magnitude = Math.abs(samples[i]);
      const point = (i / hop) | 0;
      if (magnitude > peaks[point]) peaks[point] = magnitude;
    }
  }

  const overDb = new Float32Array(points);
  for (let point = 0; point < points; point++) {
    if (peaks[point] <= 1) continue;
    const db = 20 * Math.log10(peaks[point]);
    if (db > OVER_TOLERANCE_DB) overDb[point] = db - OVER_TOLERANCE_DB;
  }

  return { peaks, overDb };
}

/**
 * Writes a commit's own measurements of its window into the levels of the
 * whole file, growing the arrays if the buffer got longer. Returns a new
 * object, so a repaint keyed on identity sees the change.
 */
export function spliceOutputLevels(
  existing: OutputLevels | undefined,
  window: { startHop: number; peaks: Float32Array; overDb: Float32Array },
  totalPoints: number,
): OutputLevels {
  const peaks = new Float32Array(totalPoints);
  const overDb = new Float32Array(totalPoints);
  if (existing) {
    peaks.set(existing.peaks.subarray(0, Math.min(existing.peaks.length, totalPoints)));
    overDb.set(existing.overDb.subarray(0, Math.min(existing.overDb.length, totalPoints)));
  }

  const count = Math.min(window.peaks.length, Math.max(0, totalPoints - window.startHop));
  for (let i = 0; i < count; i++) {
    peaks[window.startHop + i] = window.peaks[i];
    overDb[window.startHop + i] = window.overDb[i];
  }
  return { peaks, overDb };
}

/** How many hops a buffer of this length covers. */
export function outputLevelPoints(audioBuffer: AudioBuffer): number {
  const hop = Math.max(1, Math.round(audioBuffer.sampleRate * LEVEL_HOP_SECONDS));
  return Math.max(1, Math.ceil(audioBuffer.length / hop));
}

/**
 * A buffer's levels over one span of samples, in the form a commit reports for
 * its window, so a spliced edit can refresh just the hops it touched.
 */
export function measureOutputLevels(
  audioBuffer: AudioBuffer,
  startFrame: number,
  endFrame: number,
): { startHop: number; peaks: Float32Array; overDb: Float32Array } {
  const { sampleRate, length, numberOfChannels } = audioBuffer;
  const hop = Math.max(1, Math.round(sampleRate * LEVEL_HOP_SECONDS));
  const startHop = Math.max(0, Math.floor(startFrame / hop));
  const endHop = Math.min(outputLevelPoints(audioBuffer), Math.max(startHop, Math.ceil(endFrame / hop)));
  const points = Math.max(0, endHop - startHop);
  const peaks = new Float32Array(points);
  const overDb = new Float32Array(points);
  const first = startHop * hop;
  const last = Math.min(length, endHop * hop);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const samples = audioBuffer.getChannelData(channel);
    for (let i = first; i < last; i++) {
      const magnitude = Math.abs(samples[i]);
      const point = ((i / hop) | 0) - startHop;
      if (magnitude > peaks[point]) peaks[point] = magnitude;
    }
  }
  for (let point = 0; point < points; point++) {
    if (peaks[point] <= 1) continue;
    const db = 20 * Math.log10(peaks[point]);
    if (db > OVER_TOLERANCE_DB) overDb[point] = db - OVER_TOLERANCE_DB;
  }
  return { startHop, peaks, overDb };
}
