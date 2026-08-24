/** Where an insert puts its silence: before the audio, at the play start, or after it. */
export type SilencePosition = "start" | "play-start" | "end";

/** What the Insert Silence dialog collects. */
export type InsertSilenceValues = { length: number; unit: "beats" | "seconds"; position: SilencePosition };

/** The sample index an insert at `position` splits `length` samples at. */
export function silenceCutSample(position: SilencePosition, length: number, playStartSample: number): number {
  if (position === "start") return 0;
  if (position === "end") return length;
  return Math.min(length, Math.max(0, Math.round(playStartSample)));
}

/**
 * Copies of `channels` with `padSamples` of silence spliced in at `position`.
 * `playStartSample` places a "play-start" insert; the others ignore it.
 */
export function insertSilence(
  channels: Float32Array[],
  position: SilencePosition,
  padSamples: number,
  playStartSample: number,
): Float32Array[] {
  if (padSamples <= 0) return channels;

  return channels.map((source) => {
    const cut = silenceCutSample(position, source.length, playStartSample);
    const result = new Float32Array(source.length + padSamples);
    result.set(source.subarray(0, cut), 0);
    result.set(source.subarray(cut), cut + padSamples);
    return result;
  });
}
