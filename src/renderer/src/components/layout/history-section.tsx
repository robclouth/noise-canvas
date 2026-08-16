import { host } from "@/lib/host";
import { useStore } from "@/store";
import { ActionIcon, Box, Group, Menu, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { openConfirm } from "@renderer/lib/modals";
import { getHistoryManager, type HistoryManager, type HistoryNode } from "@renderer/lib/history-manager";
import { WIDGET_INPUT_HEIGHT } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import { MoreVertical, Redo2, Star, Undo2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Section } from "../section";

const LANE_WIDTH = 9;
const ROW_HEIGHT = 22;
const DOT_RADIUS = 3;
const GROUP_DOT_RADIUS = 7;
const GRAPH_PAD_LEFT = 4;
const MAX_LANES = 3;

// ---- Layout ----

interface LaidOutRow {
  node: HistoryNode;
  lane: number;
  rowIndex: number;
}

interface LayoutResult {
  rows: LaidOutRow[];
  laneCount: number;
  // For each row, which lanes pass straight through at row midpoint (pure vertical bars)
  passThroughLanes: number[][];
  // Diagonals inside each row (from child lane at dot center to parent lane at bottom).
  diagonals: { rowIndex: number; fromLane: number; toLane: number }[];
}

function layoutTree(nodes: Record<string, HistoryNode>): LayoutResult {
  const ordered = Object.values(nodes).sort((a, b) => b.timestamp - a.timestamp);
  const rowIndexOf = new Map<string, number>();
  ordered.forEach((n, i) => rowIndexOf.set(n.id, i));

  const placement = new Map<string, number>(); // nodeId → lane
  // Track, for each lane, which nodeId is currently "expected" to appear as we walk down.
  // Expected = a child that's been placed but whose parent hasn't been seen yet.
  const laneOwners: (string | null)[] = [];
  const expected = new Map<string, number>(); // parentId → lane

  for (const node of ordered) {
    let lane: number;
    if (expected.has(node.id)) {
      lane = expected.get(node.id)!;
      expected.delete(node.id);
      laneOwners[lane] = null;
    } else {
      let free = laneOwners.findIndex((o) => o === null);
      if (free < 0) {
        free = laneOwners.length;
        laneOwners.push(null);
      }
      lane = free;
    }
    placement.set(node.id, lane);

    if (node.parentId) {
      if (expected.has(node.parentId)) {
        // Another descendant already claimed the parent's lane. This node's
        // lane will diagonal into it at the parent row. Nothing to reserve here.
      } else {
        expected.set(node.parentId, lane);
        laneOwners[lane] = node.parentId;
      }
    }
  }

  const laneCount = Math.max(1, laneOwners.length);
  const rows: LaidOutRow[] = ordered.map((node, i) => ({
    node,
    lane: placement.get(node.id)!,
    rowIndex: i,
  }));

  // Compute per-row pass-through lanes and diagonals.
  // pass-through lane at row R = a lane with an active edge (child→parent) whose
  // child row < R and whose parent row > R (both strictly).
  const passThroughLanes: number[][] = ordered.map(() => []);
  const diagonals: { rowIndex: number; fromLane: number; toLane: number }[] = [];

  for (const node of ordered) {
    if (!node.parentId) continue;
    const childLane = placement.get(node.id)!;
    const parentLane = placement.get(node.parentId);
    if (parentLane == null) continue; // orphan
    const childRow = rowIndexOf.get(node.id)!;
    const parentRow = rowIndexOf.get(node.parentId)!;

    // Vertical bars pass through rows strictly between child and parent.
    for (let r = childRow + 1; r < parentRow; r++) {
      passThroughLanes[r].push(childLane);
    }

    // Diagonal inside the parent's row if the lanes differ.
    if (childLane !== parentLane) {
      diagonals.push({ rowIndex: parentRow, fromLane: childLane, toLane: parentLane });
    }
  }

  return { rows, laneCount, passThroughLanes, diagonals };
}

// ---- Branch collapsing & run merging ----

const MERGE_RUN_MIN_LENGTH = 3;

interface NodeMeta {
  kind: "branch" | "run";
  count?: number;
  branchRootId?: string;
  latestLabel?: string;
  hasFavorite?: boolean;
  runNodeIds?: string[];
}

// The path the user is actually on: ancestors of the current node, plus
// whichever child was most recently active at each fork going forward. Any
// other child at a fork is a branch the user tried and left.
function computeSpine(nodes: Record<string, HistoryNode>, currentId: string): Set<string> {
  const spine = new Set<string>();
  let id: string | null = currentId;
  while (id && nodes[id]) {
    spine.add(id);
    id = nodes[id].parentId;
  }
  id = nodes[currentId]?.lastChildId ?? null;
  while (id && nodes[id]) {
    spine.add(id);
    id = nodes[id].lastChildId;
  }
  return spine;
}

function branchRootIdOf(
  nodeId: string,
  nodes: Record<string, HistoryNode>,
  spineIds: Set<string>,
  cache: Map<string, string>,
): string {
  const cached = cache.get(nodeId);
  if (cached) return cached;
  const parentId = nodes[nodeId].parentId;
  const result = !parentId || spineIds.has(parentId) ? nodeId : branchRootIdOf(parentId, nodes, spineIds, cache);
  cache.set(nodeId, result);
  return result;
}

function collectSubtree(rootId: string, nodes: Record<string, HistoryNode>): HistoryNode[] {
  const out: HistoryNode[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n) continue;
    out.push(n);
    stack.push(...n.childIds);
  }
  return out;
}

// Builds a reduced tree for display: branches the user isn't on collapse into
// a single placeholder row (until expanded), and runs of consecutive nodes
// with the same label collapse into one row showing a count (until
// expanded). Both collapse in the display only — the real manifest, and undo
// granularity, are untouched.
function buildVisibleTree(
  nodes: Record<string, HistoryNode>,
  currentId: string,
  expandedBranches: Set<string>,
  expandedRuns: Set<string>,
): { tree: Record<string, HistoryNode>; meta: Map<string, NodeMeta> } {
  const spineIds = computeSpine(nodes, currentId);
  const branchRootCache = new Map<string, string>();
  const branchSizeCache = new Map<string, number>();
  const meta = new Map<string, NodeMeta>();
  const tree: Record<string, HistoryNode> = {};

  const branchSize = (branchRootId: string): number => {
    const cached = branchSizeCache.get(branchRootId);
    if (cached !== undefined) return cached;
    const size = collectSubtree(branchRootId, nodes).length;
    branchSizeCache.set(branchRootId, size);
    return size;
  };

  const isVisible = (id: string): boolean => {
    if (spineIds.has(id)) return true;
    const root = branchRootIdOf(id, nodes, spineIds, branchRootCache);
    return branchSize(root) < MERGE_RUN_MIN_LENGTH || expandedBranches.has(root);
  };

  for (const node of Object.values(nodes)) {
    if (!isVisible(node.id)) continue;
    const childIds: string[] = [];
    for (const childId of node.childIds) {
      if (isVisible(childId)) {
        childIds.push(childId);
        continue;
      }
      // childId heads a branch the user left, at least MERGE_RUN_MIN_LENGTH
      // nodes deep. Represent the whole subtree as one placeholder row
      // attached where it diverged; smaller branches just stay inline above.
      const placeholderId = `branch:${childId}`;
      childIds.push(placeholderId);
      const subtree = collectSubtree(childId, nodes);
      const latest = subtree.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      tree[placeholderId] = {
        ...nodes[childId],
        id: placeholderId,
        parentId: node.id,
        childIds: [],
        favorited: false,
      };
      meta.set(placeholderId, {
        kind: "branch",
        count: subtree.length,
        branchRootId: childId,
        latestLabel: latest.customLabel ?? latest.label,
        hasFavorite: subtree.some((n) => n.favorited),
      });
    }
    tree[node.id] = { ...node, childIds };
  }

  const labelOf = (n: HistoryNode) => n.customLabel ?? n.label;
  const isPlaceholder = (id: string) => id.startsWith("branch:");
  // Runs merge on every branch, not only the path the user is on. Expanding a
  // branch of same-label steps therefore shows its runs as badges, which the
  // badge expands in turn.
  const mergeable = (n: HistoryNode) => !isPlaceholder(n.id) && n.id !== currentId && !n.favorited;
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
    const newest = tree[node.id];
    newest.parentId = oldest.parentId;
    if (oldest.parentId && tree[oldest.parentId]) {
      const parent = tree[oldest.parentId];
      parent.childIds = parent.childIds.map((id) => (id === oldest.id ? newest.id : id));
    }
    for (let i = 1; i < chain.length; i++) delete tree[chain[i].id];
    meta.set(newest.id, { kind: "run", count: chain.length, runNodeIds: chain.map((n) => n.id) });
  }

  return { tree, meta };
}

// ---- Time formatter ----

function formatRelative(ts: number, now: number): string {
  const diffMs = Math.max(0, now - ts);
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---- Subscription hook ----

function useHistoryManifest(manager: HistoryManager | null) {
  const version = useSyncExternalStore(
    useCallback(
      (cb: () => void) => {
        if (!manager) return () => {};
        return manager.subscribe(cb);
      },
      [manager],
    ),
    useCallback(() => manager?.getVersion() ?? 0, [manager]),
  );
  // Manifest is mutated in place on each tree change; expose the bumped version
  // so downstream memos can depend on it explicitly.
  const manifest = manager?.getManifest() ?? null;
  return { manifest, version };
}

// ---- Row component ----

interface HistoryRowProps {
  row: LaidOutRow;
  isCurrent: boolean;
  laneCount: number;
  passThroughLanes: number[];
  rowDiagonals: { fromLane: number; toLane: number }[];
  synthesizing: boolean;
  now: number;
  isExtension: boolean;
  meta: NodeMeta | undefined;
  onNavigate: (nodeId: string) => void;
  onRename: (nodeId: string, label: string) => void;
  onDeleteSubtree: (nodeId: string) => void;
  onExportBranch: (nodeId: string) => void;
  onExportBranchToLive: (nodeId: string) => void;
  onToggleFavorite: (nodeId: string) => void;
  onToggleBranch: (branchRootId: string) => void;
  onToggleRun: (nodeId: string) => void;
  // Expanding a collapsed row reflows the list under the pointer, so the second
  // click of a real double-click can land on a different row entirely. Set true
  // right after a click-driven expand; every row's double-click checks it first
  // and swallows itself rather than acting on whatever it landed on.
  suppressDblClickRef: React.RefObject<boolean>;
}

const HistoryRow = memo(function HistoryRow({
  row,
  isCurrent,
  laneCount,
  passThroughLanes,
  rowDiagonals,
  synthesizing,
  now,
  isExtension,
  meta,
  onNavigate,
  onRename,
  onDeleteSubtree,
  onExportBranch,
  onExportBranchToLive,
  onToggleFavorite,
  onToggleBranch,
  onToggleRun,
  suppressDblClickRef,
}: HistoryRowProps) {
  const { node, lane } = row;
  const isBranchPlaceholder = meta?.kind === "branch";
  const isRun = meta?.kind === "run";
  const isCollapsedGroup = isBranchPlaceholder || isRun;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.customLabel ?? node.label);
  const [menuOpen, setMenuOpen] = useState(false);
  const [badgeHovered, setBadgeHovered] = useState(false);
  // Mantine's Menu.Target auto-opens on target click regardless of whether
  // we pass `opened` — so we gate `onChange(true)` by a ref flag that is only
  // set when the user right-clicks. Closes (onChange(false)) always pass
  // through so Esc / outside-click / item-click still work.
  const userInitiatedOpenRef = useRef(false);
  const handleMenuChange = useCallback((open: boolean) => {
    if (open && !userInitiatedOpenRef.current) return;
    userInitiatedOpenRef.current = false;
    setMenuOpen(open);
  }, []);
  const openMenuFromContext = useCallback(() => {
    userInitiatedOpenRef.current = true;
    setMenuOpen(true);
  }, []);

  // Debounce the "busy" indicator for the current node so it only appears if
  // synthesis actually runs for a noticeable amount of time. Re-synthesis is
  // often sub-100ms; flashing the spinner on every brief navigate is noisy.
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!synthesizing || !isCurrent) {
      setShowSpinner(false);
      return;
    }
    const t = setTimeout(() => setShowSpinner(true), 500);
    return () => clearTimeout(t);
  }, [synthesizing, isCurrent]);

  useEffect(() => {
    setEditValue(node.customLabel ?? node.label);
  }, [node.customLabel, node.label]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== (node.customLabel ?? node.label)) {
      onRename(node.id, trimmed);
    } else {
      setEditValue(node.customLabel ?? node.label);
    }
    setEditing(false);
  }, [editValue, node.id, node.customLabel, node.label, onRename]);

  const groupCount = isBranchPlaceholder || isRun ? meta!.count : undefined;
  const badgeText = groupCount == null ? "" : groupCount > 99 ? "99+" : String(groupCount);
  // A 1-digit badge fits the base radius; wider text needs a wider circle to
  // stay centered instead of overflowing it.
  const groupDotRadius =
    badgeText.length >= 3 ? GROUP_DOT_RADIUS + 3 : badgeText.length === 2 ? GROUP_DOT_RADIUS + 1.5 : GROUP_DOT_RADIUS;
  const graphWidth =
    Math.min(laneCount, MAX_LANES) * LANE_WIDTH + GRAPH_PAD_LEFT + (isCollapsedGroup ? groupDotRadius : 0);
  const centerX = (l: number) => GRAPH_PAD_LEFT + l * LANE_WIDTH + LANE_WIDTH / 2;
  const rowCenterY = ROW_HEIGHT / 2;

  const dotLane = Math.min(lane, MAX_LANES - 1);
  const dotX = centerX(dotLane);

  return (
    <Group gap={0} wrap="nowrap" align="center" style={{ position: "relative", minHeight: ROW_HEIGHT }}>
      <svg width={graphWidth} height={ROW_HEIGHT} style={{ display: "block", flexShrink: 0 }} role="presentation">
        {/* Pass-through vertical bars */}
        {passThroughLanes
          .filter((l) => l < MAX_LANES)
          .map((l, i) => (
            <line
              key={`pt-${i}-${l}`}
              x1={centerX(l)}
              x2={centerX(l)}
              y1={0}
              y2={ROW_HEIGHT}
              stroke="var(--mantine-color-dark-4)"
              strokeWidth={1}
            />
          ))}
        {/* Incoming vertical stub into the top of this node's circle. Only
            drawn if something actually connects above — i.e. this node has
            children that will be rendered in rows above it. Otherwise leaves
            of non-current branches would dangle a meaningless line. */}
        {node.childIds.length > 0 && (
          <line x1={dotX} x2={dotX} y1={0} y2={rowCenterY} stroke="var(--mantine-color-dark-4)" strokeWidth={1} />
        )}
        {/* Diagonals landing in this row (child lane → parent lane). */}
        {rowDiagonals.map((d, i) => {
          const from = Math.min(d.fromLane, MAX_LANES - 1);
          const to = Math.min(d.toLane, MAX_LANES - 1);
          return (
            <line
              key={`d-${i}-${from}-${to}`}
              x1={centerX(from)}
              y1={0}
              x2={centerX(to)}
              y2={rowCenterY}
              stroke="var(--mantine-color-dark-4)"
              strokeWidth={1}
            />
          );
        })}
        {/* Outgoing stub to next row (if this is not root). */}
        {node.parentId && (
          <line
            x1={dotX}
            x2={dotX}
            y1={rowCenterY}
            y2={ROW_HEIGHT}
            stroke="var(--mantine-color-dark-4)"
            strokeWidth={1}
          />
        )}
        {/* Node dot, or a count badge standing in for the group folded behind
            it. The badge itself is the click target for expanding the group. */}
        {isCollapsedGroup ? (
          <>
            <circle
              cx={dotX}
              cy={rowCenterY}
              r={groupDotRadius}
              fill={badgeHovered ? "var(--mantine-color-dark-3)" : "var(--mantine-color-dark-4)"}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setBadgeHovered(true)}
              onMouseLeave={() => setBadgeHovered(false)}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen || e.detail > 1) return;
                suppressDblClickRef.current = true;
                setTimeout(() => {
                  suppressDblClickRef.current = false;
                }, 500);
                if (isBranchPlaceholder) onToggleBranch(meta!.branchRootId!);
                else onToggleRun(node.id);
              }}
            />
            <text
              x={dotX}
              y={rowCenterY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={badgeText.length >= 3 ? 7 : 8}
              fontWeight={600}
              fill="var(--mantine-color-dark-0)"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {badgeText}
            </text>
          </>
        ) : (
          <circle
            cx={dotX}
            cy={rowCenterY}
            r={DOT_RADIUS}
            fill={isCurrent ? "var(--mantine-color-orange-5)" : "var(--mantine-color-dark-2)"}
          />
        )}
      </svg>

      <Menu
        withinPortal
        position="right-start"
        shadow="md"
        opened={menuOpen}
        onChange={handleMenuChange}
        closeOnItemClick
      >
        <Menu.Target>
          <UnstyledButton
            {...helpProps("history-entry")}
            onClick={(e) => {
              if (editing || menuOpen || e.detail > 1) return;
              if (isBranchPlaceholder || isRun) {
                suppressDblClickRef.current = true;
                setTimeout(() => {
                  suppressDblClickRef.current = false;
                }, 500);
                if (isBranchPlaceholder) onToggleBranch(meta!.branchRootId!);
                else onToggleRun(node.id);
                return;
              }
              onNavigate(node.id);
            }}
            onDoubleClick={() => {
              if (suppressDblClickRef.current) {
                suppressDblClickRef.current = false;
                return;
              }
              if (!editing && !meta) setEditing(true);
            }}
            onContextMenu={(e: React.MouseEvent) => {
              e.preventDefault();
              openMenuFromContext();
            }}
            px={4}
            py={2}
            className={editing ? undefined : "effect-button"}
            style={{
              borderRadius: "var(--mantine-radius-sm)",
              background: isCurrent ? "var(--mantine-color-dark-6)" : undefined,
              flex: 1,
              minWidth: 0,
              cursor: editing ? "text" : "pointer",
              marginLeft: 2,
            }}
          >
            <Group gap={4} wrap="nowrap" align="center">
              {node.favorited && (
                <Star
                  size={10}
                  color="var(--mantine-color-yellow-5)"
                  fill="var(--mantine-color-yellow-5)"
                  style={{ flexShrink: 0 }}
                />
              )}
              {isBranchPlaceholder && meta?.hasFavorite && (
                <Star
                  size={9}
                  color="var(--mantine-color-yellow-5)"
                  fill="var(--mantine-color-yellow-5)"
                  style={{ flexShrink: 0 }}
                />
              )}
              {editing ? (
                <TextInput
                  value={editValue}
                  onChange={(e) => setEditValue(e.currentTarget.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      setEditValue(node.customLabel ?? node.label);
                      setEditing(false);
                    }
                  }}
                  size="xs"
                  autoFocus
                  styles={{
                    input: {
                      height: WIDGET_INPUT_HEIGHT,
                      minHeight: WIDGET_INPUT_HEIGHT,
                      fontSize: "var(--ui-font-xs)",
                    },
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <Text
                  size="xs"
                  truncate
                  fw={isCurrent ? 600 : 400}
                  c={isCollapsedGroup ? "dark.2" : isCurrent ? undefined : "dark.1"}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {isBranchPlaceholder ? meta!.latestLabel : (node.customLabel ?? node.label)}
                </Text>
              )}
              {showSpinner && (
                <Text size="10px" c="dimmed">
                  …
                </Text>
              )}
              {!editing && (
                <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>
                  {formatRelative(node.timestamp, now)}
                </Text>
              )}
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          {isBranchPlaceholder ? (
            <>
              <Menu.Item onClick={() => onToggleBranch(meta!.branchRootId!)}>Expand</Menu.Item>
              <Menu.Item onClick={() => onExportBranch(meta!.branchRootId!)}>Export branch…</Menu.Item>
              {isExtension && (
                <Menu.Item onClick={() => onExportBranchToLive(meta!.branchRootId!)}>Export branch to Live</Menu.Item>
              )}
              <Menu.Divider />
              <Menu.Item
                color="red"
                onClick={() => {
                  const targetId = meta!.branchRootId!;
                  openConfirm({
                    title: "Delete branch",
                    message: "Delete this branch and all of its descendants? This cannot be undone.",
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: () => onDeleteSubtree(targetId),
                  });
                }}
              >
                Delete branch
              </Menu.Item>
            </>
          ) : (
            <>
              <Menu.Item onClick={() => onToggleFavorite(node.id)}>
                {node.favorited ? "Unfavourite" : "Favourite"}
              </Menu.Item>
              <Menu.Item onClick={() => setEditing(true)}>Rename</Menu.Item>
              <Menu.Item onClick={() => onExportBranch(node.id)}>Export branch…</Menu.Item>
              {isExtension && (
                <Menu.Item onClick={() => onExportBranchToLive(node.id)}>Export branch to Live</Menu.Item>
              )}
              <Menu.Divider />
              <Menu.Item
                color="red"
                disabled={node.parentId === null}
                onClick={() => {
                  openConfirm({
                    title: "Delete branch",
                    message: "Delete this node and all of its descendants? This cannot be undone.",
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: () => onDeleteSubtree(node.id),
                  });
                }}
              >
                Delete branch
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
});

// ---- Section ----

export function HistorySection() {
  const activeFileId = useStore((s) => s.activeFileId);
  const isSynthesizing = useStore((s) => (activeFileId ? (s.filesSynthesizing[activeFileId] ?? false) : false));
  const exportHistory = useStore((s) => s.exportHistory);
  const exportHistoryBranch = useStore((s) => s.exportHistoryBranch);
  const exportHistoryBranchToLive = useStore((s) => s.exportHistoryBranchToLive);
  const exportHistoryFavorites = useStore((s) => s.exportHistoryFavorites);

  const manager = useMemo(() => (activeFileId ? getHistoryManager(activeFileId) : null), [activeFileId]);
  const { manifest, version } = useHistoryManifest(manager);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  const [diskSize, setDiskSize] = useState<number>(0);
  const refreshDiskSize = useCallback(async () => {
    if (!manager) {
      setDiskSize(0);
      return;
    }
    const n = await manager.getDiskUsageBytes();
    setDiskSize(n);
  }, [manager]);

  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const suppressDblClickRef = useRef(false);
  // Any history change (a new stroke, an undo, a redo) collapses everything
  // back down — there's no manual collapse control, only expand-to-peek.
  useEffect(() => {
    setExpandedBranches(new Set());
    setExpandedRuns(new Set());
  }, [manager, manifest?.currentId]);
  const onToggleBranch = useCallback((branchRootId: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev);
      if (next.has(branchRootId)) next.delete(branchRootId);
      else next.add(branchRootId);
      return next;
    });
  }, []);
  const onToggleRun = useCallback((nodeId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const visibleTree = useMemo(
    () => (manifest ? buildVisibleTree(manifest.nodes, manifest.currentId, expandedBranches, expandedRuns) : null),
    // `manifest` is mutated in place; `version` is what actually changes on
    // tree mutation, so include it as an explicit invalidation dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, version, expandedBranches, expandedRuns],
  );
  const layout = useMemo(() => (visibleTree ? layoutTree(visibleTree.tree) : null), [visibleTree]);
  const currentScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    currentScrollRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [manifest?.currentId]);

  const rowDiagonals = useMemo(() => {
    if (!layout) return new Map<number, { fromLane: number; toLane: number }[]>();
    const m = new Map<number, { fromLane: number; toLane: number }[]>();
    for (const d of layout.diagonals) {
      const list = m.get(d.rowIndex) ?? [];
      list.push({ fromLane: d.fromLane, toLane: d.toLane });
      m.set(d.rowIndex, list);
    }
    return m;
  }, [layout]);

  const onNavigate = useCallback(
    (nodeId: string) => {
      if (!manager) return;
      void manager.navigateTo(nodeId);
    },
    [manager],
  );
  const onRename = useCallback(
    (nodeId: string, label: string) => {
      if (!manager) return;
      void manager.renameNode(nodeId, label);
    },
    [manager],
  );
  const onDeleteSubtree = useCallback(
    (nodeId: string) => {
      if (!manager) return;
      void manager.deleteSubtree(nodeId);
    },
    [manager],
  );
  const onExportBranch = useCallback(
    (nodeId: string) => {
      void exportHistoryBranch(nodeId);
    },
    [exportHistoryBranch],
  );
  const onExportBranchToLive = useCallback(
    (nodeId: string) => {
      void exportHistoryBranchToLive(nodeId);
    },
    [exportHistoryBranchToLive],
  );
  const onToggleFavorite = useCallback(
    (nodeId: string) => {
      if (!manager) return;
      void manager.toggleFavorite(nodeId);
    },
    [manager],
  );
  const onPurge = useCallback(() => {
    if (!manager) return;
    openConfirm({
      title: "Purge history",
      message: `This will delete ${formatBytes(diskSize)} of on-disk history for this file. The current state will remain unchanged. This cannot be undone.`,
      confirmLabel: "Purge",
      danger: true,
      onConfirm: async () => {
        await manager.resetToCurrent();
        await refreshDiskSize();
      },
    });
  }, [manager, diskSize, refreshDiskSize]);

  // Undo steps to the parent node, redo to the most recent child.
  const current = manifest ? manifest.nodes[manifest.currentId] : null;
  const canUndo = !!current?.parentId;
  const canRedo = !!current && current.childIds.length > 0;
  const onUndo = useCallback(() => {
    if (manager) void manager.navigateToParent();
  }, [manager]);
  const onRedo = useCallback(() => {
    if (manager) void manager.navigateToLastChild();
  }, [manager]);

  const menu = (
    <Menu withinPortal position="right-start" shadow="md" onOpen={refreshDiskSize}>
      <Menu.Target>
        <ActionIcon
          {...helpProps("history-menu")}
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical size={12} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          disabled={!manifest}
          onClick={() => {
            void exportHistory();
          }}
        >
          Export History…
        </Menu.Item>
        <Menu.Item
          disabled={!manifest}
          onClick={() => {
            void exportHistoryFavorites();
          }}
        >
          Export Favourites…
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" disabled={!manifest} onClick={onPurge}>
          Purge History ({formatBytes(diskSize)})
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  const controls = (
    <Group gap={2} wrap="nowrap" align="center">
      <HelpActionIcon
        help="history-undo"
        size="xs"
        variant="subtle"
        color="gray"
        disabled={!canUndo}
        onClick={(e) => {
          e.stopPropagation();
          onUndo();
        }}
      >
        <Undo2 size={12} />
      </HelpActionIcon>
      <HelpActionIcon
        help="history-redo"
        size="xs"
        variant="subtle"
        color="gray"
        disabled={!canRedo}
        onClick={(e) => {
          e.stopPropagation();
          onRedo();
        }}
      >
        <Redo2 size={12} />
      </HelpActionIcon>
      {menu}
    </Group>
  );

  return (
    <Section label="History" rightSlot={controls} fill anchor="section-history">
      <ScrollArea type="auto" scrollbarSize={4} style={{ flex: 1, minHeight: 0 }}>
        {!manifest || !layout ? (
          <Text size="xs" c="dimmed" ta="center" py={8} pr={8}>
            No history yet.
          </Text>
        ) : (
          <Stack gap={0} pr={8}>
            {layout.rows.map((row) => (
              <Box key={row.node.id} ref={row.node.id === manifest.currentId ? currentScrollRef : undefined}>
                <HistoryRow
                  row={row}
                  isCurrent={row.node.id === manifest.currentId}
                  laneCount={layout.laneCount}
                  passThroughLanes={layout.passThroughLanes[row.rowIndex]}
                  rowDiagonals={rowDiagonals.get(row.rowIndex) ?? []}
                  synthesizing={isSynthesizing}
                  now={now}
                  isExtension={host.env.isExtension}
                  meta={visibleTree?.meta.get(row.node.id)}
                  onNavigate={onNavigate}
                  onRename={onRename}
                  onDeleteSubtree={onDeleteSubtree}
                  onExportBranch={onExportBranch}
                  onExportBranchToLive={onExportBranchToLive}
                  onToggleFavorite={onToggleFavorite}
                  onToggleBranch={onToggleBranch}
                  onToggleRun={onToggleRun}
                  suppressDblClickRef={suppressDblClickRef}
                />
              </Box>
            ))}
          </Stack>
        )}
      </ScrollArea>
    </Section>
  );
}
