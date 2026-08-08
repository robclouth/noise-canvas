import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Group, Menu, NumberInput } from "@mantine/core";
import { openSplitPartsPrompt } from "@renderer/lib/modals";
import { FILE_HEADER_FONT, FILE_HEADER_PAD, useUiSize } from "@renderer/lib/ui-density";
import { getFileColor, openFiles } from "@renderer/store/files";
import { selectStemGroupOfFile, stemMemberColor } from "@renderer/store/stem-groups";
import { isManagedFilePath } from "@renderer/store/utils";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { ChevronDown, Copy, Maximize2, Minimize2, Split, X } from "lucide-react";
import { memo } from "react";
import { host } from "../lib/host";
import { Tooltip } from "./tooltip";

// The ONNX-backed AI separation addon is only compiled on macOS, so the feature
// is offered there only. On other platforms it would download the model and
// then fail, so the menu item is hidden entirely.
const AI_SEPARATION_SUPPORTED = host.env.platform === "darwin";

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
  displayName,
  isDirty,
}: {
  displayName: string;
  isDirty: boolean;
}) {
  return (
    <Box
      style={{
        minWidth: 0,
        width: "100%",
        fontSize: FILE_HEADER_FONT,
        fontStyle: isDirty ? "italic" : "normal",
        whiteSpace: "nowrap",
      }}
    >
      {truncateMiddle(displayName, 50)}
    </Box>
  );
});

export default memo(function FileHeader({ fileId }: { fileId: string }) {
  const uiSize = useUiSize();
  const file = openFiles[fileId];
  const filePath = file.filePath;
  const displayName = file.displayName;
  const bpm = useStore((state) => state.filepathsBpm[filePath]);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const bandsPerOctave = useStore((state) => state.filesBandsPerOctave[fileId]);
  const isDirty = useStore((state) => state.filesDirty[fileId] ?? false);
  const isHighlighted = useStore((state) => state.highlightedSourcePath === filePath);
  const stemGroup = useStore((state) => selectStemGroupOfFile(state, fileId));

  const isFullscreen = fullscreenFileId === fileId;
  // A stem wears a shade of its group's hue instead of its own path hash, so a
  // split reads as one unit rather than as unrelated files.
  const stemIndex = stemGroup ? stemGroup.memberIds.indexOf(fileId) : -1;
  const fileColor = stemGroup
    ? stemMemberColor(stemGroup.hue, stemIndex, stemGroup.memberIds.length)
    : getFileColor(filePath);
  // Tooltip shows full path for real files (helpful when basenames truncate);
  // for managed files the path is the opaque sentinel, so just show the label.
  const tooltipLabel = isManagedFilePath(filePath) ? displayName : filePath;

  return (
    <Group
      justify="space-between"
      align="center"
      p={FILE_HEADER_PAD}
      wrap="nowrap"
      bg={isHighlighted ? "dark.6" : "dark.7"}
      style={{
        borderLeft: `3px solid ${fileColor}`,
        ...(isHighlighted ? { outline: "1px solid var(--mantine-color-blue-6)" } : {}),
      }}
    >
      <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Tooltip label={tooltipLabel}>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <TruncatedFilename displayName={displayName} isDirty={isDirty} />
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
              <ActionIcon size={uiSize} color="dark.5" onClick={(e) => e.stopPropagation()}>
                <Split size={16} />
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
            <Menu.Divider />
            <Menu.Item
              onClick={(e) => {
                e.stopPropagation();
                openSplitPartsPrompt({
                  onConfirm: (parts) => {
                    useStore.getState().nmfFile(fileId, parts);
                  },
                });
              }}
            >
              Split into N Parts (NMF)…
            </Menu.Item>
            {AI_SEPARATION_SUPPORTED && (
              <>
                <Menu.Divider />
                <Menu.Item
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().aiSeparateFile(fileId);
                  }}
                >
                  Split Drums / Bass / Other / Vocals (AI)
                </Menu.Item>
              </>
            )}
          </Menu.Dropdown>
        </Menu>
        <Tooltip label="Duplicate this file to create an editable copy.">
          <ActionIcon
            size={uiSize}
            color="dark.5"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().duplicateFile(fileId);
            }}
          >
            <Copy size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Minimize to palette bar">
          <ActionIcon
            size={uiSize}
            color="dark.5"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().setFileMinimized(fileId, true);
            }}
          >
            <ChevronDown size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={isFullscreen ? "Exit fullscreen" : "Expand this file to fill the canvas area."}>
          <ActionIcon
            size={uiSize}
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
            size={uiSize}
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
