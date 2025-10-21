import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Button, Group, NumberInput } from "@mantine/core";
import { MiddleTruncate } from "@re-dev/react-truncate";
import { openFiles } from "@renderer/store/files";
import { X } from "lucide-react";
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
      <MiddleTruncate>{filename}</MiddleTruncate>
    </Box>
  );
});

export default memo(function FileHeader({ fileId }: { fileId: string }) {
  const file = openFiles[fileId];
  const setSourceFile = useStore((state) => state.setSourceFile);
  const bpm = useStore((state) => state.getFileSettings(fileId)?.bpm);
  const setFileBpm = useStore((state) => state.setFileBpm);
  const closeFile = useStore((state) => state.closeFile);
  const sourceFile = useStore((state) => state.sourceFile);
  const resolution = useStore((state) => state.getFileSettings(fileId)?.bandsPerOctave);
  const isDirty = useStore((state) => state.filesDirty[fileId] ?? false);

  const filePath = file?.filePath || "";

  const isSource = sourceFile?.id === fileId;
  const sourceMode = sourceFile?.mode ?? "current";

  return (
    <Group justify="space-between" align="center" p="xs" wrap="nowrap" bg="dark.7">
      <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Tooltip label={filePath}>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <TruncatedFilename filePath={filePath} isDirty={isDirty} />
          </Box>
        </Tooltip>
        {resolution && (
          <Badge size="sm" variant="light" color="orange" style={{ flexShrink: 0 }}>
            {getResolutionLabel(resolution)}
          </Badge>
        )}
      </Group>
      <Group align="center" gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Tooltip label="The tempo of this file in beats per minute (BPM). Used for grid snapping and time-based effects.">
          <NumberInput
            w={60}
            value={bpm}
            onChange={(val) => setFileBpm(fileId, Number(val))}
            size="xs"
            max={999}
            min={10}
          />
        </Tooltip>
        <Button.Group>
          <Tooltip label="Use this file's current (modified) state as the source for painting onto other files.">
            <Button
              size="xs"
              variant="filled"
              onClick={(e) => {
                e.stopPropagation();
                setSourceFile({ id: fileId, mode: "current" });
              }}
              color={isSource && sourceMode === "current" ? "orange" : "dark.5"}
            >
              Current
            </Button>
          </Tooltip>
          <Tooltip label="Use this file's original (unmodified) state as the source for painting onto other files.">
            <Button
              size="xs"
              variant="filled"
              onClick={(e) => {
                e.stopPropagation();
                setSourceFile({ id: fileId, mode: "original" });
              }}
              color={isSource && sourceMode === "original" ? "orange" : "dark.5"}
            >
              Original
            </Button>
          </Tooltip>
        </Button.Group>
        <ActionIcon
          variant="transparent"
          color="white"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            closeFile(fileId);
          }}
        >
          <X />
        </ActionIcon>
      </Group>
    </Group>
  );
});
