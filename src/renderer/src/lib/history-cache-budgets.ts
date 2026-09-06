const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * In-memory cache budgets: the per-stroke coefficient deltas that carry undo
 * and redo, the audio either side of each hop's window, and the decoded
 * blocks a file's packed-state store keeps resident. Full size from 16 GiB of
 * system memory, a quarter of it at 8 GiB, and in proportion between; the
 * block budget keeps growing past 16 GiB, by a sixteenth of the memory above.
 */
export function historyCacheBudgets(totalMemoryBytes: number): {
  deltas: number;
  audioHops: number;
  blockResident: number;
} {
  const position = Math.min(1, Math.max(0, (totalMemoryBytes - 8 * GIB) / (8 * GIB)));
  const scale = 0.25 + 0.75 * position;
  const above = Math.max(0, totalMemoryBytes - 16 * GIB);
  return {
    deltas: Math.round(128 * MIB * scale),
    audioHops: Math.round(256 * MIB * scale),
    blockResident: Math.round(256 * MIB * scale + above / 16),
  };
}
