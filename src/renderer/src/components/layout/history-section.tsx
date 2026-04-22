import { useStore } from "@/store";
import { ActionIcon, Box, Group, Menu, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { openConfirm } from "@renderer/lib/modals";
import { getHistoryManager, type HistoryManager, type HistoryNode } from "@renderer/lib/history-manager";
import { MoreVertical } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Section } from "../section";

const LANE_WIDTH = 9;
const ROW_HEIGHT = 22;
const DOT_RADIUS = 3;
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
  onNavigate: (nodeId: string) => void;
  onRename: (nodeId: string, label: string) => void;
  onDeleteSubtree: (nodeId: string) => void;
  onExportBranch: (nodeId: string) => void;
}

const HistoryRow = memo(function HistoryRow({
  row,
  isCurrent,
  laneCount,
  passThroughLanes,
  rowDiagonals,
  synthesizing,
  now,
  onNavigate,
  onRename,
  onDeleteSubtree,
  onExportBranch,
}: HistoryRowProps) {
  const { node, lane } = row;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.customLabel ?? node.label);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const graphWidth = Math.min(laneCount, MAX_LANES) * LANE_WIDTH + GRAPH_PAD_LEFT;
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
        {/* Node dot */}
        <circle
          cx={dotX}
          cy={rowCenterY}
          r={DOT_RADIUS}
          fill={isCurrent ? "var(--mantine-color-orange-5)" : "var(--mantine-color-dark-2)"}
        />
      </svg>

      <Menu withinPortal position="right-start" shadow="md" opened={menuOpen} onChange={setMenuOpen} closeOnItemClick>
        <Menu.Target>
          <UnstyledButton
            onClick={() => !editing && !menuOpen && onNavigate(node.id)}
            onDoubleClick={() => !editing && setEditing(true)}
            onContextMenu={(e: React.MouseEvent) => {
              e.preventDefault();
              setMenuOpen(true);
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
                  styles={{ input: { height: 18, minHeight: 18, fontSize: 11 } }}
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <Text
                  size="xs"
                  truncate
                  fw={isCurrent ? 600 : 400}
                  c={isCurrent ? undefined : "dark.1"}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {node.customLabel ?? node.label}
                </Text>
              )}
              {synthesizing && isCurrent && (
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
          <Menu.Item onClick={() => setEditing(true)}>Rename</Menu.Item>
          <Menu.Item onClick={() => onExportBranch(node.id)}>Export branch…</Menu.Item>
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

  const layout = useMemo(
    () => (manifest ? layoutTree(manifest.nodes) : null),
    // `manifest` is mutated in place; `version` is what actually changes on
    // tree mutation, so include it as an explicit invalidation dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, version],
  );
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
  const onPurge = useCallback(() => {
    if (!manager) return;
    openConfirm({
      title: "Purge history",
      message: `This will delete ${formatBytes(diskSize)} of on-disk history for this file. The current state will remain unchanged. This cannot be undone.`,
      confirmLabel: "Purge",
      danger: true,
      onConfirm: async () => {
        await manager.purge();
        await refreshDiskSize();
      },
    });
  }, [manager, diskSize, refreshDiskSize]);

  const menu = (
    <Menu withinPortal position="right-start" shadow="md" onOpen={refreshDiskSize}>
      <Menu.Target>
        <ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}>
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
        <Menu.Item color="red" disabled={!manifest} onClick={onPurge}>
          Purge History ({formatBytes(diskSize)})
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <Section label="History" rightSlot={menu}>
      <Box style={{ maxHeight: 320, overflowY: "auto" }}>
        {!manifest || !layout ? (
          <Text size="xs" c="dimmed" ta="center" py={8}>
            No history yet.
          </Text>
        ) : (
          <Stack gap={0}>
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
                  onNavigate={onNavigate}
                  onRename={onRename}
                  onDeleteSubtree={onDeleteSubtree}
                  onExportBranch={onExportBranch}
                />
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Section>
  );
}
