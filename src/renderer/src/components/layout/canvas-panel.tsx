import { openFileAtomsAtom } from "@/store";
import { Flex, ScrollArea } from "@mantine/core";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { FileView } from "../file-view";

export const CanvasPanel = memo(() => {
  const openFileAtoms = useAtomValue(openFileAtomsAtom);

  return (
    <Flex direction="column" flex={1} pos="relative" bg="dark.9">
      <ScrollArea flex={1} pos="relative">
        {openFileAtoms.map((fileAtom) => (
          <FileView key={`${fileAtom}`} fileAtom={fileAtom} />
        ))}
      </ScrollArea>
    </Flex>
  );
});

CanvasPanel.displayName = "CanvasPanel";
