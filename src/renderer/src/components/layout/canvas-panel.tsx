import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  console.log("CanvasPanel render");

  const openFileIds = useStore((state) => state.openFileIds);

  console.log("openFileIds", openFileIds);

  return (
    <Stack pos="relative" gap={"xs"}>
      {openFileIds.map((fileId) => (
        <FileView key={fileId} fileId={fileId} />
      ))}
    </Stack>
  );
});

CanvasPanel.displayName = "CanvasPanel";
