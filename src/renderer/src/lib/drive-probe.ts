/** One committed dab as a driver sees it: its brush rectangle in file UV (pitch y-up) and when it was asked for and painted. */
export interface DabRecord {
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  requestedAt: number;
  paintedAt: number | null;
}

/** The dab log a driver installed on `globalThis.__dabLog`, or undefined in normal use. */
export function driveDabLog(): DabRecord[] | undefined {
  return (globalThis as { __dabLog?: DabRecord[] }).__dabLog;
}

/** Logs a dab asked for now, when a driver is listening; the caller sets `paintedAt` once it lands. */
export function recordDab(fileId: string, x: number, y: number, width: number, height: number): DabRecord | null {
  const log = driveDabLog();
  if (!log) return null;
  const record: DabRecord = { fileId, x, y, width, height, requestedAt: Date.now(), paintedAt: null };
  log.push(record);
  return record;
}
