/** Where a drop would land: above `beforeFileId`, or below the last lane. */
export type FileDropTarget = { beforeFileId: string | null; y: number };

/** One lane's vertical extent on screen, in the same space as the pointer. */
export type LaneBounds = { fileId: string; top: number; bottom: number };

/**
 * Picks the lane a pointer at `clientY` would drop into. `lanes` holds only the
 * lanes on screen, in stack order and without the one being dragged; `y` comes
 * back relative to `containerTop` so the indicator can be placed inside the
 * canvas column.
 */
export function resolveFileDrop(clientY: number, lanes: LaneBounds[], containerTop: number): FileDropTarget | null {
  let lastBottom: number | null = null;
  for (const lane of lanes) {
    if (clientY < (lane.top + lane.bottom) / 2) return { beforeFileId: lane.fileId, y: lane.top - containerTop };
    lastBottom = lane.bottom - containerTop;
  }
  return lastBottom === null ? null : { beforeFileId: null, y: lastBottom };
}

/**
 * Moves `fileId` so it sits directly before `beforeFileId`, or last when that is
 * null. Returns `ids` unchanged if the file is not in it.
 */
export function reorderFileIds(ids: string[], fileId: string, beforeFileId: string | null): string[] {
  if (fileId === beforeFileId || !ids.includes(fileId)) return ids;
  const rest = ids.filter((id) => id !== fileId);
  const before = beforeFileId === null ? -1 : rest.indexOf(beforeFileId);
  if (before === -1) return [...rest, fileId];
  return [...rest.slice(0, before), fileId, ...rest.slice(before)];
}
