import { useStore } from "@/store";
import { ActionIcon, Badge, Box, Button, Group, NumberInput } from "@mantine/core";
import { MiddleTruncate } from "@re-dev/react-truncate";
import { View } from "@react-three/drei";
import { openFiles } from "@renderer/store/files";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { memo, MouseEventHandler, useCallback, useMemo, useRef } from "react";
import { Vector2 } from "three";
import { getUndoManager } from "../lib/undo-manager";
import { screenToZoomed } from "../lib/utils";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";
import { PlaybackStartLine } from "./playback-start-line";
import { TimeLegend } from "./time-legend";
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
const TruncatedFilename = memo(({ filePath, isDirty }: { filePath: string; isDirty: boolean }) => {
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

TruncatedFilename.displayName = "TruncatedFilename";

export interface FileViewProps {
  fileId: string;
}

const viewStyle = { width: "100%", height: "100%", zIndex: 1 };

function getSnappedCoordinates(
  event: React.MouseEvent<HTMLDivElement>,
  fileId: string,
  bpm: number,
): [number, number] | null {
  const state = useStore.getState();
  const { gridSizeBeats, brushWidthBeats, gridSizeSemis, brushHeightSemis, bandsPerOctave } = state;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const screenUv = new Vector2(x, y);

  // Get per-file zoom and offset from store
  const { zoom, offset } = state.fileSettings[openFiles[fileId].filePath];

  // Convert from screen coordinates to zoomed coordinates
  const uv = screenToZoomed(screenUv, zoom, offset);

  const { spectrogramData } = openFiles[fileId];

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

const Header = memo(function Header({ fileId }: FileViewProps) {
  const file = openFiles[fileId];
  const setSourceFile = useStore((state) => state.setSourceFile);
  const bpm = useStore((state) => state.fileSettings[file.filePath].bpm ?? 120);
  const setFileBpm = useStore((state) => state.setFileBpm);
  const setFileZoom = useStore((state) => state.setFileZoom);
  const zoom = useStore((state) => state.fileSettings[file.filePath].zoom ?? 0);
  const closeFile = useStore((state) => state.closeFile);
  const sourceFile = useStore((state) => state.sourceFile);
  const resolution = useStore((state) => state.fileSettings[file.filePath].bandsPerOctave);
  const isDirty = useStore((state) => state.filesDirty[fileId] ?? false);

  const filePath = file?.filePath || "";

  const isSource = sourceFile?.id === fileId;
  const sourceMode = sourceFile?.mode ?? "current";

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFileZoom(fileId, zoom + 1);
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFileZoom(fileId, zoom - 1);
  };

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
        <Button.Group>
          <Tooltip label="Zoom out">
            <Button size="xs" variant="filled" color="dark.5" onClick={handleZoomOut} disabled={zoom <= 0} p={4}>
              <ZoomOut size={16} />
            </Button>
          </Tooltip>
          <Tooltip label="Zoom in">
            <Button size="xs" variant="filled" color="dark.5" onClick={handleZoomIn} disabled={zoom >= 10} p={4}>
              <ZoomIn size={16} />
            </Button>
          </Tooltip>
        </Button.Group>
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

export const FileView = memo(({ fileId }: FileViewProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath || "";
  console.log("FileView render", fileId, filePath);

  const activeFileId = useStore((state) => state.activeFileId);
  const isActive = activeFileId === fileId;
  const isSettingPosition = useStore((state) => state.isSettingPosition);
  const zoom = useStore((state) => state.fileSettings[file.filePath].zoom ?? 0);

  const cursorStyle = useMemo(() => ({ cursor: isSettingPosition ? "crosshair" : "crosshair" }), [isSettingPosition]);

  const rendererRef = useRef<FileRendererHandle>(null);
  const strokeTimeRangeRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null });

  const refCallback = useCallback(
    (handle: FileRendererHandle | null) => {
      rendererRef.current = handle;
      const file = openFiles[fileId];
      if (handle && file) {
        file.rendererRef = rendererRef;
      }
    },
    [fileId],
  );

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const uvToBeatsAndPitch = useCallback(
    (uvX: number, uvY: number) => {
      const state = useStore.getState();
      const { spectrogramData } = openFiles[fileId];
      const bpm = state.fileSettings[openFiles[fileId].filePath].bpm;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const brushWidthBeats = state.brushWidthBeats.value;
      const brushHeightSemis = state.brushHeightSemis.value;
      const timeSeconds = uvX * totalDuration;
      const centerBeats = (timeSeconds / 60) * bpm;
      const beats = brushWidthBeats > 0 ? centerBeats - brushWidthBeats / 2 : centerBeats;
      const bandIndex = (1 - uvY) * spectrogramData.numBands;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const centerPitch = bandIndex / bandsPerSemitone;
      const pitch = brushHeightSemis > 0 ? centerPitch - brushHeightSemis / 2 : centerPitch;
      return { beats, pitch };
    },
    [fileId],
  );

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const state = useStore.getState();
      const bpm = state.fileSettings[openFiles[fileId].filePath].bpm;
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      // If dragging, update the local ref with the total range of the stroke
      if (isActive && event.buttons === 1 && strokeTimeRangeRef.current.min !== null) {
        const { spectrogramData } = file;
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const brushWidthBeats = state.brushWidthBeats.value;
        const brushWidthSeconds = (brushWidthBeats / bpm) * 60;
        const brushHalfWidthSeconds = brushWidthSeconds / 2;

        const currentBrushStart = snappedX * totalDuration - brushHalfWidthSeconds;
        const currentBrushEnd = snappedX * totalDuration + brushHalfWidthSeconds;

        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min!, currentBrushStart);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushEnd);
      }

      if (
        rendererRef.current &&
        (!lastSnappedPositionRef.current ||
          lastSnappedPositionRef.current.x !== snappedX ||
          lastSnappedPositionRef.current.y !== snappedY)
      ) {
        state.setMousePos(new Vector2(snappedX, 1 - snappedY));
        state.setHoveredFile(fileId);
        const isPreview = !isActive || event.buttons !== 1;
        rendererRef.current.renderStroke(snappedX, snappedY, isPreview);
        lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
      }
    },
    [fileId, isActive, file],
  );

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const state = useStore.getState();
      const bpm = state.fileSettings[openFiles[fileId].filePath].bpm;
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      if (rendererRef.current) {
        state.setMousePos(new Vector2(snappedX, 1 - snappedY));
        state.setHoveredFile(fileId);
        const isPreview = !isActive || event.buttons !== 1;
        rendererRef.current.renderStroke(snappedX, snappedY, isPreview);
        lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
      }
    },
    [fileId, isActive],
  );

  const handleMouseLeave = useCallback(() => {
    const state = useStore.getState();
    state.setMousePos(null);
    state.setHoveredFile(null);
    rendererRef.current?.clearPreview();
    lastSnappedPositionRef.current = null;
  }, []);

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (event.button !== 0) return;

      const state = useStore.getState();
      const bpm = state.fileSettings[openFiles[fileId].filePath].bpm;
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;

      if (isSettingPosition) {
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        state.setSourcePosition({ beats, pitch, fileId });
        state.setIsSettingPosition(false);
        state.setSourceFile({ id: fileId, mode: state.sourceFile?.mode ?? "current" });
        return;
      }

      if (!isActive) {
        state.setActiveFileId(fileId);
      }

      if (rendererRef?.current) {
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        state.setBrushStartPosition({ beats, pitch });

        // Initialize the local stroke tracking ref on mouse down
        const { spectrogramData } = file;
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const brushWidthBeats = state.brushWidthBeats.value;
        const brushWidthSeconds = (brushWidthBeats / bpm) * 60;
        const brushHalfWidthSeconds = brushWidthSeconds / 2;
        const centerTimeSeconds = coords[0] * totalDuration;

        const initialBrushStart = centerTimeSeconds - brushHalfWidthSeconds;
        const initialBrushEnd = centerTimeSeconds + brushHalfWidthSeconds;
        strokeTimeRangeRef.current = { min: initialBrushStart, max: initialBrushEnd };

        if (state.sourcePositionMode.value === "offset" && !state.lockedOffset && state.sourcePosition) {
          const offsetBeats = state.sourcePosition.beats - beats;
          const offsetPitch = state.sourcePosition.pitch - pitch;
          state.setLockedOffset({ beats: offsetBeats, pitch: offsetPitch });
        }

        rendererRef.current.renderStroke(coords[0], coords[1], false);
      }
    },
    [fileId, isActive, isSettingPosition, uvToBeatsAndPitch, file],
  );

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (!isActive) return;
      if (event.button === 0 && rendererRef?.current) {
        const state = useStore.getState();
        const { synthesizeFile, setBrushStartPosition, autoPlayStroke, setFilePlaybackStartTime, setAutoPlayEndTime } =
          state;

        const data = await rendererRef.current.getFBOData();
        if (data) {
          const undoManager = getUndoManager(fileId);
          await undoManager.addState(data, fileId);

          const finalRange = strokeTimeRangeRef.current;
          let autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null = null;

          if (finalRange.min !== null && finalRange.max !== null) {
            const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
            // Clamp the final range to the audio duration
            const clampedStart = Math.max(0, finalRange.min);
            const clampedEnd = Math.min(totalDuration, finalRange.max);

            if (autoPlayStroke) {
              setFilePlaybackStartTime(fileId, clampedStart);
              setAutoPlayEndTime(clampedEnd);

              autoPlaybackParams = {
                startTimeSeconds: clampedStart,
                endTimeSeconds: clampedEnd,
              };
            }
          }

          await synthesizeFile(fileId, autoPlaybackParams);
        }

        setBrushStartPosition(null);
        // Reset the local ref for the next stroke.
        strokeTimeRangeRef.current = { min: null, max: null };
      }
    },
    [fileId, isActive, file],
  );

  if (!file) return null;

  return (
    <Box
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid transparent"}
      onClick={() => {
        if (!isActive) {
          useStore.getState().setActiveFileId(fileId);
        }
      }}
    >
      <Header fileId={fileId} />
      <Box
        h={400}
        style={cursorStyle}
        pos="relative"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      >
        <View style={viewStyle}>
          <FileRenderer fileId={fileId} ref={refCallback} />
        </View>
        {isActive && <PlaybackLine fileId={fileId} />}
        {isActive && <PlaybackStartLine fileId={fileId} />}
      </Box>
      <TimeLegend fileId={fileId} />
      <Box
        style={{
          width: "100%",
          height: 20,
          overflowX: "scroll",
          overflowY: "hidden",
        }}
        onScroll={(e) => {
          const target = e.currentTarget;
          const scrollWidth = target.scrollWidth - target.clientWidth;
          if (scrollWidth > 0) {
            const offset = target.scrollLeft / scrollWidth;
            useStore.getState().setFileOffset(fileId, offset);
          } else {
            useStore.getState().setFileOffset(fileId, 0);
          }
        }}
      >
        <Box
          h={1}
          style={{
            width: `${Math.max(100, Math.pow(2, zoom) * 100)}%`,
          }}
        />
      </Box>
    </Box>
  );
});

FileView.displayName = "FileView";
