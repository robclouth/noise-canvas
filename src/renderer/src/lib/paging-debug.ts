/**
 * The switches that turn paging on before it has a setting of its own.
 *
 * `pretendWindowFraction` forces a pretend window over a whole-file packed
 * texture: the share of the file the display treats as resident, centred on the
 * file, 0 leaving it reading the whole file. Reads inside it address exactly the
 * texels they always did, so nothing but the fallback branch changes.
 *
 * `pagedWindows` is the real thing: the packed texture, the inverse map and the
 * FBOs hold only the span the view needs.
 */
let pretendWindowFraction = 0;
let pagedWindows = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getPretendWindowFraction(): number {
  return pretendWindowFraction;
}

export function setPretendWindowFraction(fraction: number): void {
  const clamped = Math.min(Math.max(0, fraction), 1);
  if (clamped === pretendWindowFraction) return;
  pretendWindowFraction = clamped;
  notify();
}

export function getPagedWindows(): boolean {
  return pagedWindows;
}

export function setPagedWindows(enabled: boolean): void {
  if (enabled === pagedWindows) return;
  pagedWindows = enabled;
  notify();
}

export function subscribePaging(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (import.meta.env.DEV || import.meta.env.VITE_DEBUG_GLOBALS) {
  (globalThis as unknown as { __paging?: unknown }).__paging = {
    getPretendWindowFraction,
    setPretendWindowFraction,
    getPagedWindows,
    setPagedWindows,
  };
}
