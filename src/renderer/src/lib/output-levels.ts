/** Slice of output the strip resolves, matching the limiter's envelope hop. */
export const LEVEL_HOP_SECONDS = 0.005;

export interface OutputLevels {
  /** Peak sample magnitude per hop, linear, where 1 is full scale. */
  peaks: Float32Array;
  /** True where the output ran out of headroom, one entry per hop. */
  clipped: Uint8Array;
}

/**
 * Per-hop peak level of a whole buffer, and where it ran out of headroom.
 *
 * Nothing limits the output as a whole any more, so a slice at or past full
 * scale is the only thing that counts as overloaded here. A commit measures
 * its own window and splices the result in; this is for the passes that
 * replace the whole buffer.
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

  const clipped = new Uint8Array(points);
  for (let point = 0; point < points; point++) clipped[point] = peaks[point] >= 1 ? 1 : 0;

  return { peaks, clipped };
}

/**
 * Writes a commit's own measurements of its window into the levels of the
 * whole file, growing the arrays if the buffer got longer. Returns a new
 * object, so a repaint keyed on identity sees the change.
 */
export function spliceOutputLevels(
  existing: OutputLevels | undefined,
  window: { startHop: number; peaks: Float32Array; clipped: Uint8Array },
  totalPoints: number,
): OutputLevels {
  const peaks = new Float32Array(totalPoints);
  const clipped = new Uint8Array(totalPoints);
  if (existing) {
    peaks.set(existing.peaks.subarray(0, Math.min(existing.peaks.length, totalPoints)));
    clipped.set(existing.clipped.subarray(0, Math.min(existing.clipped.length, totalPoints)));
  }

  const count = Math.min(window.peaks.length, Math.max(0, totalPoints - window.startHop));
  for (let i = 0; i < count; i++) {
    peaks[window.startHop + i] = window.peaks[i];
    clipped[window.startHop + i] = window.clipped[i];
  }
  return { peaks, clipped };
}

/** How many hops a buffer of this length covers. */
export function outputLevelPoints(audioBuffer: AudioBuffer): number {
  const hop = Math.max(1, Math.round(audioBuffer.sampleRate * LEVEL_HOP_SECONDS));
  return Math.max(1, Math.ceil(audioBuffer.length / hop));
}
