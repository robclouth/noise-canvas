/** Slice of output the strip resolves, matching the limiter's envelope hop. */
export const LEVEL_HOP_SECONDS = 0.005;

/** Gain reduction above which the limiter counts as holding a slice down. */
const GAIN_REDUCTION_THRESHOLD_DB = 0.1;

export interface OutputLevels {
  /** Peak sample magnitude per hop, linear, where 1 is full scale. */
  peaks: Float32Array;
  /** True where the output ran out of headroom, one entry per hop. */
  clipped: Uint8Array;
}

const cache = new WeakMap<AudioBuffer, OutputLevels>();

/**
 * Per-hop peak level of a synthesized output, and where it ran out of headroom.
 *
 * With the limiter engaged the buffer cannot exceed the ceiling, so the
 * limiter's own gain-reduction envelope is what marks those slices; bypassed,
 * the samples pass full scale directly. Cached against the audio buffer, so a
 * new synthesis recomputes and repeated draws do not.
 */
export function getOutputLevels(
  audioBuffer: AudioBuffer | undefined,
  gainReductionDb: Float32Array | undefined,
): OutputLevels | null {
  if (!audioBuffer) return null;

  const cached = cache.get(audioBuffer);
  if (cached) return cached;

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
  if (gainReductionDb && gainReductionDb.length > 0) {
    // The envelope spans the buffer evenly rather than sharing this hop count.
    for (let point = 0; point < points; point++) {
      const index = Math.min(gainReductionDb.length - 1, Math.floor((point / points) * gainReductionDb.length));
      clipped[point] = gainReductionDb[index] > GAIN_REDUCTION_THRESHOLD_DB ? 1 : 0;
    }
  } else {
    for (let point = 0; point < points; point++) clipped[point] = peaks[point] >= 1 ? 1 : 0;
  }

  const levels: OutputLevels = { peaks, clipped };
  cache.set(audioBuffer, levels);
  return levels;
}
