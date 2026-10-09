/** The per-layer mix settings, as the store holds them. */
export interface LayerMix {
  muted: Record<string, boolean>;
  soloed: Record<string, boolean>;
}

/** Whether any layer of a stack is soloed. Mute does not lift another's solo. */
export function stackHasSolo(mix: LayerMix, stackLayerIds: readonly string[]): boolean {
  return stackLayerIds.some((id) => mix.soloed[id] === true);
}

/**
 * Linear gain one layer plays at, inside the stack it belongs to: 1 when it
 * sounds, 0 when it does not. Mute wins over solo on the same layer, so
 * soloing and muting one layer leaves silence.
 */
export function layerGain(mix: LayerMix, stackLayerIds: readonly string[], layerId: string): number {
  if (mix.muted[layerId]) return 0;
  if (stackHasSolo(mix, stackLayerIds) && !mix.soloed[layerId]) return 0;
  return 1;
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
