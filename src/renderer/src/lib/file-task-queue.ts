// Serializes the operations that own a file's canvas, history and audio:
// stroke commits and history navigation. Each derives its result from the
// history's currentId/currentPacked and then replaces them, so two running at
// once fork the tree, mismatch a delta against the wrong base, or leave the
// audio buffer from the losing one in place. Painting itself is never queued —
// only the commit tail and the navigation that follow it.
const chains = new Map<string, Promise<unknown>>();

/** Runs `task` after every task already queued for `fileId`. */
export function serializeFileTask<T>(fileId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(fileId) ?? Promise.resolve();
  const result = prev.then(task);
  // The chain tail must never reject, or one failed task would wedge the queue.
  // Drop the entry once it drains so the map doesn't grow unbounded.
  const tail = result.then(
    () => {
      if (chains.get(fileId) === tail) chains.delete(fileId);
    },
    () => {
      if (chains.get(fileId) === tail) chains.delete(fileId);
    },
  );
  chains.set(fileId, tail);
  return result;
}

/** Forgets `fileId`'s chain. In-flight tasks still run to completion. */
export function clearFileTaskQueue(fileId: string): void {
  chains.delete(fileId);
}
