let position: { x: number; y: number } | null = null;

/** Records the pointer's client position; fed from one window-level listener. */
export function trackPointer(x: number, y: number): void {
  position = { x, y };
}

/** The pointer's last known client position, or null before it has moved. */
export function lastPointer(): { x: number; y: number } | null {
  return position;
}
