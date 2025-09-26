import { useStore } from "@/store";
import { Flex, ScrollArea } from "@mantine/core";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  const openFilePaths = useStore((state) => state.openFilePaths);

  console.log("openFilePaths", openFilePaths);

  return (
    <Flex direction="column" flex={1} pos="relative" bg="dark.9">
      <ScrollArea flex={1} pos="relative">
        {openFilePaths.map((filePath) => (
          <FileView key={filePath} filePath={filePath} />
        ))}
      </ScrollArea>
    </Flex>
  );
});

CanvasPanel.displayName = "CanvasPanel";
