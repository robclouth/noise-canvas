import { host } from "@/lib/host";
import { useStore } from "@/store";
import { ActionIcon, Box, Group, Menu, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { openConfirm } from "@renderer/lib/modals";
import { buildVisibleTree, layoutTree, type LaidOutRow, type NodeMeta } from "@renderer/lib/history-graph";
import { getHistoryManager, type HistoryManager } from "@renderer/lib/history-manager";
import { WIDGET_INPUT_HEIGHT } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import { MoreVertical, Redo2, Star, Undo2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Section } from "../section";

const LANE_WIDTH = 9;
const ROW_HEIGHT = 22;
const DOT_RADIUS = 3;
const GROUP_DOT_RADIUS = 7;
const MAX_GROUP_DOT_RADIUS = GROUP_DOT_RADIUS + 3;
const GRAPH_PAD_LEFT = MAX_GROUP_DOT_RADIUS - LANE_WIDTH / 2;
const GRAPH_PAD_RIGHT = MAX_GROUP_DOT_RADIUS - LANE_WIDTH / 2;
// Enough room for a label and its time stamp once the graph gets wide. Past
// this the list scrolls sideways rather than squeezing the text away.
const MIN_LABEL_WIDTH = 110;

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
  graphWidth: number;
  passThroughLanes: number[];
  rowDiagonals: { fromLane: number; toLane: number }[];
  sameLaneChild: boolean;
  parentEdge: boolean;
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
  onToggleRun: (nodeId: string) => void;
  onToggleFork: (forkNodeId: string) => void;
  // Expanding a collapsed row reflows the list under the pointer, so the second
  // click of a real double-click can land on a different row entirely. Set true
  // right after a click-driven expand; every row's double-click checks it first
  // and swallows itself rather than acting on whatever it landed on.
  suppressDblClickRef: React.RefObject<boolean>;
}

const HistoryRow = memo(function HistoryRow({
  row,
  isCurrent,
  graphWidth,
  passThroughLanes,
  rowDiagonals,
  sameLaneChild,
  parentEdge,
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
  onToggleRun,
  onToggleFork,
  suppressDblClickRef,
}: HistoryRowProps) {
  const { node, lane } = row;
  const isOverflow = meta?.kind === "overflow";
  const isCollapsedGroup = meta !== undefined;
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

  const toggleGroup = useCallback(() => {
    suppressDblClickRef.current = true;
    setTimeout(() => {
      suppressDblClickRef.current = false;
    }, 500);
    if (meta?.kind === "overflow") onToggleFork(meta.overflowForkId!);
    else onToggleRun(node.id);
  }, [meta, node.id, onToggleFork, onToggleRun, suppressDblClickRef]);

  const groupCount = isCollapsedGroup ? meta!.count : undefined;
  const badgeText = groupCount == null ? "" : groupCount > 99 ? "99+" : String(groupCount);
  // A 1-digit badge fits the base radius; wider text needs a wider circle to
  // stay centered instead of overflowing it.
  const groupDotRadius =
    badgeText.length >= 3 ? GROUP_DOT_RADIUS + 3 : badgeText.length === 2 ? GROUP_DOT_RADIUS + 1.5 : GROUP_DOT_RADIUS;
  const centerX = (l: number) => GRAPH_PAD_LEFT + l * LANE_WIDTH + LANE_WIDTH / 2;
  const rowCenterY = ROW_HEIGHT / 2;
  const dotX = centerX(lane);

  return (
    <Group gap={0} wrap="nowrap" align="center" style={{ position: "relative", minHeight: ROW_HEIGHT }}>
      <svg width={graphWidth} height={ROW_HEIGHT} style={{ display: "block", flexShrink: 0 }} role="presentation">
        {/* Pass-through vertical bars */}
        {passThroughLanes.map((l, i) => (
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
        {/* Incoming vertical stub into the top of this node's circle, drawn
            only where the layout put a child directly above in this lane. */}
        {sameLaneChild && (
          <line x1={dotX} x2={dotX} y1={0} y2={rowCenterY} stroke="var(--mantine-color-dark-4)" strokeWidth={1} />
        )}
        {/* Diagonals landing in this row (child lane → parent lane). */}
        {rowDiagonals.map((d, i) => (
          <line
            key={`d-${i}-${d.fromLane}-${d.toLane}`}
            x1={centerX(d.fromLane)}
            y1={0}
            x2={centerX(d.toLane)}
            y2={rowCenterY}
            stroke="var(--mantine-color-dark-4)"
            strokeWidth={1}
          />
        ))}
        {/* Outgoing stub to the next row, where the layout drew an edge down
            to this node's parent. */}
        {parentEdge && (
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
                toggleGroup();
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
              if (isCollapsedGroup) {
                toggleGroup();
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
              {isOverflow && meta?.hasFavorite && (
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
                  {node.customLabel ?? node.label}
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
          {isOverflow ? (
            <Menu.Item onClick={() => onToggleFork(meta!.overflowForkId!)}>Expand</Menu.Item>
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

  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const [expandedForks, setExpandedForks] = useState<Set<string>>(() => new Set());
  const suppressDblClickRef = useRef(false);
  // Any history change (a new stroke, an undo, a redo) collapses everything
  // back down — there's no manual collapse control, only expand-to-peek.
  useEffect(() => {
    setExpandedRuns(new Set());
    setExpandedForks(new Set());
  }, [manager, manifest?.currentId]);
  const onToggleRun = useCallback((nodeId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);
  const onToggleFork = useCallback((forkNodeId: string) => {
    setExpandedForks((prev) => {
      const next = new Set(prev);
      if (next.has(forkNodeId)) next.delete(forkNodeId);
      else next.add(forkNodeId);
      return next;
    });
  }, []);

  const visibleTree = useMemo(
    () => (manifest ? buildVisibleTree(manifest.nodes, manifest.currentId, expandedRuns, expandedForks) : null),
    // `manifest` is mutated in place; `version` is what actually changes on
    // tree mutation, so include it as an explicit invalidation dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, version, expandedRuns, expandedForks],
  );
  const layout = useMemo(() => (visibleTree ? layoutTree(visibleTree.tree) : null), [visibleTree]);
  const graphWidth = (layout?.laneCount ?? 1) * LANE_WIDTH + GRAPH_PAD_LEFT + GRAPH_PAD_RIGHT;
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
          <Stack gap={0} pr={8} miw={graphWidth + MIN_LABEL_WIDTH}>
            {layout.rows.map((row) => (
              <Box key={row.node.id} ref={row.node.id === manifest.currentId ? currentScrollRef : undefined}>
                <HistoryRow
                  row={row}
                  isCurrent={row.node.id === manifest.currentId}
                  graphWidth={graphWidth}
                  passThroughLanes={layout.passThroughLanes[row.rowIndex]}
                  rowDiagonals={rowDiagonals.get(row.rowIndex) ?? []}
                  sameLaneChild={layout.sameLaneChild[row.rowIndex]}
                  parentEdge={layout.parentEdge[row.rowIndex]}
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
                  onToggleRun={onToggleRun}
                  onToggleFork={onToggleFork}
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
