const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * In-memory cache budgets: decoded packed states, the per-stroke coefficient
 * deltas that carry undo and redo, and the audio either side of each hop's
 * window. Full size from 16 GiB of system memory, a quarter of it at 8 GiB,
 * and in proportion between.
 */
export function historyCacheBudgets(totalMemoryBytes: number): {
  packedStates: number;
  deltas: number;
  audioHops: number;
} {
  const position = Math.min(1, Math.max(0, (totalMemoryBytes - 8 * GIB) / (8 * GIB)));
  const scale = 0.25 + 0.75 * position;
  return {
    packedStates: Math.round(256 * MIB * scale),
    deltas: Math.round(128 * MIB * scale),
    audioHops: Math.round(256 * MIB * scale),
  };
}
