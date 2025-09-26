import { togglePlayback } from "@/audio-manager";
import { useStore } from "@/store";
import { ActionIcon, Flex, Text } from "@mantine/core";
import { Play, Repeat, Square } from "lucide-react";
import { memo, useEffect, useRef } from "react";

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

export const TransportPanel = memo(() => {
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const setLoop = useStore((state) => state.setLoop);
  const timeRef = useRef<HTMLParagraphElement>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unsubTime = useStore.subscribe(
      (state) => state.playbackTime,
      (time) => {
        if (timeRef.current) timeRef.current.innerText = formatTime(time);
      },
    );
    const unsubSynth = useStore.subscribe(
      (state) => state.isSynthesizing,
      (isSynthesizing) => {
        if (playButtonRef.current) playButtonRef.current.disabled = isSynthesizing;
      },
    );
    return () => {
      unsubTime();
      unsubSynth();
    };
  }, []);

  return (
    <Flex align="center" justify="center" gap="md" p="md">
      <ActionIcon onClick={togglePlayback} size="lg" ref={playButtonRef}>
        {isPlaying ? <Square /> : <Play />}
      </ActionIcon>
      <ActionIcon onClick={() => setLoop(!loop)} size="lg" variant={loop ? "filled" : "outline"}>
        <Repeat />
      </ActionIcon>
      <Text ff="monospace" size="xl" ref={timeRef}>
        {formatTime(0)}
      </Text>
    </Flex>
  );
});

TransportPanel.displayName = "TransportPanel";
