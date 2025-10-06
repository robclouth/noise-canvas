import { togglePlayback } from "@/audio-manager";
import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
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

    return () => {
      unsubTime();
    };
  }, []);

  return (
    <Group align="center" justify="center" gap="md" p="md" bg="dark.7" style={{ zIndex: 1000 }}>
      <ActionIcon onClick={togglePlayback} size="lg" ref={playButtonRef}>
        {isPlaying ? <Square /> : <Play />}
      </ActionIcon>
      <ActionIcon onClick={() => setLoop(!loop)} size="lg" variant={loop ? "filled" : "outline"}>
        <Repeat />
      </ActionIcon>
      <Text ff="monospace" size="xl" ref={timeRef}>
        {formatTime(0)}
      </Text>
    </Group>
  );
});

TransportPanel.displayName = "TransportPanel";
