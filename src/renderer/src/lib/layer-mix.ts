/** Range of a layer's volume box, in dB. */
export const MIN_LAYER_VOLUME_DB = -60;
export const MAX_LAYER_VOLUME_DB = 12;
export const DEFAULT_LAYER_VOLUME_DB = 0;

/** The per-layer mix settings, as the store holds them. */
export interface LayerMix {
  muted: Record<string, boolean>;
  soloed: Record<string, boolean>;
  volumeDb: Record<string, number>;
}

/**
 * Linear gain for a dB setting. The bottom of the range is silence rather than
 * the -60 dB it names, so a box dragged to the end mutes rather than leaving a
 * whisper under everything else.
 */
export function layerVolumeGain(db: number): number {
  if (db <= MIN_LAYER_VOLUME_DB) return 0;
  return 10 ** (db / 20);
}

/** Whether any layer of a stack is soloed. Mute does not lift another's solo. */
export function stackHasSolo(mix: LayerMix, stackLayerIds: readonly string[]): boolean {
  return stackLayerIds.some((id) => mix.soloed[id] === true);
}

/**
 * Linear gain one layer plays at, inside the stack it belongs to. Mute wins
 * over solo on the same layer, so soloing and muting one layer leaves silence.
 */
export function layerGain(mix: LayerMix, stackLayerIds: readonly string[], layerId: string): number {
  if (mix.muted[layerId]) return 0;
  if (stackHasSolo(mix, stackLayerIds) && !mix.soloed[layerId]) return 0;
  return layerVolumeGain(mix.volumeDb[layerId] ?? DEFAULT_LAYER_VOLUME_DB);
}

/** The span of a buffer playback covers: a loop region, clamped to the buffer. */
export interface PlaybackWindow {
  start: number;
  end: number;
}

/**
 * The window a region asks for, bounded by the buffer. A region measured
 * against an older, longer file cannot push the loop points past the end.
 */
export function clampPlaybackWindow(
  region: { start: number; end: number } | null | undefined,
  duration: number,
): PlaybackWindow {
  const end = Math.min(region?.end ?? duration, duration);
  return { start: Math.min(region?.start ?? 0, end), end };
}
