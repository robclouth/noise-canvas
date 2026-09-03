/** Where a drop would land: above `beforeFileId`, or below the last lane. */
export type FileDropTarget = {
  beforeFileId: string | null;
  /** The group the drop joins, or null to leave it outside every group. */
  groupId: string | null;
  y: number;
};

/** One lane's vertical extent on screen, in the same space as the pointer. */
export type LaneBounds = { fileId: string; top: number; bottom: number; groupId: string | null };

/**
 * The group a drop at `clientY` lands in: the one whose lanes the pointer is
 * over. A group's lanes sit in one run, so its span is the first member's top
 * to the last member's bottom. The header strip above them reads as outside,
 * which is what leaves a way to drop a file above a group without joining it.
 */
function groupAt(clientY: number, lanes: LaneBounds[]): string | null {
  for (let start = 0; start < lanes.length; ) {
    const groupId = lanes[start].groupId;
    let end = start;
    while (end + 1 < lanes.length && lanes[end + 1].groupId === groupId) end++;
    if (groupId !== null && clientY >= lanes[start].top && clientY <= lanes[end].bottom) return groupId;
    start = end + 1;
  }
  return null;
}

/**
 * Picks the lane a pointer at `clientY` would drop into. `lanes` holds only the
 * lanes on screen, in stack order and without the one being dragged; `y` comes
 * back relative to `containerTop` so the indicator can be placed inside the
 * canvas column.
 */
export function resolveFileDrop(clientY: number, lanes: LaneBounds[], containerTop: number): FileDropTarget | null {
  const groupId = groupAt(clientY, lanes);
  let lastBottom: number | null = null;
  for (const lane of lanes) {
    if (clientY < (lane.top + lane.bottom) / 2) {
      return { beforeFileId: lane.fileId, groupId, y: lane.top - containerTop };
    }
    lastBottom = lane.bottom - containerTop;
  }
  return lastBottom === null ? null : { beforeFileId: null, groupId, y: lastBottom };
}

/**
 * Moves every id in `moving` into one run, in canvas order, at the place the
 * first of them already sits. A group draws as a single rail down a run of
 * adjacent lanes, so its members have to end up next to each other.
 */
export function gatherFileIds(ids: string[], moving: string[]): string[] {
  const inGroup = new Set(moving);
  const run = ids.filter((id) => inGroup.has(id));
  if (run.length === 0) return ids;

  const rest = ids.filter((id) => !inGroup.has(id));
  const at = ids.slice(0, ids.indexOf(run[0])).filter((id) => !inGroup.has(id)).length;
  return [...rest.slice(0, at), ...run, ...rest.slice(at)];
}

/**
 * Every group's members pulled into one run each, so no group can draw two
 * brackets. A group already sitting in one run keeps the place it has.
 */
export function gatherFileGroups(ids: string[], fileGroupOfFile: Record<string, string>): string[] {
  const runs = new Map<string, string[]>();
  for (const id of ids) {
    const groupId = fileGroupOfFile[id];
    if (!groupId) continue;
    const run = runs.get(groupId);
    if (run) run.push(id);
    else runs.set(groupId, [id]);
  }

  let result = ids;
  for (const run of runs.values()) {
    if (run.length > 1) result = gatherFileIds(result, run);
  }
  return result;
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
