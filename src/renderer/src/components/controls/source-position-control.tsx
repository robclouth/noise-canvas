import { formatBeats } from "@/lib/utils";
import { useStore } from "@/store";
import { Button, Group, Stack } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { X } from "lucide-react";
import { ParameterControl } from "./parameter-control";

export function SourcePositionControl() {
  const sourcePosition = useStore((state) => state.sourcePosition);
  const isSettingPosition = useStore((state) => state.isSettingPosition);
  const setIsSettingPosition = useStore((state) => state.setIsSettingPosition);
  const mode = useStore((state) => state.sourcePositionMode);
  const lockedOffset = useStore((state) => state.lockedOffset);

  // Format position or offset for display
  const formatDisplay = () => {
    // In offset mode with locked offset, show the offset
    if (mode === "offset" && lockedOffset) {
      const beatsStr = formatBeats(lockedOffset.beats, true);
      const pitch = Math.round(lockedOffset.pitch);
      const pitchStr = lockedOffset.pitch >= 0 ? `+${pitch}` : `${pitch}`;
      return `${beatsStr}, ${pitchStr}`;
    }

    // Otherwise show position
    if (!sourcePosition) {
      return null;
    }

    const file = openFiles[sourcePosition.fileId];
    if (!file) {
      return null;
    }

    const beatsStr = formatBeats(sourcePosition.beats, false);
    const pitch = Math.round(sourcePosition.pitch);

    return `${beatsStr} beats, ${pitch} semis`;
  };

  const displayLabel = formatDisplay();
  const hasPosition = !!sourcePosition;

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="nowrap">
        <Button
          size="xs"
          fullWidth
          justify="space-between"
          variant={hasPosition || isSettingPosition ? "outline" : "filled"}
          color={hasPosition || isSettingPosition ? "dark.0" : "dark.5"}
          onClick={() => {
            if (!isSettingPosition) {
              setIsSettingPosition(true);
            } else {
              setIsSettingPosition(false);
            }
          }}
          leftSection={<span />}
          rightSection={
            hasPosition && !isSettingPosition ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().setSourcePosition(null);
                  useStore.getState().setLockedOffset(null);
                }}
                style={{
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  opacity: 0.6,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = "0.6";
                }}
              >
                <X size={12} />
              </span>
            ) : (
              <span />
            )
          }
        >
          {isSettingPosition ? "Setting..." : displayLabel || "Set Position"}
        </Button>
      </Group>
      <ParameterControl paramKey="sourcePositionMode" />
    </Stack>
  );
}
