/**
 * A forced pretend-window over a whole-file packed texture, for driving the
 * display's overview fallback before real windows exist.
 *
 * The fraction is the share of the file the display treats as resident, centred
 * on the file; 0 leaves it reading the whole file. Reads inside the pretend
 * window address exactly the texels they always did, so nothing but the
 * fallback branch changes.
 */
let pretendWindowFraction = 0;
const listeners = new Set<() => void>();

export function getPretendWindowFraction(): number {
  return pretendWindowFraction;
}

export function setPretendWindowFraction(fraction: number): void {
  const clamped = Math.min(Math.max(0, fraction), 1);
  if (clamped === pretendWindowFraction) return;
  pretendWindowFraction = clamped;
  for (const listener of listeners) listener();
}

export function subscribePretendWindow(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (import.meta.env.DEV || import.meta.env.VITE_DEBUG_GLOBALS) {
  (globalThis as unknown as { __paging?: unknown }).__paging = {
    getPretendWindowFraction,
    setPretendWindowFraction,
  };
}
