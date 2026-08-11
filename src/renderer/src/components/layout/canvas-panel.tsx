import { useStore } from "@/store";
import { Box, Group, Loader, Stack, Text } from "@mantine/core";
import { getFileColor, openFiles } from "@renderer/store/files";
import { getFileSegments, selectStemGroupOfFile, stemGroupColor, stemMemberColor } from "@renderer/store/stem-groups";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { useUiSize } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import { Layers, Link2, Link2Off, Merge, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { FileView } from "../file-view";
import { Tooltip } from "../tooltip";

const DockedFile = memo(({ fileId }: { fileId: string }) => {
  const file = openFiles[fileId];
  const isHighlighted = useStore((state) => state.highlightedSourcePath === file?.filePath);
  const isLoading = useStore((state) => !!state.filesLoading[fileId]);
  const stemGroup = useStore((state) => selectStemGroupOfFile(state, fileId));
  if (!file) return null;
  const displayName = file.displayName;
  const fileColor = stemGroup
    ? stemMemberColor(stemGroup.hue, stemGroup.memberIds.indexOf(fileId), stemGroup.memberIds.length)
    : getFileColor(file.filePath);

  return (
    <Tooltip help="dock-file" detail={displayName}>
      <Group
        {...helpProps("dock-file")}
        gap={4}
        px={2}
        py={0}
        bg={isHighlighted ? "dark.5" : "dark.6"}
        style={{
          borderRadius: 4,
          cursor: "pointer",
          border: `1px solid ${isHighlighted ? "var(--mantine-color-blue-6)" : "var(--mantine-color-dark-4)"}`,
          borderLeft: `3px solid ${fileColor}`,
          transition: "background-color 100ms ease",
          minHeight: 24,
          alignItems: "center",
          padding: 6,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--mantine-color-dark-5)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = isHighlighted
            ? "var(--mantine-color-dark-5)"
            : "var(--mantine-color-dark-6)";
        }}
        onClick={() => useStore.getState().setFileMinimized(fileId, false)}
      >
        {isLoading && <Loader size={10} color="gray" />}
        <Text
          size="xs"
          c="gray.4"
          style={{
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            paddingLeft: 2,
          }}
        >
          {displayName}
        </Text>
        <HelpActionIcon
          help="dock-close"
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().tryCloseFile(fileId);
          }}
        >
          <X size={10} />
        </HelpActionIcon>
      </Group>
    </Tooltip>
  );
});
DockedFile.displayName = "DockedFile";

export const Dock = memo(() => {
  const minimizedFileIds = useStore((state) => state.minimizedFileIds);
  const openFileIds = useStore((state) => state.openFileIds);

  const minimized = openFileIds.filter((id) => minimizedFileIds.includes(id));
  if (minimized.length === 0) return null;

  return (
    <Group
      {...helpProps("dock")}
      gap={6}
      px={8}
      py={6}
      bg="dark.7"
      style={{
        borderTop: "1px solid var(--mantine-color-dark-5)",
        flexShrink: 0,
      }}
    >
      {minimized.map((fileId) => (
        <DockedFile key={fileId} fileId={fileId} />
      ))}
    </Group>
  );
});
Dock.displayName = "Dock";

type FileLaneProps = {
  fileId: string;
  activeFileId: string | null;
  activeRef: RefObject<HTMLDivElement | null>;
  fullscreenFileId: string | null;
  minimizedFileIds: string[];
};

const FileLane = memo(({ fileId, activeFileId, activeRef, fullscreenFileId, minimizedFileIds }: FileLaneProps) => {
  const isFullscreen = fullscreenFileId === fileId;
  const hidden = (fullscreenFileId !== null && !isFullscreen) || minimizedFileIds.includes(fileId);
  return (
    <Box
      ref={fileId === activeFileId ? activeRef : undefined}
      style={{ display: hidden ? "none" : undefined }}
      h={isFullscreen ? "100%" : undefined}
      flex={isFullscreen ? 1 : undefined}
    >
      <FileView fileId={fileId} isFullscreen={isFullscreen} />
    </Box>
  );
});
FileLane.displayName = "FileLane";

/**
 * Wraps the lanes of one split in a rail carrying the group's colour, with a
 * header for the operations that act on the whole group. The rail is what makes
 * the parts read as connected rather than as files that happen to be adjacent.
 */
const StemGroupSection = memo(
  ({ groupId, fileIds, ...laneProps }: { groupId: string; fileIds: string[] } & Omit<FileLaneProps, "fileId">) => {
    const group = useStore((state) => state.stemGroups[groupId]);
    const anyLoading = useStore((state) => fileIds.some((id) => !!state.filesLoading[id]));
    const uiSize = useUiSize();

    // Fullscreen takes over the canvas, so the group chrome would just be a
    // stray bar above it.
    const chromeHidden = laneProps.fullscreenFileId !== null;
    if (!group) {
      return (
        <>
          {fileIds.map((fileId) => (
            <FileLane key={fileId} fileId={fileId} {...laneProps} />
          ))}
        </>
      );
    }

    const color = stemGroupColor(group.hue);

    return (
      <Box
        style={{
          borderLeft: chromeHidden ? undefined : `2px solid ${color}`,
          paddingLeft: chromeHidden ? undefined : 6,
          borderRadius: 2,
        }}
        h={laneProps.fullscreenFileId !== null ? "100%" : undefined}
        flex={laneProps.fullscreenFileId !== null ? 1 : undefined}
      >
        {/* The space above the header row is already the canvas gap — the panel's
            own padding for the first segment, the inter-segment gap otherwise —
            so the row pads only below, by the same amount, to sit evenly. */}
        {!chromeHidden && (
          <Group gap="xs" wrap="nowrap" pb="xs" px={4} style={{ minHeight: 24 }}>
            <Layers size={16} color={color} style={{ flexShrink: 0 }} />
            <Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0, flex: 1 }}>
              {group.label}
            </Text>
            {anyLoading && <Loader size={10} color="gray" />}
            <HelpActionIcon
              help="stem-sync-view"
              detail={group.syncView ? "Linked" : "Unlinked"}
              size={uiSize}
              variant="subtle"
              color={group.syncView ? "gray" : "dark.3"}
              onClick={() => useStore.getState().setStemGroupSyncView(groupId, !group.syncView)}
            >
              {group.syncView ? <Link2 size={16} /> : <Link2Off size={16} />}
            </HelpActionIcon>
            <HelpActionIcon
              help="stem-merge"
              detail={`${group.memberIds.length} parts`}
              size={uiSize}
              variant="subtle"
              color="gray"
              loading={anyLoading}
              onClick={() => useStore.getState().mergeStemGroup(groupId)}
            >
              <Merge size={16} />
            </HelpActionIcon>
            <HelpActionIcon
              help="stem-close"
              detail={`${group.memberIds.length} parts`}
              size={uiSize}
              variant="subtle"
              color="gray"
              onClick={() => useStore.getState().closeStemGroup(groupId)}
            >
              <X size={16} />
            </HelpActionIcon>
          </Group>
        )}
        <Stack gap="xs">
          {fileIds.map((fileId) => (
            <FileLane key={fileId} fileId={fileId} {...laneProps} />
          ))}
        </Stack>
      </Box>
    );
  },
);
StemGroupSection.displayName = "StemGroupSection";

export const CanvasPanel = memo(() => {
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const minimizedFileIds = useStore((state) => state.minimizedFileIds);
  const activeFileId = useStore((state) => state.activeFileId);
  const stemGroupOfFile = useStore((state) => state.stemGroupOfFile);

  // Bring the active file into view when it changes (e.g. opening a file that's
  // already open further down the list). `nearest` keeps already-visible files put.
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeFileId]);

  const segments = useMemo(() => getFileSegments(openFileIds, stemGroupOfFile), [openFileIds, stemGroupOfFile]);
  const laneProps = useMemo(
    () => ({ activeFileId, activeRef, fullscreenFileId, minimizedFileIds }),
    [activeFileId, fullscreenFileId, minimizedFileIds],
  );

  return (
    <Stack h={fullscreenFileId ? "100%" : undefined} pos="relative" gap={"xs"}>
      {segments.map((segment, index) =>
        segment.groupId !== null ? (
          <StemGroupSection
            key={`${segment.groupId}-${index}`}
            groupId={segment.groupId}
            fileIds={segment.fileIds}
            {...laneProps}
          />
        ) : (
          segment.fileIds.map((fileId) => <FileLane key={fileId} fileId={fileId} {...laneProps} />)
        ),
      )}
    </Stack>
  );
});

CanvasPanel.displayName = "CanvasPanel";
