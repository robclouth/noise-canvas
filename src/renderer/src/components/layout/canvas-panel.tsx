import { FileRenderer } from "@/components/file-renderer";
import { openFilesAtom } from "@/store";
import { Flex, ScrollArea } from "@mantine/core";
import { Canvas } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { FileView } from "../file-view";

export const CanvasPanel = () => {
  const openFiles = useAtomValue(openFilesAtom);

  return (
    <Flex direction="column" flex={1} pos="relative" bg="dark.9">
      <Canvas
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
      >
        {Object.values(openFiles).map((file) => (
          <FileRenderer key={file.filePath} file={file} viewRef={file.viewRef} ref={file.rendererRef} />
        ))}
      </Canvas>
      <ScrollArea flex={1} pos="relative">
        {Object.values(openFiles).map((file) => (
          <FileView key={file.filePath} file={file} viewRef={file.viewRef} rendererRef={file.rendererRef} />
        ))}
      </ScrollArea>
    </Flex>
  );
};
