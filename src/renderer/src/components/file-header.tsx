import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Group, Menu, Text } from "@mantine/core";
import { HelpActionIcon } from "@renderer/components/controls/help-control";
import { NumboxControl } from "@renderer/components/controls/numbox-control";
import { BANDS_PER_OCTAVE_VALUES, DEFAULT_ONSET_SENSITIVITY } from "@renderer/lib/constants";
import { openSplitPartsPrompt } from "@renderer/lib/modals";
import { anchorProps } from "@renderer/lib/ui-anchors";
import { helpProps, type UiControlName } from "@renderer/lib/ui-controls";
import { FILE_HEADER_FONT, FILE_HEADER_PAD, useUiSize } from "@renderer/lib/ui-density";
import { getHistoryManager } from "@renderer/lib/history-manager";
import { openFiles, selectFileColor } from "@renderer/store/files";
import { isManagedFilePath } from "@renderer/store/utils";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { ChevronDown, Copy, Grid3x3, Maximize2, Minimize2, Split, X } from "lucide-react";
import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { host } from "../lib/host";
import { Tooltip } from "./tooltip";

// ONNX Runtime has no macOS x86_64 build past 1.23, so the separation addon is
// not compiled for Intel Macs, and the extension host does not implement it.
// Either way it would download the model and then fail, so the menu item is
// hidden entirely.
const AI_SEPARATION_SUPPORTED = !host.env.isExtension && !(host.env.platform === "darwin" && host.env.arch === "x64");

// Changing the channel count analyses a rendered audio buffer, which the
// extension host has no entry point for, so there the badge only reports.
const CHANNEL_CHANGE_SUPPORTED = !host.env.isExtension;

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

const CHANNEL_OPTIONS = [
  { value: 1, label: "Mono" },
  { value: 2, label: "Stereo" },
];

/** What this file's own channel count means, under the shared sentence about the badge. */
function getChannelDetail(channelCount: number): string {
  return channelCount === 1
    ? "One channel — stereo effects have nothing to work across."
    : "Two channels, left and right.";
}

/**
 * This file's channel count, read from the analysis itself so it follows every
 * re-analysis and every move through history.
 */
function useFileChannelCount(fileId: string): number | undefined {
  const manager = useMemo(() => getHistoryManager(fileId), [fileId]);
  useSyncExternalStore(
    useCallback((onChange: () => void) => manager.subscribe(onChange), [manager]),
    useCallback(() => manager.getVersion(), [manager]),
  );
  // A file being analysed has no spectrogram to read yet; clearing its loading
  // message is the render that first has one.
  useStore((state) => state.filesLoading[fileId]);
  return openFiles[fileId]?.spectrogramData?.numChannels;
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
  const fileColor = useStore((state) => selectFileColor(state, fileId));
  const channelCount = useFileChannelCount(fileId);

  const isFullscreen = fullscreenFileId === fileId;
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
          <Menu position="bottom-start" withinPortal>
            <Tooltip help="file-resolution" detail={getResolutionDetail(bandsPerOctave)}>
              <Menu.Target>
                <Badge
                  {...helpProps("file-resolution")}
                  size="sm"
                  variant="light"
                  color="orange"
                  rightSection={<ChevronDown size={10} />}
                  style={{ flexShrink: 0, cursor: "pointer" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {getResolutionLabel(bandsPerOctave)}
                </Badge>
              </Menu.Target>
            </Tooltip>
            <Menu.Dropdown>
              {BANDS_PER_OCTAVE_VALUES.map((option) => (
                <Menu.Item
                  key={option.value}
                  fw={option.value === bandsPerOctave ? 700 : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (option.value === bandsPerOctave) return;
                    void useStore.getState().reanalyzeFile(fileId, option.value);
                  }}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
        {channelCount !== undefined &&
          (CHANNEL_CHANGE_SUPPORTED ? (
            <Menu position="bottom-start" withinPortal>
              <Tooltip help="file-channels" detail={getChannelDetail(channelCount)}>
                <Menu.Target>
                  <Badge
                    {...helpProps("file-channels")}
                    size="sm"
                    variant="light"
                    color="teal"
                    rightSection={<ChevronDown size={10} />}
                    style={{ flexShrink: 0, cursor: "pointer" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {channelCount === 1 ? "Mono" : "Stereo"}
                  </Badge>
                </Menu.Target>
              </Tooltip>
              <Menu.Dropdown>
                {CHANNEL_OPTIONS.map((option) => (
                  <Menu.Item
                    key={option.value}
                    fw={option.value === channelCount ? 700 : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (option.value === channelCount) return;
                      void useStore.getState().setFileChannelCount(fileId, option.value);
                    }}
                  >
                    {option.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          ) : (
            <Tooltip help="file-channels" detail={getChannelDetail(channelCount)}>
              <Badge {...helpProps("file-channels")} size="sm" variant="light" color="teal" style={{ flexShrink: 0 }}>
                {channelCount === 1 ? "Mono" : "Stereo"}
              </Badge>
            </Tooltip>
          ))}
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
          help="file-fill-grid"
          {...anchorProps("file-fill-grid")}
          size={uiSize}
          color="dark.5"
          onClick={(e) => {
            e.stopPropagation();
            void useStore
              .getState()
              .setActiveFileId(fileId)
              .then(() => useStore.getState().fillGrid());
          }}
        >
          <Grid3x3 size={16} />
        </HelpActionIcon>
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
