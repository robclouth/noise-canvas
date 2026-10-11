import { useStore } from "@/store";
import { Box, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import { openFiles, selectFileColor } from "@renderer/store/files";
import { getLayerSegments, selectLayerStack, stackColor } from "@renderer/store/layers";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { FILE_HEADER_PAD, useUiSize } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import { Layers, Link2, Link2Off, Merge, Plus, Rows3, Ungroup, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from "react";
import { FileReorderProvider } from "@renderer/contexts/file-reorder";
import { type FileDropTarget } from "@renderer/lib/file-reorder";
import { FileView } from "../file-view";
import { Tooltip } from "../tooltip";
import { FileMixControls } from "../file-mix-controls";
import { layerTabLabel } from "@renderer/lib/layer-tab-label";

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
  headerExtras?: ReactNode;
  activeFileId: string | null;
  activeRef: RefObject<HTMLDivElement | null>;
  fullscreenFileId: string | null;
  minimizedFileIds: string[];
};

const LayerBox = memo(
  ({ fileId, headerExtras, activeFileId, activeRef, fullscreenFileId, minimizedFileIds }: LayerBoxProps) => {
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
        <FileView
          key={fileId}
          fileId={fileId}
          isFullscreen={isFullscreen}
          isMinimized={isMinimized}
          headerExtras={headerExtras}
        />
      </Box>
    );
  },
);
LayerBox.displayName = "LayerBox";

/** Selects the editing layer while keeping each layer's mix controls available. */
const LayerTabs = memo(({ layerIds, currentId }: { layerIds: string[]; currentId: string }) => {
  const stack = useStore((state) => selectLayerStack(state, currentId));
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[role="tab"][data-active]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentId, layerIds.length]);
  return (
    <Tabs
      ref={tabsRef}
      value={currentId}
      onChange={(id) => {
        if (id) void useStore.getState().setActiveFileId(id);
      }}
      variant="default"
      style={{ overflowX: "auto", minWidth: 0, maxWidth: "100%", flex: "0 1 auto" }}
    >
      <Tabs.List style={{ flexWrap: "nowrap", width: "max-content", minWidth: "100%" }}>
        {layerIds.map((layerId) => {
          const file = openFiles[layerId];
          if (!file) return null;
          return (
            <Box key={layerId} pos="relative" style={{ flexShrink: 0 }} {...helpProps("stack-layer-tab")}>
              <Tooltip help="stack-layer-tab" detail={file.displayName}>
                <Tabs.Tab
                  value={layerId}
                  fz="xs"
                  pr={58}
                  style={{ maxWidth: 180 }}
                  styles={{ tabLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }}
                >
                  {layerId === stack?.originId ? "Original" : layerTabLabel(file.displayName, stack?.label)}
                </Tabs.Tab>
              </Tooltip>
              <Box pos="absolute" right={8} top="50%" style={{ transform: "translateY(-50%)" }}>
                <FileMixControls fileId={layerId} compact />
              </Box>
            </Box>
          );
        })}
      </Tabs.List>
    </Tabs>
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

    // Fullscreen presents the selected file without stack controls.
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

    // Tabbed shows one layer: the active file when it is in this stack, and
    // otherwise the first layer.
    const overlaid = stack.layout === "overlaid" && fileIds.length > 1;
    const currentId = fileIds.includes(laneProps.activeFileId ?? "") ? laneProps.activeFileId! : fileIds[0];

    const color = stackColor(stack.hue);
    const header = (
      <Group gap="xs" wrap="nowrap" p={FILE_HEADER_PAD} onPointerDown={(event) => event.stopPropagation()}>
        <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {overlaid ? (
            <LayerTabs layerIds={fileIds} currentId={currentId} />
          ) : (
            <>
              <Layers size={16} color={color} style={{ flexShrink: 0 }} />
              <Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0, flex: 1 }}>
                {stack.label}
              </Text>
              {anyLoading && <Loader size={10} color="gray" />}
            </>
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
        </Group>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0, marginLeft: "auto" }}>
          <HelpActionIcon
            help="stack-layout"
            detail={overlaid ? "Tabbed" : "Stacked"}
            size={uiSize}
            variant="subtle"
            color="gray"
            onClick={() => useStore.getState().setLayerStackLayout(stackId, overlaid ? "stacked" : "overlaid")}
          >
            {overlaid ? <Layers size={16} /> : <Rows3 size={16} />}
          </HelpActionIcon>
          {/* Tabbed layers share one viewport, so the link has nothing to tie. */}
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
      </Group>
    );

    return (
      <Box
        style={{
          borderLeft: chromeHidden || overlaid ? undefined : `2px solid ${color}`,
          paddingLeft: chromeHidden || overlaid ? undefined : 6,
          borderRadius: 2,
          // A drag heading into this stack tints the whole section, so the
          // indicator line reads as "inside here" rather than "somewhere near".
          outline: isDropTarget ? `1px solid ${color}` : undefined,
          backgroundColor: isDropTarget ? `hsl(${stack.hue}, 62%, 57%, 0.08)` : undefined,
        }}
        h={laneProps.fullscreenFileId !== null ? "100%" : undefined}
        flex={laneProps.fullscreenFileId !== null ? 1 : undefined}
      >
        {!chromeHidden && !overlaid && header}
        {overlaid ? (
          <LayerBox fileId={currentId} {...laneProps} headerExtras={chromeHidden ? undefined : header} />
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
