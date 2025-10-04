import { openFiles, useStore } from "@/store";
import { ActionIcon, Badge, Box, Button, Group, NumberInput } from "@mantine/core";
import { MiddleTruncate } from "@re-dev/react-truncate";
import { View } from "@react-three/drei";
import { X } from "lucide-react";
import { memo, MouseEventHandler, useCallback, useMemo, useRef } from "react";
import { Vector2 } from "three";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";
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
const TruncatedFilename = memo(({ filePath }: { filePath: string }) => {
  const filename = filePath.split("/").pop() || filePath;

  return (
    <Box
      style={{
        minWidth: 0,
        width: "100%",
        fontSize: "var(--mantine-font-size-sm)",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <MiddleTruncate>{filename}</MiddleTruncate>
    </Box>
  );
});

TruncatedFilename.displayName = "TruncatedFilename";

export interface FileViewProps {
  filePath: string;
}

const viewStyle = { width: "100%", height: "100%", zIndex: 1 };

function getSnappedCoordinates(
  event: React.MouseEvent<HTMLDivElement>,
  filePath: string,
  bpm: number,
): [number, number] | null {
  const { gridSizeBeats, brushWidthBeats, gridSizeSemis, brushHeightSemis, bandsPerOctave } = useStore.getState();
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const uv = new Vector2(x, y);

  const { spectrogramData } = openFiles[filePath];

  let snappedX = uv.x;
  let snappedY = uv.y;

  if (gridSizeBeats.value > 0) {
    if (brushWidthBeats.value > 0) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const gridIntervalSeconds = (60 / bpm) * gridSizeBeats.value;
      const currentTime = uv.x * totalDuration;

      const brushWidthSeconds = brushWidthBeats.value * (60.0 / bpm);
      const startTime = currentTime - brushWidthSeconds / 2.0;

      const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
      const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

      snappedX = snappedCenterTime / totalDuration;
    } else {
      snappedX = 0.5;
    }
  }

  if (gridSizeSemis.value > 0) {
    if (brushHeightSemis.value > 0) {
      const bandsPerSemitone = bandsPerOctave.value / 12;
      const gridIntervalBands = gridSizeSemis.value * bandsPerSemitone;
      // Note: Band coordinates are inverted - band 0 is low frequency (bottom of screen at y=1)
      const currentBand = (1.0 - uv.y) * spectrogramData.numBands;

      const brushHeightBands = brushHeightSemis.value * bandsPerSemitone;
      const bottomBand = currentBand - brushHeightBands / 2.0;

      const snappedBottomBand = Math.round(bottomBand / gridIntervalBands) * gridIntervalBands;
      const snappedCenterBand = snappedBottomBand + brushHeightBands / 2.0;

      snappedY = 1.0 - snappedCenterBand / spectrogramData.numBands;
    } else {
      snappedY = 0.5;
    }
  }

  return [snappedX, snappedY];
}

const Header = memo(function Header({ filePath }: FileViewProps) {
  const setSourceFile = useStore((state) => state.setSourceFile);
  const bpm = useStore((state) => state.filesBpm[filePath] ?? 120);
  const setFileBpm = useStore((state) => state.setFileBpm);
  const closeFile = useStore((state) => state.closeFile);
  const sourceFile = useStore((state) => state.sourceFile);
  const resolution = useStore((state) => state.filesResolution[filePath]);

  const isSource = sourceFile?.path === filePath;
  const sourceMode = sourceFile?.mode ?? "current";

  return (
    <Group justify="space-between" align="center" p="xs" wrap="nowrap">
      <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Tooltip label={filePath}>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <TruncatedFilename filePath={filePath} />
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
            onChange={(val) => setFileBpm(filePath, Number(val))}
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
                setSourceFile({ path: filePath, mode: "current" });
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
                setSourceFile({ path: filePath, mode: "original" });
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
            closeFile(filePath);
          }}
        >
          <X />
        </ActionIcon>
      </Group>
    </Group>
  );
});

export const FileView = memo(({ filePath }: FileViewProps) => {
  console.log("FileView render", filePath);

  const activeFilePath = useStore((state) => state.activeFilePath);
  const isActive = activeFilePath === filePath;
  const isSettingPosition = useStore((state) => state.isSettingPosition);

  const cursorStyle = useMemo(() => ({ cursor: isSettingPosition ? "crosshair" : "none" }), [isSettingPosition]);

  const rendererRef = useRef<FileRendererHandle>(null);

  const refCallback = useCallback(
    (handle: FileRendererHandle | null) => {
      rendererRef.current = handle;
      const file = openFiles[filePath];
      if (handle && file) {
        file.rendererRef = rendererRef;
      }
    },
    [filePath],
  );

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  // Helper to convert UV coordinates to beats and pitch
  // Position is relative to bottom-left corner of brush
  const uvToBeatsAndPitch = useCallback(
    (uvX: number, uvY: number) => {
      const state = useStore.getState();
      const { spectrogramData } = openFiles[filePath];
      const bpm = state.filesBpm[filePath] ?? 120;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      // Get brush size to calculate bottom-left corner
      const brushWidthBeats = state.brushWidthBeats.value;
      const brushHeightSemis = state.brushHeightSemis.value;

      // Convert UV to time in seconds, then to beats
      const timeSeconds = uvX * totalDuration;
      const centerBeats = (timeSeconds / 60) * bpm;

      // Adjust to bottom-left corner (subtract half width)
      const beats = brushWidthBeats > 0 ? centerBeats - brushWidthBeats / 2 : centerBeats;

      // Convert UV to band index, then to semitones
      // UV y=0 is top (high pitch), y=1 is bottom (low pitch)
      const bandIndex = (1 - uvY) * spectrogramData.numBands;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const centerPitch = bandIndex / bandsPerSemitone;

      // Adjust to bottom-left corner (subtract half height)
      const pitch = brushHeightSemis > 0 ? centerPitch - brushHeightSemis / 2 : centerPitch;

      return { beats, pitch };
    },
    [filePath],
  );

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    // Allow mouse position tracking on all files (for setting position and preview)
    const bpm = useStore.getState().filesBpm[filePath] ?? 120;
    const coords = getSnappedCoordinates(event, filePath, bpm);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    if (
      rendererRef.current &&
      (!lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY)
    ) {
      const state = useStore.getState();
      state.setMousePos(new Vector2(snappedX, 1 - snappedY));
      state.setHoveredFilePath(filePath); // Track which file is being hovered
      // Render stroke preview on all files, but only actual strokes on active file
      const isPreview = !isActive || event.buttons !== 1;
      rendererRef.current.renderStroke(snappedX, snappedY, isPreview);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleMouseLeave = () => {
    const state = useStore.getState();
    state.setMousePos(null);
    state.setHoveredFilePath(null);
    rendererRef.current?.clearPreview();
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0) return;

    const bpm = useStore.getState().filesBpm[filePath] ?? 120;
    const coords = getSnappedCoordinates(event, filePath, bpm);
    if (!coords) return;

    // If in set position mode, capture the position and set source file
    if (isSettingPosition) {
      const state = useStore.getState();
      const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
      state.setSourcePosition({ beats, pitch, filePath });
      state.setIsSettingPosition(false);

      // Set this file as the source file (in "current" mode)
      state.setSourceFile({ path: filePath, mode: "current" });
      return;
    }

    // Make this the active file if it isn't already
    const state = useStore.getState();
    if (!isActive) {
      state.setActiveFilePath(filePath);
    }

    // Normal painting behavior
    if (rendererRef?.current) {
      // Record the start position of this stroke
      const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
      state.setBrushStartPosition({ beats, pitch });

      // In Offset mode, lock the offset on first stroke
      if (state.sourcePositionMode.value === "offset" && !state.lockedOffset && state.sourcePosition) {
        const offsetBeats = state.sourcePosition.beats - beats;
        const offsetPitch = state.sourcePosition.pitch - pitch;
        state.setLockedOffset({ beats: offsetBeats, pitch: offsetPitch });
      }

      rendererRef.current.renderStroke(coords[0], coords[1], false);
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = async (event) => {
    if (!isActive) return;
    if (event.button === 0 && rendererRef?.current) {
      // Clear brush start position when stroke ends
      useStore.getState().setBrushStartPosition(null);

      // Left mouse button up
      const data = await rendererRef.current.getFBOData();
      if (data) {
        window.api.addUndoState({
          data: data.buffer,
          filePath,
        });
      }
    }
  };

  return (
    <Box
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid transparent"}
      onClick={() => {
        if (!isActive) {
          useStore.getState().setActiveFilePath(filePath);
        }
      }}
    >
      <Header filePath={filePath} />
      <Box
        h={400}
        style={cursorStyle}
        pos="relative"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      >
        <View style={viewStyle}>
          <FileRenderer filePath={filePath} ref={refCallback} />
        </View>
      </Box>

      {isActive && <PlaybackLine filePath={filePath} />}
    </Box>
  );
});

FileView.displayName = "FileView";
