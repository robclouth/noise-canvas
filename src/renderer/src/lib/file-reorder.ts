/** Where a drop would land: above `beforeFileId`, or below the last layer. */
export type FileDropTarget = {
  beforeFileId: string | null;
  /** The group the drop joins, or null to leave it outside every group. */
  stackId: string | null;
  y: number;
};

/** One layer's vertical extent on screen, in the same space as the pointer. */
export type LayerBounds = { fileId: string; top: number; bottom: number; stackId: string | null };

/**
 * The group a drop at `clientY` lands in: the one whose layers the pointer is
 * over. A group's layers sit in one run, so its span is the first member's top
 * to the last member's bottom. The header strip above them reads as outside,
 * which is what leaves a way to drop a file above a group without joining it.
 */
function groupAt(clientY: number, layers: LayerBounds[]): string | null {
  for (let start = 0; start < layers.length; ) {
    const stackId = layers[start].stackId;
    let end = start;
    while (end + 1 < layers.length && layers[end + 1].stackId === stackId) end++;
    if (stackId !== null && clientY >= layers[start].top && clientY <= layers[end].bottom) return stackId;
    start = end + 1;
  }
  return null;
}

/**
 * Picks the layer a pointer at `clientY` would drop into. `layers` holds only the
 * layers on screen, in stack order and without the one being dragged; `y` comes
 * back relative to `containerTop` so the indicator can be placed inside the
 * canvas column.
 */
export function resolveFileDrop(clientY: number, layers: LayerBounds[], containerTop: number): FileDropTarget | null {
  const stackId = groupAt(clientY, layers);
  let lastBottom: number | null = null;
  for (const layer of layers) {
    if (clientY < (layer.top + layer.bottom) / 2) {
      return { beforeFileId: layer.fileId, stackId, y: layer.top - containerTop };
    }
    lastBottom = layer.bottom - containerTop;
  }
  return lastBottom === null ? null : { beforeFileId: null, stackId, y: lastBottom };
}

/**
 * Moves every id in `moving` into one run, in canvas order, at the place the
 * first of them already sits. A group draws as a single rail down a run of
 * adjacent layers, so its members have to end up next to each other.
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
export function gatherFileGroups(ids: string[], stackOfLayer: Record<string, string>): string[] {
  const runs = new Map<string, string[]>();
  for (const id of ids) {
    const stackId = stackOfLayer[id];
    if (!stackId) continue;
    const run = runs.get(stackId);
    if (run) run.push(id);
    else runs.set(stackId, [id]);
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
