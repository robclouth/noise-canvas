import { FileRenderer } from "@/components/file-renderer";
import { ActionIcon, Flex, NumberInput, Paper, ScrollArea, Text } from "@mantine/core";
import { Canvas } from "@react-three/fiber";
import { useAtom, useAtomValue } from "jotai";
import { Play, Repeat, Square } from "lucide-react";
import { createRef, useMemo } from "react";
import { playAudio, playbackTimeAtom, stopAudio } from "../../audio-manager";
import { activeFileAtom, bpmAtom, isPlayingAtom, loopAtom, openFilesAtom } from "../../store";
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
  const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);
  const [loop, setLoop] = useAtom(loopAtom);
  const openFiles = useAtomValue(openFilesAtom);
  const activeFile = useAtomValue(activeFileAtom);

  const viewRefs = useMemo(
    () =>
      Array(openFiles.length)
        .fill(0)
        .map(() => createRef<HTMLDivElement>()),
    [openFiles.length],
  );

  const handleTogglePlay = async (): Promise<void> => {
    if (isPlaying) {
      stopAudio();
    } else {
      if (activeFile && activeFile.renderingContext) {
        await activeFile.renderingContext.triggerSynthesis();
        await playAudio();
        setIsPlaying(true);
      }
    }
  };

  return (
    <Flex direction="column" flex={1} pos="relative">
      <Canvas
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
      >
        {openFiles.map((file, index) => (
          <FileRenderer key={file.id} file={file} viewRef={viewRefs[index]} />
        ))}
      </Canvas>
      <ScrollArea flex={1} pos="relative">
        {openFiles.map((file, index) => (
          <FileView key={file.id} file={file} viewRef={viewRefs[index]} />
        ))}
      </ScrollArea>

      <Paper h={80} p="md" radius={0} bg="dark.7">
        <Flex align="center" justify="center" gap="md">
          <NumberInput w={100} value={bpm} onChange={(val) => setBpm(Number(val))} />
          <ActionIcon onClick={handleTogglePlay} size="lg">
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
