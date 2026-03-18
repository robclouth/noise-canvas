import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Group, Menu, NumberInput } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { Copy, Maximize2, Minimize2, Pipette, Scissors, X } from "lucide-react";
import { memo } from "react";
import { Tooltip } from "./tooltip";

// Helper to get resolution label from bands per octave value
function getResolutionLabel(bpo: number): string {
  switch (bpo) {
    case 12:
      return "Best Time";
    case 24:
      return "Better Time";
    case 36:
      return "Balanced";
    case 48:
      return "Better Pitch";
    case 60:
      return "Best Pitch";
    default:
      return `${bpo} BPO`;
  }
}

// Component to display filename with middle truncation
const TruncatedFilename = memo(function TruncatedFilename({
  filePath,
  isDirty,
}: {
  filePath: string;
  isDirty: boolean;
}) {
  const filename = filePath.split("/").pop() || filePath;

  return (
    <Box
      style={{
        minWidth: 0,
        width: "100%",
        fontSize: 13,
        fontStyle: isDirty ? "italic" : "normal",
        whiteSpace: "nowrap",
      }}
    >
      {truncateMiddle(filename, 50)}
    </Box>
  );
});

export default memo(function FileHeader({ fileId }: { fileId: string }) {
  const file = openFiles[fileId];
  const filePath = file.filePath;
  const bpm = useStore((state) => state.filepathsBpm[filePath]);
  const sourceFile = useStore((state) => state.sourceFile);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const bandsPerOctave = useStore((state) => state.filesBandsPerOctave[fileId]);
  const isDirty = useStore((state) => state.filesDirty[fileId] ?? false);

  const isSource = sourceFile === fileId;
  const isFullscreen = fullscreenFileId === fileId;

  return (
    <Group justify="space-between" align="center" p="xs" wrap="nowrap" bg="dark.7">
      <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Tooltip label={filePath}>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <TruncatedFilename filePath={filePath} isDirty={isDirty} />
          </Box>
        </Tooltip>
        {bandsPerOctave && (
          <Badge size="sm" variant="light" color="orange" style={{ flexShrink: 0 }}>
            {getResolutionLabel(bandsPerOctave)}
          </Badge>
        )}
      </Group>
      <Group align="center" gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Tooltip label="The tempo of this file in beats per minute (BPM). Used for grid snapping and time-based effects.">
          <NumberInput
            w={60}
            value={bpm}
            onChange={(val) => useStore.getState().setFilepathBpm(filePath, Number(val))}
            size="xs"
            max={999}
            min={10}
          />
        </Tooltip>
        <Menu position="bottom-end" withinPortal>
          <Tooltip label="Split this file into separate components.">
            <Menu.Target>
              <ActionIcon color="dark.5" onClick={(e) => e.stopPropagation()}>
                <Scissors size={16} />
              </ActionIcon>
            </Menu.Target>
          </Tooltip>
          <Menu.Dropdown>
            <Menu.Item
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().hpssFile(fileId);
              }}
            >
              Split Harmonic and Percussive (HPSS)
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip label="Duplicate this file to create an editable copy.">
          <ActionIcon
            color="dark.5"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().duplicateFile(fileId);
            }}
          >
            <Copy size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Use this file as the source for painting onto other files. Use the Source Data Mode in the brush panel to choose between current (modified) and original (unmodified) data.">
          <ActionIcon
            color={isSource ? "orange" : "dark.5"}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().setSourceFile(fileId);
            }}
          >
            <Pipette size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={isFullscreen ? "Exit fullscreen" : "Expand this file to fill the canvas area."}>
          <ActionIcon
            color={isFullscreen ? "orange" : "dark.5"}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().setFullscreenFileId(isFullscreen ? null : fileId);
            }}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Close this file.">
          <ActionIcon
            color="dark.5"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().tryCloseFile(fileId);
            }}
          >
            <X size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
});
