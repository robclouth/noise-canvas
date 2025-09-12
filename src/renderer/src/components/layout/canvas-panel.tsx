import { FileRenderer } from "@/components/file-renderer";
import { ActionIcon, Flex, NumberInput, Paper, ScrollArea, Text } from "@mantine/core";
import { Canvas } from "@react-three/fiber";
import { useAtom, useAtomValue } from "jotai";
import { Play, Repeat, Square } from "lucide-react";
import { isSynthesizingAtom, playbackTimeAtom, togglePlayback } from "@/audio-manager";
import { bpmAtom, isPlayingAtom, loopAtom, openFilesAtom } from "@/store";
import { FileView } from "../file-view";

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.floor((seconds % 1) * 1000)
    .toString()
    .padStart(3, "0");
  return `${h}:${m}:${s}:${ms}`;
};

export const CanvasPanel = () => {
  const playbackTime = useAtomValue(playbackTimeAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);
  const [loop, setLoop] = useAtom(loopAtom);
  const openFiles = useAtomValue(openFilesAtom);
  const isSynthesizing = useAtomValue(isSynthesizingAtom);

  return (
    <Flex direction="column" flex={1} pos="relative">
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

      <Paper h={80} p="md" radius={0} bg="dark.7">
        <Flex align="center" justify="center" gap="md">
          <NumberInput w={100} value={bpm} onChange={(val) => setBpm(Number(val))} />
          <ActionIcon onClick={togglePlayback} size="lg" disabled={isSynthesizing}>
            {isPlaying ? <Square /> : <Play />}
          </ActionIcon>
          <ActionIcon onClick={() => setLoop(!loop)} size="lg" variant={loop ? "filled" : "outline"}>
            <Repeat />
          </ActionIcon>
          <Text ff="monospace" size="xl">
            {formatTime(playbackTime)}
          </Text>
        </Flex>
      </Paper>
    </Flex>
  );
};
