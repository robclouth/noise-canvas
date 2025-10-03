import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  console.log("CanvasPanel render");

  const openFilePaths = useStore((state) => state.openFilePaths);

  console.log("openFilePaths", openFilePaths);

  return (
    <Stack pos="relative" gap={0}>
      {openFilePaths.map((filePath) => (
        <FileView key={filePath} filePath={filePath} />
      ))}
    </Stack>
  );
});

CanvasPanel.displayName = "CanvasPanel";
