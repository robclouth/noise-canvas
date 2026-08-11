import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Group, Menu, Text } from "@mantine/core";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { NumboxControl } from "@renderer/components/controls/numbox-control";
import { DEFAULT_ONSET_SENSITIVITY } from "@renderer/lib/constants";
import { openSplitPartsPrompt } from "@renderer/lib/modals";
import { anchorProps } from "@renderer/lib/ui-anchors";
import { helpProps, type UiControlName } from "@renderer/lib/ui-controls";
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

/** What this file's own setting does, under the shared sentence about the badge. */
function getResolutionDetail(bpo: number): string {
  switch (bpo) {
    case 12:
      return "12 bands/octave — sharpest transients, coarsest pitch.";
    case 24:
      return "24 bands/octave — leans toward time, still separates notes.";
    case 36:
      return "36 bands/octave — the default, favouring neither.";
    case 48:
      return "48 bands/octave — leans toward pitch, at some cost to attacks.";
    case 60:
      return "60 bands/octave — finest pitch, softest transients.";
    default:
      return `${bpo} bands/octave.`;
  }
}

// A per-file value in the header, presented as the same label + draggable
// numbox as every other parameter. These values live per file path rather than
// on the store's parameter map, so they carry their own label instead of going
// through ParameterControl.
function FileHeaderNumbox({
  label,
  help,
  value,
  setValue,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  help: UiControlName;
  value: number;
  setValue: (value: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
}) {
  const labelComponent = (
    <Tooltip help={help}>
      <Text size="xs" ta="right" c="dark.0" style={{ whiteSpace: "nowrap" }} {...helpProps(help)}>
        {label}
      </Text>
    </Tooltip>
  );
  return (
    <NumboxControl
      labelComponent={labelComponent}
      value={value}
      setValue={setValue}
      min={min}
      max={max}
      step={step}
      unit={unit}
      toNormalized={(v) => (v - min) / (max - min)}
      fromNormalized={(v) => min + v * (max - min)}
    />
  );
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
  const onsetSensitivity = useStore((state) => state.filepathsOnsetSensitivity[filePath] ?? DEFAULT_ONSET_SENSITIVITY);
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
      {...anchorProps("file-header")}
    >
      <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Tooltip label={tooltipLabel}>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <TruncatedFilename displayName={displayName} isDirty={isDirty} />
          </Box>
        </Tooltip>
        {bandsPerOctave && (
          <Tooltip help="file-resolution" detail={getResolutionDetail(bandsPerOctave)}>
            <Badge {...helpProps("file-resolution")} size="sm" variant="light" color="orange" style={{ flexShrink: 0 }}>
              {getResolutionLabel(bandsPerOctave)}
            </Badge>
          </Tooltip>
        )}
      </Group>
      <Group align="center" gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        <FileHeaderNumbox
          label="Onsets"
          help="file-onsets"
          value={onsetSensitivity}
          setValue={(v) => useStore.getState().setFilepathOnsetSensitivity(filePath, v)}
          min={0}
          max={100}
          step={1}
          unit="%"
        />
        <FileHeaderNumbox
          label="BPM"
          help="file-bpm"
          value={bpm ?? 120}
          setValue={(v) => useStore.getState().setFilepathBpm(filePath, v)}
          min={10}
          max={999}
          step={1}
        />
        <Menu position="bottom-end" withinPortal>
          <Tooltip help="file-split">
            <Menu.Target>
              <ActionIcon
                size={uiSize}
                color="dark.5"
                onClick={(e) => e.stopPropagation()}
                {...helpProps("file-split")}
              >
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
        <HelpActionIcon
          help="file-duplicate"
          size={uiSize}
          color="dark.5"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().duplicateFile(fileId);
          }}
        >
          <Copy size={16} />
        </HelpActionIcon>
        <HelpActionIcon
          help="file-minimize"
          size={uiSize}
          color="dark.5"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().setFileMinimized(fileId, true);
          }}
        >
          <ChevronDown size={16} />
        </HelpActionIcon>
        <HelpActionIcon
          help="file-fullscreen"
          detail={isFullscreen ? "Exit fullscreen" : "Expand"}
          size={uiSize}
          color={isFullscreen ? "orange" : "dark.5"}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().setFullscreenFileId(isFullscreen ? null : fileId);
          }}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </HelpActionIcon>
        <HelpActionIcon
          help="file-close"
          size={uiSize}
          color="dark.5"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().tryCloseFile(fileId);
          }}
        >
          <X size={16} />
        </HelpActionIcon>
      </Group>
    </Group>
  );
});
