import { useStore } from "@/store";
import { Box, Divider, Group, Popover, Stack, Text } from "@mantine/core";
import { anchorProps } from "@renderer/lib/ui-anchors";
import {
  TRANSPORT_GAP,
  TRANSPORT_LABEL_WIDTH,
  TRANSPORT_PAD,
  TRANSPORT_TIME_WIDTH,
  useUiSize,
} from "@renderer/lib/ui-density";
import { Brush, CircleHelp, Link2, Play, Repeat, Square } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { HelpActionIcon } from "../controls/help-control";
import { ParameterControl } from "../controls/parameter-control";
import { OutputMeter } from "./output-meter";

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
      {...anchorProps("transport")}
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
              <HelpActionIcon
                help="transport-link"
                detail={
                  linkEnabled
                    ? `${linkNumPeers} peer${linkNumPeers !== 1 ? "s" : ""} — right-click for latency`
                    : "Right-click for latency"
                }
                onClick={() => setLinkEnabled(!linkEnabled)}
                size={uiSize}
                color={linkEnabled ? "orange" : "dark.5"}
              >
                <Link2 size={18} />
              </HelpActionIcon>
            </Box>
          </Popover.Target>
          <Popover.Dropdown p="xs" onClick={(e) => e.stopPropagation()}>
            <ParameterControl paramKey="linkLatencyMs" labelWidth={80} />
          </Popover.Dropdown>
        </Popover>
        <HelpActionIcon
          help="transport-play"
          onClick={togglePlayback}
          size={uiSize}
          ref={playButtonRef}
          color={isPlaying ? "orange" : "dark.5"}
        >
          {isPlaying ? <Square size={18} fill="white" /> : <Play size={18} fill="white" />}
        </HelpActionIcon>
        <HelpActionIcon
          help="transport-loop"
          onClick={() => setLoop(!loop)}
          size={uiSize}
          color={loop ? "orange" : "dark.5"}
        >
          <Repeat size={18} />
        </HelpActionIcon>
        <HelpActionIcon
          help="transport-audition"
          onClick={() => setAutoPlayStroke(!autoPlayStroke)}
          size={uiSize}
          color={autoPlayStroke ? "orange" : "dark.5"}
        >
          <Brush size={18} />
        </HelpActionIcon>
        <Text ff="monospace" size="lg" ref={timeRef} w={TRANSPORT_TIME_WIDTH}>
          {formatTime(0)}
        </Text>
        <OutputMeter />
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

      <Divider orientation="vertical" color="dark.5" />

      <Stack gap={0}>
        <ParameterControl paramKey="limiterEnabled" displayLabel="Auto-limit" />
        <ParameterControl paramKey="reanalyzeStrokes" displayLabel="Re-analyse" />
      </Stack>

      <Divider orientation="vertical" color="dark.5" />

      {/* The transport is the one bar that is always visible, whatever is open. */}
      <HelpActionIcon
        help="transport-help"
        {...anchorProps("transport-help")}
        // Kept from the document, so an open menu or popover never sees an
        // outside click and closes: asking what something is has to work while
        // the thing you are asking about is still on screen.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          useStore.getState().setHelpOverlayOpen(true);
        }}
        size={uiSize}
        variant="subtle"
        color="dark.2"
      >
        <CircleHelp size={18} />
      </HelpActionIcon>
    </Group>
  );
});

TransportPanel.displayName = "TransportPanel";
