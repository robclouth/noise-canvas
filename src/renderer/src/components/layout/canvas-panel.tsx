import { openFilesAtom } from "@/store";
import { Flex, ScrollArea } from "@mantine/core";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  const openFiles = useAtomValue(openFilesAtom);

  console.log("CanvasPanel rendered");

  return (
    <Flex direction="column" flex={1} pos="relative" bg="dark.9">
      <ScrollArea flex={1} pos="relative">
        {Object.values(openFiles).map((file) => (
          <FileView key={file.filePath} filePath={file.filePath} />
        ))}
      </ScrollArea>
    </Flex>
  );
});

CanvasPanel.displayName = "CanvasPanel";
