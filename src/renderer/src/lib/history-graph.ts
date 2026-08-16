import type { HistoryNode } from "@renderer/lib/history-manager";

// ---- Layout ----

export interface LaidOutRow {
  node: HistoryNode;
  lane: number;
  rowIndex: number;
}

export interface LayoutResult {
  rows: LaidOutRow[];
  laneCount: number;
  // For each row, which lanes pass straight through at row midpoint (pure vertical bars)
  passThroughLanes: number[][];
  // Diagonals inside each row (from child lane at dot center to parent lane at bottom).
  diagonals: { rowIndex: number; fromLane: number; toLane: number }[];
  // Rows with a child drawn directly above them in their own lane, and rows
  // whose own edge continues below. The renderer draws its stubs from these
  // rather than from childIds, so a line is only ever drawn where the layout
  // put an edge.
  sameLaneChild: boolean[];
  parentEdge: boolean[];
}

/** Newest timestamp anywhere in each node's subtree. */
function newestInSubtree(nodes: Record<string, HistoryNode>): Map<string, number> {
  const newest = new Map<string, number>();
  for (const node of Object.values(nodes)) {
    let cur: HistoryNode | undefined = node;
    while (cur) {
      const seen = newest.get(cur.id);
      if (seen !== undefined && seen >= node.timestamp) break;
      newest.set(cur.id, node.timestamp);
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
  }
  return newest;
}

/**
 * Rows top to bottom, every node above its own parent. Ordering on timestamp
 * alone puts a parent above its child whenever the two share a millisecond,
 * which draws the edge between them backwards. Branches are emitted whole, the
 * one holding the most recent work first.
 */
function orderRows(nodes: Record<string, HistoryNode>): HistoryNode[] {
  const newest = newestInSubtree(nodes);
  const subtreeTime = (id: string) => newest.get(id) ?? 0;
  const ordered: HistoryNode[] = [];
  const queued = new Set<string>();

  const emitSubtree = (rootId: string) => {
    const stack: { id: string; expanded: boolean }[] = [{ id: rootId, expanded: false }];
    queued.add(rootId);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.expanded) {
        stack.pop();
        ordered.push(nodes[frame.id]);
        continue;
      }
      frame.expanded = true;
      const children = nodes[frame.id].childIds.filter((id) => nodes[id] && !queued.has(id));
      // Ascending, because the stack takes its top entry first.
      children.sort((a, b) => subtreeTime(a) - subtreeTime(b));
      for (const id of children) {
        queued.add(id);
        stack.push({ id, expanded: false });
      }
    }
  };

  const roots = Object.values(nodes)
    .filter((n) => !n.parentId || !nodes[n.parentId])
    .sort((a, b) => subtreeTime(b.id) - subtreeTime(a.id));
  for (const root of roots) emitSubtree(root.id);
  // Anything a cycle kept out of the walk still gets a row.
  for (const node of Object.values(nodes)) {
    if (queued.has(node.id)) continue;
    queued.add(node.id);
    ordered.push(node);
  }
  return ordered;
}

export function layoutTree(nodes: Record<string, HistoryNode>): LayoutResult {
  const ordered = orderRows(nodes);
  const rowIndexOf = new Map<string, number>();
  ordered.forEach((n, i) => rowIndexOf.set(n.id, i));

  const placement = new Map<string, number>(); // nodeId → lane
  // A lane carries one node's edge up to its parent, so it stays busy for every
  // row down to the parent's. Reusing it earlier would draw two unrelated
  // branches as one column.
  const laneBusyUntilRow: number[] = [];
  // parentId → lane, for the first child to reserve its parent's lane. Later
  // children of the same parent keep their own lane and diagonal into it.
  const claimedLanes = new Map<string, number>();

  for (const [row, node] of ordered.entries()) {
    let lane = claimedLanes.get(node.id) ?? -1;
    if (lane >= 0) {
      claimedLanes.delete(node.id);
    } else {
      lane = laneBusyUntilRow.findIndex((until) => until <= row);
      if (lane < 0) {
        lane = laneBusyUntilRow.length;
        laneBusyUntilRow.push(row);
      }
    }
    placement.set(node.id, lane);

    const parentRow = node.parentId != null ? rowIndexOf.get(node.parentId) : undefined;
    const carries = parentRow !== undefined && parentRow > row;
    laneBusyUntilRow[lane] = carries ? parentRow : row;
    if (carries && !claimedLanes.has(node.parentId!)) claimedLanes.set(node.parentId!, lane);
  }

  const laneCount = Math.max(1, laneBusyUntilRow.length);
  const rows: LaidOutRow[] = ordered.map((node, i) => ({
    node,
    lane: placement.get(node.id)!,
    rowIndex: i,
  }));

  // Compute per-row pass-through lanes and diagonals.
  // pass-through lane at row R = a lane with an active edge (child→parent) whose
  // child row < R and whose parent row > R (both strictly).
  const passThroughLanes: number[][] = ordered.map(() => []);
  const sameLaneChild: boolean[] = ordered.map(() => false);
  const parentEdge: boolean[] = ordered.map(() => false);
  const diagonals: { rowIndex: number; fromLane: number; toLane: number }[] = [];

  for (const node of ordered) {
    if (!node.parentId) continue;
    const parentLane = placement.get(node.parentId);
    if (parentLane == null) continue; // orphan
    const childLane = placement.get(node.id)!;
    const childRow = rowIndexOf.get(node.id)!;
    const parentRow = rowIndexOf.get(node.parentId)!;
    if (parentRow <= childRow) continue;
    parentEdge[childRow] = true;

    // Vertical bars pass through rows strictly between child and parent.
    for (let r = childRow + 1; r < parentRow; r++) {
      passThroughLanes[r].push(childLane);
    }

    // Diagonal inside the parent's row if the lanes differ.
    if (childLane === parentLane) sameLaneChild[parentRow] = true;
    else diagonals.push({ rowIndex: parentRow, fromLane: childLane, toLane: parentLane });
  }

  return { rows, laneCount, passThroughLanes, diagonals, sameLaneChild, parentEdge };
}

// ---- Run merging & fork overflow ----

const MERGE_RUN_MIN_LENGTH = 3;
/** Branches drawn side by side at one fork before the rest fold into a badge. */
export const MAX_FORK_BRANCHES = 5;
const OVERFLOW_LABEL = "more branches";

export interface NodeMeta {
  kind: "run" | "overflow";
  count: number;
  runNodeIds?: string[];
  overflowForkId?: string;
  hasFavorite?: boolean;
}

// The path the user is actually on: ancestors of the current node, plus
// whichever child was most recently active at each fork going forward.
function computeSpine(nodes: Record<string, HistoryNode>, currentId: string): Set<string> {
  const spine = new Set<string>();
  let id: string | null = currentId;
  while (id && nodes[id] && !spine.has(id)) {
    spine.add(id);
    id = nodes[id].parentId;
  }
  id = nodes[currentId]?.lastChildId ?? null;
  while (id && nodes[id] && !spine.has(id)) {
    spine.add(id);
    id = nodes[id].lastChildId;
  }
  return spine;
}

function collectSubtree(rootId: string, nodes: Record<string, HistoryNode>): HistoryNode[] {
  const out: HistoryNode[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    out.push(n);
    stack.push(...n.childIds);
  }
  return out;
}

/**
 * Builds a reduced tree for display. Two things fold, both along a single line
 * of edits and never across branches: a run of consecutive same-label nodes
 * becomes one row, and a fork wider than the lane budget keeps its newest
 * branches and folds the rest behind one badge. Both fold in the display only —
 * the real manifest, and undo granularity, are untouched.
 */
export function buildVisibleTree(
  nodes: Record<string, HistoryNode>,
  currentId: string,
  expandedRuns: Set<string>,
  expandedForks: Set<string>,
): { tree: Record<string, HistoryNode>; meta: Map<string, NodeMeta> } {
  const spineIds = computeSpine(nodes, currentId);
  const newest = newestInSubtree(nodes);
  const meta = new Map<string, NodeMeta>();
  const tree: Record<string, HistoryNode> = {};
  const placeholderIds = new Set<string>();

  // A fork past the budget keeps the path the user is on plus its newest
  // branches; everything older folds behind one badge on that fork.
  const hiddenIds = new Set<string>();
  const overflows = new Map<string, HistoryNode[]>();
  for (const node of Object.values(nodes)) {
    const children = node.childIds.filter((id) => nodes[id]);
    if (children.length <= MAX_FORK_BRANCHES || expandedForks.has(node.id)) continue;
    const kept = new Set(children.filter((id) => spineIds.has(id)));
    for (const id of [...children].sort((a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0))) {
      if (kept.size >= MAX_FORK_BRANCHES - 1) break;
      kept.add(id);
    }
    const folded = children.filter((id) => !kept.has(id)).flatMap((id) => collectSubtree(id, nodes));
    for (const n of folded) hiddenIds.add(n.id);
    overflows.set(node.id, folded);
  }

  for (const node of Object.values(nodes)) {
    if (hiddenIds.has(node.id)) continue;
    const childIds = node.childIds.filter((id) => nodes[id] && !hiddenIds.has(id));
    const folded = overflows.get(node.id);
    if (folded && folded.length > 0) {
      const placeholderId = `overflow:${node.id}`;
      const latest = folded.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      childIds.push(placeholderId);
      placeholderIds.add(placeholderId);
      tree[placeholderId] = {
        id: placeholderId,
        parentId: node.id,
        childIds: [],
        lastChildId: null,
        timestamp: latest.timestamp,
        label: OVERFLOW_LABEL,
        kind: latest.kind,
        storage: latest.storage,
        dimensions: latest.dimensions,
      };
      meta.set(placeholderId, {
        kind: "overflow",
        count: folded.filter((n) => n.parentId === node.id).length,
        overflowForkId: node.id,
        hasFavorite: folded.some((n) => n.favorited),
      });
    }
    tree[node.id] = { ...node, childIds };
  }

  const labelOf = (n: HistoryNode) => n.customLabel ?? n.label;
  // Runs merge on every branch, not only the path the user is on. A fork never
  // merges, and a fork carrying an overflow badge holds several branches on top
  // of it, so no merged node can strand a badge.
  const mergeable = (n: HistoryNode) => !placeholderIds.has(n.id) && n.id !== currentId && !n.favorited;
  const isTopOfChain = (node: HistoryNode): boolean => {
    if (node.childIds.length !== 1) return true;
    const child = tree[node.childIds[0]];
    return !child || !mergeable(child) || labelOf(child) !== labelOf(node);
  };

  for (const node of Object.values(tree)) {
    if (!tree[node.id] || !mergeable(node) || !isTopOfChain(node)) continue;
    const chain: HistoryNode[] = [node];
    let cur = node;
    while (true) {
      const parent: HistoryNode | undefined = cur.parentId ? tree[cur.parentId] : undefined;
      if (!parent || !mergeable(parent) || parent.childIds.length !== 1 || labelOf(parent) !== labelOf(cur)) break;
      chain.push(parent);
      cur = parent;
    }
    if (chain.length < MERGE_RUN_MIN_LENGTH) continue;

    if (expandedRuns.has(node.id)) continue;

    const oldest = chain[chain.length - 1];
    const newestNode = tree[node.id];
    newestNode.parentId = oldest.parentId;
    if (oldest.parentId && tree[oldest.parentId]) {
      const parent = tree[oldest.parentId];
      parent.childIds = parent.childIds.map((id) => (id === oldest.id ? newestNode.id : id));
    }
    for (let i = 1; i < chain.length; i++) delete tree[chain[i].id];
    meta.set(newestNode.id, { kind: "run", count: chain.length, runNodeIds: chain.map((n) => n.id) });
  }

  return { tree, meta };
}
