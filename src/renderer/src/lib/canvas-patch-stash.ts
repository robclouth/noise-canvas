import type { PhaseTurns } from "../../../main/lib/types";

/**
 * A projection patch whose FBO upload was skipped because a newer stroke was
 * already on the canvas. The next commit uploads it at its own safe moment;
 * any restore from history makes it stale, so restores must clear it.
 */
export interface CanvasPatchStash {
  /** Full packed array holding the patched values. */
  data: Float32Array;
  /** Flat [pixelStart, pixelCount, ...] list of the pixels the canvas misses. */
  ranges: Uint32Array;
  /** Phase turns the canvas has not yet taken, in the order they were made. */
  turns: PhaseTurns[];
}

const stashes = new Map<string, CanvasPatchStash>();

/** Removes and returns the file's stash, so only one commit can apply it. */
export function takeCanvasPatchStash(fileId: string): CanvasPatchStash | null {
  const stash = stashes.get(fileId) ?? null;
  stashes.delete(fileId);
  return stash;
}

export function setCanvasPatchStash(fileId: string, stash: CanvasPatchStash): void {
  stashes.set(fileId, stash);
}

export function clearCanvasPatchStash(fileId: string): void {
  stashes.delete(fileId);
}

/** Number of files holding a stash. Used by tests to check nothing is retained. */
export function canvasPatchStashCount(): number {
  return stashes.size;
}
