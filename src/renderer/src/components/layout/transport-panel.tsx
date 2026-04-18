import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { Brush, Link2, Play, Repeat, Square } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { Tooltip } from "../tooltip";

const formatTime = (seconds: number): string => {
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.floor((seconds % 1) * 1000)
    .toString()
    .padStart(3, "0");
  return `${m}:${s}:${ms}`;
};

export const TransportPanel = memo(() => {
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const setLoop = useStore((state) => state.setLoop);
  const autoPlayStroke = useStore((state) => state.autoPlayStroke);
  const setAutoPlayStroke = useStore((state) => state.setAutoPlayStroke);
  const togglePlayback = useStore((state) => state.togglePlayback);
  const linkEnabled = useStore((state) => state.linkEnabled);
  const setLinkEnabled = useStore((state) => state.setLinkEnabled);
  const linkNumPeers = useStore((state) => state.linkNumPeers);
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
      if (timeRef.current) timeRef.current.innerText = formatTime(useStore.getState().getPlaybackTime());

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
        <Tooltip
          label={
            linkEnabled ? `Ableton Link (${linkNumPeers} peer${linkNumPeers !== 1 ? "s" : ""})` : "Enable Ableton Link"
          }
        >
          <ActionIcon onClick={() => setLinkEnabled(!linkEnabled)} size="lg" color={linkEnabled ? "orange" : "dark.5"}>
            <Link2 size={20} />
          </ActionIcon>
        </Tooltip>
        <ActionIcon onClick={togglePlayback} size="lg" ref={playButtonRef} color={isPlaying ? "orange" : "dark.5"}>
          {isPlaying ? <Square size={20} fill="white" /> : <Play size={20} fill="white" />}
        </ActionIcon>
        <ActionIcon onClick={() => setLoop(!loop)} size="lg" color={loop ? "orange" : "dark.5"}>
          <Repeat size={20} />
        </ActionIcon>
        <Tooltip label="Automatically play back the region you just painted after finishing a stroke">
          <ActionIcon
            onClick={() => setAutoPlayStroke(!autoPlayStroke)}
            size="lg"
            color={autoPlayStroke ? "orange" : "dark.5"}
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
