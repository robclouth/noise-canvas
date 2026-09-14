import { ActionIcon, Group, Text } from "@mantine/core";
import { memo } from "react";
import { useStore } from "@/store";
import { helpProps } from "../lib/ui-controls";
import { useUiSize } from "../lib/ui-density";
import { Tooltip } from "./tooltip";

/** Per-layer mix controls that leave the selected painting layer unchanged. */
export const FileMixControls = memo(function FileMixControls({
  fileId,
  compact = false,
}: {
  fileId: string;
  compact?: boolean;
}) {
  const uiSize = useUiSize();
  const soloed = useStore((state) => state.filesSoloed[fileId] ?? false);
  const muted = useStore((state) => state.filesMuted[fileId] ?? false);
  return (
    <Group gap={compact ? 2 : "xs"} wrap="nowrap" style={{ flexShrink: 0 }}>
      {(
        [
          {
            letter: "S",
            label: "Solo",
            help: "file-solo",
            engaged: soloed,
            color: "yellow.5",
            toggle: () => useStore.getState().setFileSoloed(fileId, !soloed),
          },
          {
            letter: "M",
            label: "Mute",
            help: "file-mute",
            engaged: muted,
            color: "red.7",
            toggle: () => useStore.getState().setFileMuted(fileId, !muted),
          },
        ] as const
      ).map(({ letter, label, help, engaged, color, toggle }) => (
        <Tooltip key={help} help={help}>
          <ActionIcon
            {...helpProps(help)}
            size={compact ? "xs" : uiSize}
            color={engaged ? color : "dark.5"}
            aria-label={label}
            aria-pressed={engaged}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            <Text size="xs" fw={700} lh={1}>
              {letter}
            </Text>
          </ActionIcon>
        </Tooltip>
      ))}
    </Group>
  );
});
