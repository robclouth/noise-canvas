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
import { PITCH_LEGEND_WIDTH, PitchLegend } from "./pitch-legend";
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

  const zoom = new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0);
  const offset = new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0);
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
  const momentumRef = useRef<{ vx: number; vy: number; raf: number | null }>({ vx: 0, vy: 0, raf: null });
  const pinchPrevScaleRef = useRef<number>(1);

  const stopMomentum = useCallback(() => {
    if (momentumRef.current.raf !== null) {
      cancelAnimationFrame(momentumRef.current.raf);
      momentumRef.current.raf = null;
    }
    momentumRef.current.vx = 0;
    momentumRef.current.vy = 0;
  }, []);

  const applyScrollDelta = useCallback(
    (dxPx: number, dyPx: number) => {
      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const state = useStore.getState();
      const zx = state.filesZoom[fileId];
      const ox = state.filesOffset[fileId];
      const zy = state.filesZoomY[fileId] ?? 0;
      const oy = state.filesOffsetY[fileId] ?? 0;
      const zxPow = Math.pow(2, zx);
      const zyPow = Math.pow(2, zy);

      if (zxPow > 1 + 1e-9) {
        const viewWidth = 1 / zxPow;
        const ds = dxPx / rect.width;
        const denom = 1 - viewWidth;
        const shifted = ox + (ds * viewWidth) / (denom || 1);
        state.setFileOffset(fileId, Math.max(0, Math.min(1, shifted)));
      }
      if (zyPow > 1 + 1e-9) {
        const viewHeight = 1 / zyPow;
        const ds = dyPx / rect.height;
        const denom = 1 - viewHeight;
        const shifted = oy + (ds * viewHeight) / (denom || 1);
        state.setFileOffsetY(fileId, Math.max(0, Math.min(1, shifted)));
      }
    },
    [fileId],
  );

  const startMomentum = useCallback(
    (vxPxPerMs: number, vyPxPerMs: number) => {
      stopMomentum();
      const DECAY_PER_FRAME = 0.92;
      const MIN_VEL = 0.005;
      if (Math.abs(vxPxPerMs) < MIN_VEL && Math.abs(vyPxPerMs) < MIN_VEL) return;
      momentumRef.current.vx = vxPxPerMs;
      momentumRef.current.vy = vyPxPerMs;

      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        applyScrollDelta(momentumRef.current.vx * dt, momentumRef.current.vy * dt);
        const decay = Math.pow(DECAY_PER_FRAME, dt / 16.67);
        momentumRef.current.vx *= decay;
        momentumRef.current.vy *= decay;
        if (Math.abs(momentumRef.current.vx) < MIN_VEL && Math.abs(momentumRef.current.vy) < MIN_VEL) {
          momentumRef.current.raf = null;
          return;
        }
        momentumRef.current.raf = requestAnimationFrame(step);
      };
      momentumRef.current.raf = requestAnimationFrame(step);
    },
    [applyScrollDelta, stopMomentum],
  );

  const applyCursorCentricXZoom = useCallback(
    (newPower: number, cursorScreenU: number) => {
      const state = useStore.getState();
      const oldPower = state.filesZoom[fileId];
      const oldOffset = state.filesOffset[fileId];
      const clamped = Math.max(0, Math.min(newPower, 7));
      const oldZ = Math.pow(2, oldPower);
      const newZ = Math.pow(2, clamped);
      const oldViewWidth = 1 / oldZ;
      const newViewWidth = 1 / newZ;
      const oldViewStart = oldZ > 1 ? oldOffset * (1 - oldViewWidth) : 0;
      const u = oldViewStart + cursorScreenU * oldViewWidth;
      const newViewStart = u - cursorScreenU * newViewWidth;

      let newOffset: number;
      if (newZ <= 1 + 1e-9) {
        newOffset = 0;
      } else {
        const denom = 1 - newViewWidth;
        newOffset = denom > 0 ? newViewStart / denom : 0;
        newOffset = Math.max(0, Math.min(1, newOffset));
      }
      state.setFileZoom(fileId, clamped);
      state.setFileOffset(fileId, newOffset);
    },
    [fileId],
  );

  useEffect(() => () => stopMomentum(), [stopMomentum]);

  useGesture(
    {
      onDrag: ({ event, dragging, delta: [dx] }) => {
        event.preventDefault();
        stopMomentum();
        setIsPanning(dragging ?? false);

        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const Z = Math.pow(2, zoom);
        const viewWidth = 1 / Z;
        if (Z <= 1 + 1e-9) return;

        const viewStart = offset * (1 - viewWidth);
        const ds = dx / rect.width;
        let newViewStart = viewStart - ds * viewWidth;
        newViewStart = Math.max(0, Math.min(1 - viewWidth, newViewStart));
        const denom = 1 - viewWidth;
        const newOffset = denom > 0 ? newViewStart / denom : 0;
        useStore.getState().setFileOffset(fileId, newOffset);
      },
      onWheel: ({ event, delta: [dx, dy], velocity: [vx, vy], direction: [dirX, dirY], last }) => {
        event.preventDefault();
        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const wheelEvent = event as WheelEvent;
        const isZoomGesture = wheelEvent.ctrlKey || wheelEvent.metaKey || isZooming;

        if (isZoomGesture) {
          stopMomentum();
          const sensitivity = wheelEvent.ctrlKey || wheelEvent.metaKey ? 0.02 : 0.01;
          const cursorU = (wheelEvent.clientX - rect.left) / rect.width;
          const oldPower = useStore.getState().filesZoom[fileId];
          applyCursorCentricXZoom(oldPower - dy * sensitivity, cursorU);
          return;
        }

        stopMomentum();
        applyScrollDelta(dx, dy);

        if (last) {
          const signedVx = vx * dirX;
          const signedVy = vy * dirY;
          if (Math.abs(signedVx) > 0.05 || Math.abs(signedVy) > 0.05) {
            startMomentum(signedVx, signedVy);
          }
        }
      },
      onPinch: ({ event, offset: [scale], first }) => {
        event.preventDefault();
        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        if (first) {
          pinchPrevScaleRef.current = scale;
          stopMomentum();
          return;
        }

        const deltaLog = Math.log2(scale / pinchPrevScaleRef.current);
        pinchPrevScaleRef.current = scale;
        if (deltaLog === 0) return;

        const nativeEvent = event as PointerEvent | WheelEvent;
        const clientX = "clientX" in nativeEvent ? nativeEvent.clientX : rect.left + rect.width / 2;
        const cursorU = (clientX - rect.left) / rect.width;
        const currentPower = useStore.getState().filesZoom[fileId];
        applyCursorCentricXZoom(currentPower + deltaLog, cursorU);
      },
    },
    {
      target: viewRef,
      eventOptions: { passive: false },
      drag: {
        pointer: { buttons: [2], mouse: true },
        from: () => [0, 0],
        filterTaps: true,
      },
      pinch: {
        scaleBounds: { min: 0.0078125, max: 128 },
        rubberband: true,
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

      // Pick mode: clicking on a canvas sets the file path and position params
      if (state.pickingFileParam) {
        state.setParameter(state.pickingFileParam, { path: openFiles[fileId].filePath });
        // Set position params (UV 0-1 → 0-100%). Y is inverted between display and spectrogram space.
        state.setParameter("sourceTimeOffset" as import("@renderer/store/types").ParameterKey, coords[0] * 100);
        state.setParameter(
          "sourcePitchOffset" as import("@renderer/store/types").ParameterKey,
          (1.0 - coords[1]) * 100,
        );
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

              const srcTimeUv = (Number(activeStep?.sourceTimeOffset) || 0) / 100;
              const srcPitchUv = (Number(activeStep?.sourcePitchOffset) || 0) / 100;
              const offsetX = srcTimeUv - coords[0] * tScale;
              const offsetY = srcPitchUv - coords[1] * bScale;
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
      const currentZoom = new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0);
      const currentOffset = new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0);
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
      onPointerDown={() => {
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
            h={isFullscreen ? undefined : 400}
            style={{
              ...(isFullscreen ? { flex: 1 } : {}),
              display: "flex",
              flexDirection: "row",
            }}
          >
            <PitchLegend fileId={fileId} />
            <Box
              ref={viewRef}
              style={{ flex: 1, ...cursorStyle }}
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
          </Box>
          <Box style={{ paddingLeft: PITCH_LEGEND_WIDTH }}>
            <TimeLegend fileId={fileId} />
          </Box>
        </>
      )}
      {isSynthesizing && <Loader size="xs" pos="absolute" bottom={25} right={10} />}
    </Box>
  );
});

FileView.displayName = "FileView";
