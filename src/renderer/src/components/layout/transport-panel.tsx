import { useStore } from "@/store";
import { ActionIcon, Box, Divider, Group, Popover, Stack, Text } from "@mantine/core";
import {
  TRANSPORT_GAP,
  TRANSPORT_LABEL_WIDTH,
  TRANSPORT_PAD,
  TRANSPORT_TIME_WIDTH,
  useUiSize,
} from "@renderer/lib/ui-density";
import { Brush, Link2, Play, Repeat, Square } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { ParameterControl } from "../controls/parameter-control";
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
  const [linkPopoverOpened, setLinkPopoverOpened] = useState(false);
  const uiSize = useUiSize();

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
    <Group
      align="center"
      justify="center"
      gap={TRANSPORT_GAP}
      p={TRANSPORT_PAD}
      bg="dark.7"
      wrap="nowrap"
      style={{ zIndex: 1000 }}
    >
      <Group gap="xs" wrap="nowrap">
        <Popover
          opened={linkPopoverOpened}
          onChange={setLinkPopoverOpened}
          withArrow
          withinPortal={false}
          zIndex={10001}
          position="top"
          clickOutsideEvents={["click", "mousedown", "touchstart"]}
        >
          <Popover.Target>
            <Box
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLinkPopoverOpened((o) => !o);
              }}
              style={{ display: "inline-flex" }}
            >
              <Tooltip
                label={
                  linkEnabled
                    ? `Ableton Link (${linkNumPeers} peer${linkNumPeers !== 1 ? "s" : ""}) — right-click for latency`
                    : "Enable Ableton Link — right-click for latency"
                }
              >
                <ActionIcon
                  onClick={() => setLinkEnabled(!linkEnabled)}
                  size={uiSize}
                  color={linkEnabled ? "orange" : "dark.5"}
                >
                  <Link2 size={18} />
                </ActionIcon>
              </Tooltip>
            </Box>
          </Popover.Target>
          <Popover.Dropdown p="xs" onClick={(e) => e.stopPropagation()}>
            <ParameterControl paramKey="linkLatencyMs" labelWidth={80} />
          </Popover.Dropdown>
        </Popover>
        <ActionIcon onClick={togglePlayback} size={uiSize} ref={playButtonRef} color={isPlaying ? "orange" : "dark.5"}>
          {isPlaying ? <Square size={18} fill="white" /> : <Play size={18} fill="white" />}
        </ActionIcon>
        <ActionIcon onClick={() => setLoop(!loop)} size={uiSize} color={loop ? "orange" : "dark.5"}>
          <Repeat size={18} />
        </ActionIcon>
        <Tooltip label="Automatically play back the region you just painted after finishing a stroke">
          <ActionIcon
            onClick={() => setAutoPlayStroke(!autoPlayStroke)}
            size={uiSize}
            color={autoPlayStroke ? "orange" : "dark.5"}
          >
            <Brush size={18} />
          </ActionIcon>
        </Tooltip>
        <Text ff="monospace" size="lg" ref={timeRef} w={TRANSPORT_TIME_WIDTH}>
          {formatTime(0)}
        </Text>
      </Group>

      <Divider orientation="vertical" color="dark.5" />

      <Stack gap={0}>
        <ParameterControl paramKey="gridSizeBeats" labelWidth={TRANSPORT_LABEL_WIDTH} />
        <ParameterControl paramKey="snapTime" labelWidth={TRANSPORT_LABEL_WIDTH} displayLabel="Snap" />
      </Stack>

      <Stack gap={0}>
        <ParameterControl paramKey="gridSizeSemis" labelWidth={TRANSPORT_LABEL_WIDTH} />
        <ParameterControl paramKey="snapPitch" labelWidth={TRANSPORT_LABEL_WIDTH} displayLabel="Snap" />
      </Stack>

      <Stack gap={0}>
        <ParameterControl paramKey="gridSwing" labelWidth={TRANSPORT_LABEL_WIDTH} />
      </Stack>

      <Divider orientation="vertical" color="dark.5" />

      <Stack gap={0}>
        <ParameterControl paramKey="scaleTonic" labelWidth={TRANSPORT_LABEL_WIDTH} />
        <ParameterControl paramKey="scaleType" labelWidth={TRANSPORT_LABEL_WIDTH} />
      </Stack>
    </Group>
  );
});

TransportPanel.displayName = "TransportPanel";
