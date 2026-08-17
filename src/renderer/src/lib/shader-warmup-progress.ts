/**
 * Transient progress of the background shader warmup.
 *
 * Kept out of the zustand store because it ticks once per linked program while
 * the user is already working: a store write would re-render every subscriber
 * of the app state for a readout only the menu bar shows.
 */
export type ShaderWarmupProgress = { done: number; total: number };

const IDLE: ShaderWarmupProgress = { done: 0, total: 0 };

let progress: ShaderWarmupProgress = IDLE;
const listeners = new Set<() => void>();

export function setShaderWarmupProgress(done: number, total: number): void {
  progress = done >= total ? IDLE : { done, total };
  for (const listener of listeners) listener();
}

export function subscribeShaderWarmupProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getShaderWarmupProgress(): ShaderWarmupProgress {
  return progress;
}
