import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { Brush, Play, Repeat, Square } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import * as Tone from "tone";
import { Tooltip } from "../tooltip";

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
  const autoPlaybackPaintedRegion = useStore((state) => state.autoPlaybackPaintedRegion);
  const setAutoPlaybackPaintedRegion = useStore((state) => state.setAutoPlaybackPaintedRegion);
  const togglePlayback = useStore((state) => state.togglePlayback);
  const timeRef = useRef<HTMLParagraphElement>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const animationFrameId = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
      return;
    }

    const updatePlaybackTime = () => {
      if (timeRef.current) timeRef.current.innerText = Tone.getTransport().position.toString();

      animationFrameId.current = requestAnimationFrame(updatePlaybackTime);
    };

    updatePlaybackTime();

    return () => {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
    };
  }, [isPlaying, loop]);

  return (
    <Group align="center" justify="center" gap="md" p="md" bg="dark.7" style={{ zIndex: 1000 }}>
      <Group w={300}>
        <ActionIcon onClick={togglePlayback} size="lg" ref={playButtonRef} color={isPlaying ? "orange" : "dark.5"}>
          {isPlaying ? <Square size={20} fill="white" /> : <Play size={20} fill="white" />}
        </ActionIcon>
        <ActionIcon onClick={() => setLoop(!loop)} size="lg" color={loop ? "orange" : "dark.5"}>
          <Repeat size={20} />
        </ActionIcon>
        <Tooltip label="Automatically play back the region you just painted after finishing a stroke">
          <ActionIcon
            onClick={() => setAutoPlaybackPaintedRegion(!autoPlaybackPaintedRegion)}
            size="lg"
            color={autoPlaybackPaintedRegion ? "orange" : "dark.5"}
          >
            <Brush size={20} />
          </ActionIcon>
        </Tooltip>
        <Text ff="monospace" size="xl" ref={timeRef}>
          {formatTime(0)}
        </Text>
      </Group>
    </Group>
  );
});

TransportPanel.displayName = "TransportPanel";
