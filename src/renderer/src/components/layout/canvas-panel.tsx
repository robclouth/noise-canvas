import { useStore } from "@/store";
import { Box, Stack } from "@mantine/core";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);

  return (
    <Stack h={fullscreenFileId ? "100%" : undefined} pos="relative" gap={"xs"}>
      {openFileIds.map((fileId) => {
        const isFullscreen = fullscreenFileId === fileId;
        const hidden = fullscreenFileId !== null && !isFullscreen;
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
