import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);

  const visibleIds = fullscreenFileId ? [fullscreenFileId] : openFileIds;

  return (
    <Stack h={fullscreenFileId ? "100%" : undefined} pos="relative" gap={"xs"}>
      {visibleIds.map((fileId) => (
        <FileView key={fileId} fileId={fileId} isFullscreen={fullscreenFileId === fileId} />
      ))}
    </Stack>
  );
});

CanvasPanel.displayName = "CanvasPanel";
