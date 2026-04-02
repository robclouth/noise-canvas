import { useStore } from "@/store";
import { Box, Loader, Text } from "@mantine/core";
import { View } from "@react-three/drei";
import { openFiles } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, PointerEventHandler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";
import { penState } from "../lib/pen-state";
import { screenToZoomed } from "../lib/utils";
import FileHeader from "./file-header";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { LoopRegion } from "./loop-region";
import { PlaybackLine } from "./playback-line";
import { TimeLegend } from "./time-legend";

export interface FileViewProps {
  fileId: string;
  isFullscreen?: boolean;
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
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return null;

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

export const FileView = memo(({ fileId, isFullscreen = false }: FileViewProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath || "";
  console.log("FileView render", fileId, filePath);

  const activeFileId = useStore((state) => state.activeFileId);
  const isActive = activeFileId === fileId;
  const pickingFileParam = useStore((state) => state.pickingFileParam);
  const isZooming = useStore((state) => state.isZooming);
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);
  const isSynthesizing = useStore((state) => state.filesSynthesizing[fileId]);
  const loadingMessage = useStore((state) => state.filesLoading[fileId]);

  const [isPanning, setIsPanning] = useState(false);

  const cursorStyle = useMemo(() => {
    if (isPanning) return { cursor: "grabbing" };
    if (isZooming) return { cursor: "zoom-in" };
    if (pickingFileParam) return { cursor: "crosshair" };
    return { cursor: "crosshair" };
  }, [pickingFileParam, isPanning, isZooming]);

  const rendererRef = useRef<FileRendererHandle>(null);
  const strokeTimeRangeRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null });
  const viewRef = useRef<HTMLDivElement>(null);
  const isStrokingRef = useRef(false);

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
      if (!spectrogramData) return { beats: 0, pitch: 0 };
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

  const handleMouseMove: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning) return;
      penState.pressure = event.pointerType === "pen" ? event.pressure : 1;
      penState.tiltX = event.tiltX;
      penState.tiltY = event.tiltY;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      // Track time range when dragging
      if (isStrokingRef.current && strokeTimeRangeRef.current.min !== null) {
        const { spectrogramData } = file;
        if (!spectrogramData) return;
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
          const isDragging = isStrokingRef.current;
          rendererRef.current.renderStroke(snappedX, snappedY, !isDragging);
        }
      }
    },
    [fileId, isActive, file, isPanning, uvToBeatsAndPitch],
  );

  const handleMouseEnter: PointerEventHandler<HTMLDivElement> = useCallback(
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
    // Don't clear state if we're in the middle of a stroke - we'll handle it via window events
    if (isStrokingRef.current) return;

    const state = useStore.getState();
    // Hide cursor when mouse leaves, but keep position so keyboard can resume from here
    state.setCursorVisible(false);
    state.setHoveredFile(null);
    rendererRef.current?.clearPreview();
    lastSnappedPositionRef.current = null;
  }, []);

  const handleCanvasMouseDown: PointerEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (event.button !== 0) return;

      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;

      // Pick mode: clicking on a canvas sets the file param value with UV coordinates
      if (state.pickingFileParam) {
        const fileParamValue = { path: openFiles[fileId].filePath, timeUv: coords[0], pitchUv: 1.0 - coords[1] };
        state.setParameter(state.pickingFileParam, fileParamValue);
        state.setPickingFileParam(null);
        return;
      }

      if (!isActive) {
        state.setActiveFileId(fileId);
      }

      if (rendererRef?.current) {
        const { spectrogramData } = file;
        if (!spectrogramData) return;
        isStrokingRef.current = true;
        state.setIsStroking(true);
        rendererRef.current.beginStroke();
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        state.setCursorPosition({ beats, pitch });

        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const centerTimeSeconds = coords[0] * totalDuration;
        const initialBrushStart = centerTimeSeconds;
        const initialBrushEnd = centerTimeSeconds;
        strokeTimeRangeRef.current = { min: initialBrushStart, max: initialBrushEnd };

        // Compute locked offset for anchored mode with beat-based scale
        const { getActiveStep } = state;
        const activeStep = getActiveStep();
        const sourceFileValue = activeStep?.sourceFile ?? null;
        if (sourceFileValue) {
          const sourcePositionMode = activeStep?.sourcePositionMode ?? "anchored";
          if (sourcePositionMode === "anchored") {
            const sourceOpenFile = Object.values(openFiles).find((f) => f.filePath === sourceFileValue.path);
            if (sourceOpenFile?.spectrogramData && spectrogramData) {
              const destBpm = state.filepathsBpm[file.filePath] || 120;
              const destDur = spectrogramData.numFrames / spectrogramData.sampleRate;
              const srcBpm = state.filepathsBpm[sourceOpenFile.filePath] || 120;
              const srcDur = sourceOpenFile.spectrogramData.numFrames / sourceOpenFile.spectrogramData.sampleRate;
              const tScale = (destBpm * destDur) / (srcBpm * srcDur);
              const bScale = spectrogramData.numBands / sourceOpenFile.spectrogramData.numBands;

              const offsetX = sourceFileValue.timeUv - coords[0] * tScale;
              const offsetY = sourceFileValue.pitchUv - coords[1] * bScale;
              state.updateActiveStepLockedOffset({ beats: offsetX, pitch: offsetY });
            }
          }
        }

        rendererRef.current.renderStroke(coords[0], coords[1], false);
      }
    },
    [fileId, isActive, uvToBeatsAndPitch, file],
  );

  const handleCanvasMouseUp: PointerEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (!isActive) return;
      if (event.button === 0) {
        await finishStroke();
      }
    },
    [isActive],
  );

  // Helper to finish a stroke - used by both handleCanvasMouseUp and window mouseup
  const finishStroke = useCallback(async () => {
    if (!isStrokingRef.current) return;
    isStrokingRef.current = false;

    const state = useStore.getState();
    state.setIsStroking(false);
    const finalRange = strokeTimeRangeRef.current;

    // Use unified action with time range
    if (finalRange.min !== null && finalRange.max !== null) {
      await state.applyStrokeAtPosition(undefined, { min: finalRange.min, max: finalRange.max });
    } else {
      await state.applyStrokeAtPosition();
    }
    rendererRef.current?.endStroke();

    strokeTimeRangeRef.current = { min: null, max: null };
  }, []);

  // Window-level event listeners to handle mouse movements and releases outside the file view
  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!isStrokingRef.current) return;

      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;

      // Calculate UV coordinates - these can go outside 0-1 range when cursor is outside canvas
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      const screenUv = new Vector2(x, y);
      const state = useStore.getState();
      const currentZoom = state.filesZoom[fileId];
      const currentOffset = state.filesOffset[fileId];
      const uv = screenToZoomed(screenUv, currentZoom, currentOffset);

      // Apply snapping
      const { gridSizeBeats, gridSizeSemis, bandsPerOctave } = state;
      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!spectrogramData) return;
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];

      let snappedX = uv.x;
      let snappedY = uv.y;

      if (gridSizeBeats > 0) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
        const currentTime = uv.x * totalDuration;
        const cellIndex = Math.floor(currentTime / gridIntervalSeconds);
        const snappedCenterTime = cellIndex * gridIntervalSeconds;
        snappedX = snappedCenterTime / totalDuration;
      }

      if (gridSizeSemis > 0) {
        const bandsPerSemitone = bandsPerOctave / 12;
        const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
        const currentBand = (1.0 - uv.y) * spectrogramData.numBands;
        const cellIndex = Math.floor(currentBand / gridIntervalBands);
        const snappedCenterBand = cellIndex * gridIntervalBands;
        snappedY = 1.0 - snappedCenterBand / spectrogramData.numBands;
      }

      // Track time range
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const currentBrushTime = snappedX * totalDuration;
      if (strokeTimeRangeRef.current.min !== null) {
        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min, currentBrushTime);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushTime);
      }

      // Check if snapped position actually changed (for grid snapping)
      const lastPos = lastSnappedPositionRef.current;
      const positionChanged =
        !lastPos || Math.abs(lastPos.x - snappedX) > 0.0001 || Math.abs(lastPos.y - snappedY) > 0.0001;

      // Update cursor position
      const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
      state.setCursorPosition({ beats, pitch });
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

      // Only render if position actually changed (prevents duplicate iterations at same grid cell)
      if (positionChanged && rendererRef.current) {
        rendererRef.current.renderStroke(snappedX, snappedY, false);
      }
    };

    const handleWindowMouseUp = async (event: MouseEvent) => {
      if (event.button === 0 && isStrokingRef.current) {
        await finishStroke();
        // Clean up cursor state since we're outside the element
        const state = useStore.getState();
        state.setCursorVisible(false);
        state.setHoveredFile(null);
        rendererRef.current?.clearPreview();
        lastSnappedPositionRef.current = null;
      }
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [fileId, finishStroke, uvToBeatsAndPitch]);

  if (!file) return null;

  return (
    <Box
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid dark.7"}
      h={isFullscreen ? "100%" : undefined}
      style={isFullscreen ? { display: "flex", flexDirection: "column" } : undefined}
      onClick={() => {
        if (!isActive) {
          useStore.getState().setActiveFileId(fileId);
        }
      }}
    >
      <FileHeader fileId={fileId} />
      {loadingMessage || !file.spectrogramData ? (
        <Box
          h={isFullscreen ? undefined : 400}
          style={{
            ...(isFullscreen ? { flex: 1 } : {}),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
          pos="relative"
        >
          <Loader size="sm" />
          {loadingMessage && (
            <Text size="xs" c="dimmed">
              {loadingMessage}
            </Text>
          )}
        </Box>
      ) : (
        <>
          <Box
            ref={viewRef}
            h={isFullscreen ? undefined : 400}
            style={{ ...(isFullscreen ? { flex: 1 } : {}), ...cursorStyle }}
            pos="relative"
            onPointerEnter={handleMouseEnter}
            onPointerMove={handleMouseMove}
            onPointerLeave={handleMouseLeave}
            onPointerDown={handleCanvasMouseDown}
            onPointerUp={handleCanvasMouseUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <View style={viewStyle}>
              <FileRenderer fileId={fileId} ref={refCallback} />
            </View>
            {isActive && <LoopRegion fileId={fileId} />}
            {isActive && <PlaybackLine fileId={fileId} />}
          </Box>
          <TimeLegend fileId={fileId} />
        </>
      )}
      {isSynthesizing && <Loader size="xs" pos="absolute" bottom={25} right={10} />}
    </Box>
  );
});

FileView.displayName = "FileView";
