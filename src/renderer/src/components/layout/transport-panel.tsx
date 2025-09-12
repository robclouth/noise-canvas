import { isSynthesizingAtom, playbackTimeAtom, togglePlayback } from "@/audio-manager";
import { bpmAtom, isPlayingAtom, loopAtom } from "@/store";
import { ActionIcon, Flex, NumberInput, Text } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { Play, Repeat, Square } from "lucide-react";

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

export const TransportPanel = () => {
  const playbackTime = useAtomValue(playbackTimeAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);
  const [loop, setLoop] = useAtom(loopAtom);
  const isSynthesizing = useAtomValue(isSynthesizingAtom);

  return (
    <Flex align="center" justify="center" gap="md" p="md">
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
  );
};
