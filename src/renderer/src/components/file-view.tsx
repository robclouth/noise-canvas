import { useStore } from "@/store";
import { Box, Loader } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { View } from "@react-three/drei";
import { openFiles } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, MouseEventHandler, useCallback, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";
import { screenToZoomed } from "../lib/utils";
import FileHeader from "./file-header";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";
import { PlaybackStartLine } from "./playback-start-line";
import { TimeLegend } from "./time-legend";

export interface FileViewProps {
  fileId: string;
}

const viewStyle = { width: "100%", height: "100%", zIndex: 1 };

// This function remains the same
function getSnappedCoordinates(
  event: React.MouseEvent<HTMLDivElement>,
  fileId: string,
  bpm: number,
): [number, number] | null {
  const state = useStore.getState();
  const { gridSizeBeats, gridSizeSemis, bandsPerOctave } = state;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const screenUv = new Vector2(x, y);

  const zoom = state.filesZoom[fileId];
  const offset = state.filesOffset[fileId];
  const uv = screenToZoomed(screenUv, zoom, offset);
  const { spectrogramData } = openFiles[fileId];

  let snappedX = uv.x;
  let snappedY = uv.y;

  if (gridSizeBeats > 0) {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
    const currentTime = uv.x * totalDuration;
    // Floor to get the start of the current cell
    const cellIndex = Math.floor(currentTime / gridIntervalSeconds);
    const snappedCenterTime = cellIndex * gridIntervalSeconds;
    snappedX = snappedCenterTime / totalDuration;
  }

  if (gridSizeSemis > 0) {
    const bandsPerSemitone = bandsPerOctave / 12;
    const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
    const currentBand = (1.0 - uv.y) * spectrogramData.numBands;
    // Floor to get the start of the current cell
    const cellIndex = Math.floor(currentBand / gridIntervalBands);
    const snappedCenterBand = cellIndex * gridIntervalBands;
    snappedY = 1.0 - snappedCenterBand / spectrogramData.numBands;
  }

  return [snappedX, snappedY];
}

export const FileView = memo(({ fileId }: FileViewProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath || "";
  console.log("FileView render", fileId, filePath);

  const activeFileId = useStore((state) => state.activeFileId);
  const isActive = activeFileId === fileId;
  const isSettingPosition = useStore((state) => state.isSettingPosition);
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);
  const isSynthesizing = useStore((state) => state.filesSynthesizing[fileId]);

  const [isPanning, setIsPanning] = useState(false);
  const [isZooming, setZooming] = useState(false);

  const cursorStyle = useMemo(() => {
    if (isPanning) return { cursor: "grabbing" };
    if (isZooming) return { cursor: "zoom-in" };
    if (isSettingPosition) return { cursor: "crosshair" };
    return { cursor: "crosshair" };
  }, [isSettingPosition, isPanning, isZooming]);

  const rendererRef = useRef<FileRendererHandle>(null);
  const strokeTimeRangeRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null });
  const viewRef = useRef<HTMLDivElement>(null);

  useWindowEvent("keydown", (event) => {
    if (event.key === "Meta" || event.key === "Control") {
      setZooming(true);
    }
  });

  useWindowEvent("keyup", (event) => {
    if (event.key === "Meta" || event.key === "Control") {
      setZooming(false);
    }
  });

  useGesture(
    {
      onDrag: ({ event, dragging, delta: [dx] }) => {
        // Right button only (configured below). Pan in screen space.
        event.preventDefault();
        setIsPanning(dragging ?? false);

        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const Z = Math.pow(2, zoom);
        const viewWidth = 1 / Z;

        // No panning when zoomed fully out
        if (Z <= 1 + 1e-9) return;

        // Current viewStart from offset (must match screenToZoomed)
        const viewStart = offset * (1 - viewWidth);

        // Screen-space delta in [0,1]
        const ds = dx / rect.width;

        // Pan: moving the mouse right should decrease viewStart (content moves left)
        let newViewStart = viewStart - ds * viewWidth;

        // Clamp viewStart to [0, 1 - viewWidth]
        newViewStart = Math.max(0, Math.min(1 - viewWidth, newViewStart));

        // Convert back to offset
        const denom = 1 - viewWidth;
        const newOffset = denom > 0 ? newViewStart / denom : 0;

        useStore.getState().setFileOffset(fileId, newOffset);
      },
      onWheel: ({ event, delta: [, dy] }) => {
        if (!isZooming) return;
        event.preventDefault();
        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const { setFileZoom, setFileOffset } = useStore.getState();

        // wheel → zoomPower
        const sensitivity = 0.01;
        const oldPower = zoom;
        const newPower = Math.max(-0, Math.min(oldPower - dy * sensitivity, 7)); // clamp as you like

        const oldZ = Math.pow(2, oldPower);
        const newZ = Math.pow(2, newPower);

        const s = (event.clientX - rect.left) / rect.width; // cursor in [0,1]

        // From screenToZoomed:
        // viewWidth = 1/z
        // viewStart = offset * (1 - viewWidth)
        const oldViewWidth = 1 / oldZ;
        const newViewWidth = 1 / newZ;

        // Current world u under the cursor, keep this constant after zoom.
        const oldViewStart = offset * (1 - oldViewWidth);
        const u = oldViewStart + s * oldViewWidth;

        // Solve for new viewStart' so that u = viewStart' + s * newViewWidth
        const newViewStart = u - s * newViewWidth;

        // Convert back to offset' via viewStart' = offset' * (1 - newViewWidth)
        let newOffset: number;

        if (newZ <= 1 + 1e-9) {
          // Fully zoomed out — offset is irrelevant; pin to 0 for stability.
          newOffset = 0;
        } else {
          const denom = 1 - newViewWidth;
          newOffset = denom > 0 ? newViewStart / denom : 0;
          // Keep viewStart in-bounds => offset in [0,1]
          newOffset = Math.max(0, Math.min(1, newOffset));
        }

        setFileZoom(fileId, newPower);
        setFileOffset(fileId, newOffset);
      },
    },
    {
      target: viewRef,
      eventOptions: { passive: false },
      drag: {
        pointer: { buttons: [2], mouse: true }, // right click
        from: () => [0, 0],
        filterTaps: true,
      },
    },
  );

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
      const { filePath, spectrogramData } = openFiles[fileId];
      const bpm = state.filepathsBpm[filePath];
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const timeSeconds = uvX * totalDuration;
      const centerBeats = (timeSeconds / 60) * bpm;
      const beats = centerBeats;
      const bandIndex = (1 - uvY) * spectrogramData.numBands;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const centerPitch = bandIndex / bandsPerSemitone;
      const pitch = centerPitch;
      return { beats, pitch };
    },
    [fileId],
  );

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning) return;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      // Track time range when dragging
      if (isActive && event.buttons === 1 && strokeTimeRangeRef.current.min !== null) {
        const { spectrogramData } = file;
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const currentBrushStart = snappedX * totalDuration;
        const currentBrushEnd = snappedX * totalDuration;
        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min!, currentBrushStart);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushEnd);
      }

      // Only update if position actually changed
      if (
        !lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY
      ) {
        // Convert to beats/pitch and update cursor position
        const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
        state.setCursorPosition({ beats, pitch });
        state.setCursorVisible(true);
        state.setHoveredFile(fileId);
        lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

        // Only call renderStroke when actually dragging (applying stroke)
        // Preview is handled by the renderer watching cursorPosition
        if (rendererRef.current) {
          const isDragging = isActive && event.buttons === 1;
          rendererRef.current.renderStroke(snappedX, snappedY, !isDragging);
        }
      }
    },
    [fileId, isActive, file, isPanning, uvToBeatsAndPitch],
  );

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning) return;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
      state.setCursorPosition({ beats, pitch });
      state.setCursorVisible(true);
      state.setHoveredFile(fileId);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

      if (rendererRef.current) {
        rendererRef.current.renderStroke(snappedX, snappedY, true);
      }
    },
    [fileId, isPanning, uvToBeatsAndPitch],
  );

  const handleMouseLeave = useCallback(() => {
    const state = useStore.getState();
    // Hide cursor when mouse leaves, but keep position so keyboard can resume from here
    state.setCursorVisible(false);
    state.setHoveredFile(null);
    rendererRef.current?.clearPreview();
    lastSnappedPositionRef.current = null;
  }, []);

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (event.button !== 0) return;

      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;

      if (isSettingPosition) {
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        state.setSourcePosition({ beats, pitch, fileId });
        state.setIsSettingPosition(false);
        state.setSourceFile(fileId);
        return;
      }

      if (!isActive) {
        state.setActiveFileId(fileId);
      }

      if (rendererRef?.current) {
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        state.setCursorPosition({ beats, pitch });

        const { spectrogramData } = file;
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const centerTimeSeconds = coords[0] * totalDuration;
        const initialBrushStart = centerTimeSeconds;
        const initialBrushEnd = centerTimeSeconds;
        strokeTimeRangeRef.current = { min: initialBrushStart, max: initialBrushEnd };

        if (state.sourcePositionMode === "offset" && !state.lockedOffset && state.sourcePosition) {
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
      if (event.button === 0) {
        const state = useStore.getState();
        const finalRange = strokeTimeRangeRef.current;
        
        // Use unified action with time range
        if (finalRange.min !== null && finalRange.max !== null) {
          await state.applyStrokeAtPosition(undefined, { min: finalRange.min, max: finalRange.max });
        } else {
          await state.applyStrokeAtPosition();
        }

        state.setCursorPosition(null);
        strokeTimeRangeRef.current = { min: null, max: null };
      }
    },
    [isActive],
  );

  if (!file) return null;

  return (
    <Box
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid dark.7"}
      onClick={() => {
        if (!isActive) {
          useStore.getState().setActiveFileId(fileId);
        }
      }}
    >
      <FileHeader fileId={fileId} />
      <Box
        ref={viewRef}
        h={400}
        style={cursorStyle}
        pos="relative"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <View style={viewStyle}>
          <FileRenderer fileId={fileId} ref={refCallback} />
        </View>
        {isActive && <PlaybackLine fileId={fileId} />}
        {isActive && <PlaybackStartLine fileId={fileId} />}
      </Box>
      <TimeLegend fileId={fileId} />
      {isSynthesizing && <Loader size="xs" pos="absolute" bottom={25} right={10} />}
    </Box>
  );
});

FileView.displayName = "FileView";
