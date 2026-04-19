import { useStore } from "@/store";
import { ActionIcon, Box, Group, Loader, Stack, Text } from "@mantine/core";
import { getFileColor, openFiles } from "@renderer/store/files";
import { X } from "lucide-react";
import { memo } from "react";
import { FileView } from "../file-view";
import { Tooltip } from "../tooltip";

const PaletteChip = memo(({ fileId }: { fileId: string }) => {
  const file = openFiles[fileId];
  const isHighlighted = useStore((state) => state.highlightedSourcePath === file?.filePath);
  const isLoading = useStore((state) => !!state.filesLoading[fileId]);
  if (!file) return null;
  const filename = file.filePath.split("/").pop() || file.filePath;
  const fileColor = getFileColor(file.filePath);

  return (
    <Tooltip label={filename}>
      <Group
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
          {filename}
        </Text>
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().tryCloseFile(fileId);
          }}
        >
          <X size={10} />
        </ActionIcon>
      </Group>
    </Tooltip>
  );
});
PaletteChip.displayName = "PaletteChip";

export const PaletteBar = memo(() => {
  const minimizedFileIds = useStore((state) => state.minimizedFileIds);
  const openFileIds = useStore((state) => state.openFileIds);

  const minimized = openFileIds.filter((id) => minimizedFileIds.includes(id));
  if (minimized.length === 0) return null;

  return (
    <Group
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
        <PaletteChip key={fileId} fileId={fileId} />
      ))}
    </Group>
  );
});
PaletteBar.displayName = "PaletteBar";

export const CanvasPanel = memo(() => {
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const minimizedFileIds = useStore((state) => state.minimizedFileIds);

  return (
    <Stack h={fullscreenFileId ? "100%" : undefined} pos="relative" gap={"xs"}>
      {openFileIds.map((fileId) => {
        const isFullscreen = fullscreenFileId === fileId;
        const isMinimized = minimizedFileIds.includes(fileId);
        const hiddenByFullscreen = fullscreenFileId !== null && !isFullscreen;
        const hidden = hiddenByFullscreen || isMinimized;
        return (
          <Box
            key={fileId}
            style={{ display: hidden ? "none" : undefined }}
            h={isFullscreen ? "100%" : undefined}
            flex={isFullscreen ? 1 : undefined}
          >
            <FileView fileId={fileId} isFullscreen={isFullscreen} />
          </Box>
        );
      })}
    </Stack>
  );
});

CanvasPanel.displayName = "CanvasPanel";
