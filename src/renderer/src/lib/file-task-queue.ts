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

// One chain, across every file, for user-issued edit commands (cut/paste/
// duplicate time, duplicate/silence selection, resize). A command reads the
// selection, duration, onsets and clipboard it splices when it starts running,
// so it must not start until the command before it has fully applied — two in
// flight both derive from the state before either landed.
let editCommandTail: Promise<unknown> = Promise.resolve();

/** Runs `command` after every edit command issued before it, in press order. */
export function serializeEditCommand<T>(command: () => Promise<T>): Promise<T> {
  const result = editCommandTail.then(command);
  // The chain tail must never reject, or one failed command would wedge it.
  editCommandTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Resolves once every task queued now, for every file, has run. Tasks queued
 * after the call are not waited for. Never rejects — the chain tails already
 * swallow failures.
 */
export async function drainFileTaskQueues(): Promise<void> {
  // Pending edit commands first: each queues its file tasks only when it runs.
  await editCommandTail;
  await Promise.all([...chains.values()]);
}
