import { useStore } from "@/store";
import { Box, Group, Loader, Stack, Text } from "@mantine/core";
import { openFiles, selectFileColor } from "@renderer/store/files";
import { getLayerSegments, stackColor } from "@renderer/store/layers";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { useUiSize } from "@renderer/lib/ui-density";
import { layerTint } from "@renderer/lib/layer-tint";
import { helpProps } from "@renderer/lib/ui-controls";
import { Layers, Link2, Link2Off, Merge, Plus, Rows3, Ungroup, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FileReorderProvider } from "@renderer/contexts/file-reorder";
import { type FileDropTarget } from "@renderer/lib/file-reorder";
import { FileView } from "../file-view";
import { Tooltip } from "../tooltip";

const DockedFile = memo(({ fileId }: { fileId: string }) => {
  const file = openFiles[fileId];
  const isHighlighted = useStore((state) => state.highlightedSourcePath === file?.filePath);
  const isLoading = useStore((state) => !!state.filesLoading[fileId] || !!state.filesBusy[fileId]);
  const fileColor = useStore((state) => selectFileColor(state, fileId));
  if (!file) return null;
  const displayName = file.displayName;

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

type LayerBoxProps = {
  fileId: string;
  /** Every layer of an overlaid stack, so one box can draw them all. */
  stackLayerIds?: string[];
  activeFileId: string | null;
  activeRef: RefObject<HTMLDivElement | null>;
  fullscreenFileId: string | null;
  minimizedFileIds: string[];
};

const LayerBox = memo(
  ({ fileId, stackLayerIds, activeFileId, activeRef, fullscreenFileId, minimizedFileIds }: LayerBoxProps) => {
    const isFullscreen = fullscreenFileId === fileId;
    const isMinimized = minimizedFileIds.includes(fileId);
    const hidden = (fullscreenFileId !== null && !isFullscreen) || isMinimized;
    return (
      <Box
        ref={fileId === activeFileId ? activeRef : undefined}
        style={{ display: hidden ? "none" : undefined, minHeight: isFullscreen ? 0 : undefined }}
        h={isFullscreen ? "100%" : undefined}
        flex={isFullscreen ? 1 : undefined}
      >
        <FileView fileId={fileId} isFullscreen={isFullscreen} isMinimized={isMinimized} stackLayerIds={stackLayerIds} />
      </Box>
    );
  },
);
LayerBox.displayName = "LayerBox";

/**
 * Wraps the layers of one stack in a rail carrying its colour, with a header for
 * the operations that act on the whole stack. The rail is what makes the layers
 * read as connected rather than as files that happen to be adjacent.
 */
/**
 * The tabs of an overlaid stack: one per layer, in its own hue, with the layer
 * on top lit. Clicking one moves where you paint without stopping the mix.
 */
const LayerTabs = memo(({ layerIds, currentId }: { layerIds: string[]; currentId: string }) => {
  return (
    <Group gap={2} wrap="nowrap" px={4} pb={4} style={{ overflowX: "auto" }}>
      {layerIds.map((layerId, index) => {
        const file = openFiles[layerId];
        if (!file) return null;
        const { left, right } = layerTint(index, layerIds.length);
        const hue = `rgb(${left.map((c, i) => Math.round((c + right[i]) * 127.5)).join(",")})`;
        const isCurrent = layerId === currentId;
        return (
          <Tooltip key={layerId} help="stack-layer-tab" detail={file.displayName}>
            <Box
              {...helpProps("stack-layer-tab")}
              onClick={() => void useStore.getState().setActiveFileId(layerId)}
              px={8}
              py={2}
              style={{
                cursor: "pointer",
                borderRadius: 3,
                borderBottom: `2px solid ${hue}`,
                backgroundColor: isCurrent ? "var(--mantine-color-dark-5)" : "transparent",
                opacity: isCurrent ? 1 : 0.6,
                whiteSpace: "nowrap",
                maxWidth: 180,
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontSize: 11,
              }}
            >
              {file.displayName}
            </Box>
          </Tooltip>
        );
      })}
    </Group>
  );
});
LayerTabs.displayName = "LayerTabs";

const LayerStackSection = memo(
  ({
    stackId,
    fileIds,
    isDropTarget,
    ...laneProps
  }: { stackId: string; fileIds: string[]; isDropTarget: boolean } & Omit<LayerBoxProps, "fileId">) => {
    const stack = useStore((state) => state.layerStacks[stackId]);
    const anyLoading = useStore((state) => fileIds.some((id) => !!state.filesLoading[id] || !!state.filesBusy[id]));
    const uiSize = useUiSize();

    // Fullscreen takes over the canvas, so the stack chrome would just be a
    // stray bar above it.
    const chromeHidden = laneProps.fullscreenFileId !== null;
    if (!stack) {
      return (
        <>
          {fileIds.map((fileId) => (
            <LayerBox key={fileId} fileId={fileId} {...laneProps} />
          ))}
        </>
      );
    }

    // Overlaid needs a layer on top: the active file when it is in this stack,
    // and otherwise the first layer.
    const overlaid = stack.layout === "overlaid" && fileIds.length > 1;
    const currentId = fileIds.includes(laneProps.activeFileId ?? "") ? laneProps.activeFileId! : fileIds[0];

    const color = stackColor(stack.hue);

    return (
      <Box
        style={{
          borderLeft: chromeHidden ? undefined : `2px solid ${color}`,
          paddingLeft: chromeHidden ? undefined : 6,
          borderRadius: 2,
          // A drag heading into this stack tints the whole section, so the
          // indicator line reads as "inside here" rather than "somewhere near".
          outline: isDropTarget ? `1px solid ${color}` : undefined,
          backgroundColor: isDropTarget ? `hsl(${stack.hue}, 62%, 57%, 0.08)` : undefined,
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
              {stack.label}
            </Text>
            {anyLoading && <Loader size={10} color="gray" />}
            <HelpActionIcon
              help="stack-layout"
              detail={overlaid ? "Overlaid" : "Stacked"}
              size={uiSize}
              variant="subtle"
              color="gray"
              onClick={() => useStore.getState().setLayerStackLayout(stackId, overlaid ? "stacked" : "overlaid")}
            >
              {overlaid ? <Layers size={16} /> : <Rows3 size={16} />}
            </HelpActionIcon>
            {/* Overlaid layers share one viewport, so the link has nothing to tie. */}
            {!overlaid && (
              <HelpActionIcon
                help="stack-sync-view"
                detail={stack.syncView ? "Linked" : "Unlinked"}
                size={uiSize}
                variant="subtle"
                color={stack.syncView ? "gray" : "dark.3"}
                onClick={() => useStore.getState().setLayerStackSyncView(stackId, !stack.syncView)}
              >
                {stack.syncView ? <Link2 size={16} /> : <Link2Off size={16} />}
              </HelpActionIcon>
            )}
            <HelpActionIcon
              help="stack-add-layer"
              size={uiSize}
              variant="subtle"
              color="gray"
              loading={anyLoading}
              onClick={() => void useStore.getState().addEmptyLayer(currentId)}
            >
              <Plus size={16} />
            </HelpActionIcon>
            <HelpActionIcon
              help="stack-merge"
              detail={`${stack.layerIds.length} layers`}
              size={uiSize}
              variant="subtle"
              color="gray"
              loading={anyLoading}
              // One file has nothing to sum with.
              disabled={stack.layerIds.length < 2}
              onClick={() => useStore.getState().mergeLayerStack(stackId)}
            >
              <Merge size={16} />
            </HelpActionIcon>
            <HelpActionIcon
              help="stack-unstack"
              detail={`${stack.layerIds.length} layers`}
              size={uiSize}
              variant="subtle"
              color="gray"
              onClick={() => useStore.getState().unstackLayers(stackId)}
            >
              <Ungroup size={16} />
            </HelpActionIcon>
            <HelpActionIcon
              help="stack-close"
              detail={`${stack.layerIds.length} layers`}
              size={uiSize}
              variant="subtle"
              color="gray"
              onClick={() => useStore.getState().closeLayerStack(stackId)}
            >
              <X size={16} />
            </HelpActionIcon>
          </Group>
        )}
        {overlaid ? (
          <>
            {!chromeHidden && <LayerTabs layerIds={fileIds} currentId={currentId} />}
            <LayerBox fileId={currentId} stackLayerIds={fileIds} {...laneProps} />
          </>
        ) : (
          <Stack gap="xs" h={chromeHidden ? "100%" : undefined} style={chromeHidden ? { minHeight: 0 } : undefined}>
            {fileIds.map((fileId) => (
              <LayerBox key={fileId} fileId={fileId} {...laneProps} />
            ))}
          </Stack>
        )}
      </Box>
    );
  },
);
LayerStackSection.displayName = "LayerStackSection";

export const CanvasPanel = memo(() => {
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const minimizedFileIds = useStore((state) => state.minimizedFileIds);
  const activeFileId = useStore((state) => state.activeFileId);
  const stackOfLayer = useStore((state) => state.stackOfLayer);

  // Bring the active file into view when it changes (e.g. opening a file that's
  // already open further down the list). `nearest` keeps already-visible files put.
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeFileId]);

  const stackRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<FileDropTarget | null>(null);
  const handleTargetChange = useCallback((target: FileDropTarget | null) => setDropTarget(target), []);

  const segments = useMemo(() => getLayerSegments(openFileIds, stackOfLayer), [openFileIds, stackOfLayer]);
  const laneProps = useMemo(
    () => ({ activeFileId, activeRef, fullscreenFileId, minimizedFileIds }),
    [activeFileId, fullscreenFileId, minimizedFileIds],
  );

  return (
    <FileReorderProvider containerRef={stackRef} onTargetChange={handleTargetChange}>
      <Stack
        ref={stackRef}
        h={fullscreenFileId ? "100%" : undefined}
        flex={fullscreenFileId ? 1 : undefined}
        style={fullscreenFileId ? { minHeight: 0 } : undefined}
        pos="relative"
        gap={"xs"}
      >
        {segments.map((segment, index) =>
          segment.stackId !== null ? (
            <LayerStackSection
              key={`${segment.stackId}-${index}`}
              stackId={segment.stackId}
              fileIds={segment.fileIds}
              isDropTarget={dropTarget?.stackId === segment.stackId}
              {...laneProps}
            />
          ) : (
            segment.fileIds.map((fileId) => <LayerBox key={fileId} fileId={fileId} {...laneProps} />)
          ),
        )}
        {dropTarget && (
          <Box
            pos="absolute"
            // Inset to the stack's own content edge when the drop joins one, so
            // the line sits where the layer will.
            left={dropTarget.stackId ? 8 : 0}
            right={0}
            top={dropTarget.y - 1}
            h={2}
            bg="orange.5"
            style={{ pointerEvents: "none", zIndex: 3, borderRadius: 2 }}
          />
        )}
      </Stack>
    </FileReorderProvider>
  );
});

CanvasPanel.displayName = "CanvasPanel";
