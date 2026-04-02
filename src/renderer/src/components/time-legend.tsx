import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useCallback, useEffect, useRef } from "react";
import { Vector2 } from "three";
import { screenToZoomed, zoomedToScreen } from "../lib/utils";

interface TimeLegendProps {
  fileId: string;
}

export const TimeLegend = memo(({ fileId }: TimeLegendProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath;
  const bpm = useStore((state) => state.filepathsBpm[filePath]);
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);
  const gridSizeBeats = useStore((state) => state.gridSizeBeats);
  const setFilePlaybackStartTime = useStore((state) => state.setFilePlaybackStartTime);
  const togglePlayback = useStore((state) => state.togglePlayback);
  const isPlaying = useStore((state) => state.isPlaying);
  const activeFileId = useStore((state) => state.activeFileId);
  const setPlaybackTime = useStore((state) => state.setPlaybackTime);

  const legendRef = useRef<HTMLDivElement>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const dragStartTimeRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const getTimeFromX = useCallback(
    (clientX: number, rect: DOMRect): number => {
      if (!file?.spectrogramData) return 0;
      const x = (clientX - rect.left) / rect.width;
      const uv = screenToZoomed(new Vector2(x, 0.5), zoom, offset);
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      let time = uv.x * totalDuration;
      if (gridSizeBeats > 0) {
        const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
        time = Math.round(time / gridIntervalSeconds) * gridIntervalSeconds;
      }
      return Math.max(0, Math.min(time, totalDuration));
    },
    [file, zoom, offset, gridSizeBeats, bpm],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      dragStartTimeRef.current = getTimeFromX(event.clientX, rect);
      isDraggingRef.current = false;
    },
    [getTimeFromX],
  );

  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (dragStartTimeRef.current === null) return;
      const rect = legendRef.current?.getBoundingClientRect();
      if (!rect || !file?.spectrogramData) return;

      isDraggingRef.current = true;

      const startTime = dragStartTimeRef.current;
      const currentTime = getTimeFromX(event.clientX, rect);
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      const loopStart = Math.min(startTime, currentTime);
      const loopEnd = Math.max(startTime, currentTime);

      // Update drag preview overlay directly (respects zoom/offset)
      if (dragPreviewRef.current) {
        const { filesZoom, filesOffset } = useStore.getState();
        const z = filesZoom[fileId];
        const o = filesOffset[fileId];
        const screenLeft = zoomedToScreen(new Vector2(loopStart / totalDuration, 0.5), z, o).x;
        const screenRight = zoomedToScreen(new Vector2(loopEnd / totalDuration, 0.5), z, o).x;
        const clampedLeft = Math.max(0, screenLeft);
        const clampedRight = Math.min(1, screenRight);
        dragPreviewRef.current.style.left = `${clampedLeft * 100}%`;
        dragPreviewRef.current.style.width = `${Math.max(0, clampedRight - clampedLeft) * 100}%`;
        dragPreviewRef.current.style.display = "block";
      }
    };

    const handleWindowMouseUp = async (event: MouseEvent) => {
      if (dragStartTimeRef.current === null) return;
      const startTime = dragStartTimeRef.current;
      dragStartTimeRef.current = null;

      if (dragPreviewRef.current) dragPreviewRef.current.style.display = "none";

      const rect = legendRef.current?.getBoundingClientRect();
      if (!rect || !file) return;

      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        const endTime = getTimeFromX(event.clientX, rect);
        const loopStart = Math.min(startTime, endTime);
        const loopEnd = Math.max(startTime, endTime);
        if (loopEnd > loopStart) {
          useStore.getState().setLoopRegion({ start: loopStart, end: loopEnd });
          setFilePlaybackStartTime(fileId, loopStart);
        }
      } else {
        // It was a plain click — set playback position
        useStore.getState().setLoopRegion(null);
        setFilePlaybackStartTime(fileId, startTime);
        if (activeFileId === fileId && isPlaying) {
          setPlaybackTime(startTime);
        } else if (activeFileId === fileId) {
          await togglePlayback();
        }
      }
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [file, fileId, getTimeFromX, setFilePlaybackStartTime, activeFileId, isPlaying, setPlaybackTime, togglePlayback]);

  if (!file?.spectrogramData) return null;

  const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

  // Generate time markers and ticks based on zoom level and BPM
  const markers: { position: number; label: string; isTick: boolean }[] = [];

  // Calculate the visible time window
  const zoomFactor = Math.pow(2, zoom);
  const visibleDuration = totalDuration / zoomFactor;
  const startTime = offset * (totalDuration - visibleDuration);
  const endTime = startTime + visibleDuration;

  // Determine tick interval (always show beat-level ticks)
  const beatDuration = 60 / bpm; // Duration of one beat in seconds
  const tickInterval = beatDuration;

  // Determine label interval based on zoom and grid size
  // Show labels every beat, but limit to prevent overcrowding
  let labelInterval = beatDuration;

  // If grid is enabled and small, show fewer labels
  if (gridSizeBeats > 0 && gridSizeBeats < 1) {
    // For sub-beat grids (1/2, 1/4, etc.), show labels every beat
    labelInterval = beatDuration;
  } else {
    // For beat-level or larger grids, show labels at grid intervals
    labelInterval = (60 / bpm) * Math.max(1, gridSizeBeats);
  }

  // If too many labels would appear on screen, increase interval
  const maxLabels = 20;
  const potentialLabelCount = visibleDuration / labelInterval;
  if (potentialLabelCount > maxLabels) {
    labelInterval = Math.ceil(potentialLabelCount / maxLabels) * beatDuration;
  }

  // Find the first tick position (align to beat)
  const firstTickTime = Math.ceil(startTime / tickInterval) * tickInterval;

  // Generate ticks that fall within the visible window
  for (let time = firstTickTime; time <= endTime; time += tickInterval) {
    if (time > totalDuration) break;

    const beat = (time / 60) * bpm;
    const measure = Math.floor(beat / 4) + 1;
    const beatInMeasure = Math.floor(beat % 4) + 1;

    // Convert time to screen position (0-1 range in visible window)
    const screenX = (time - startTime) / visibleDuration;

    if (screenX >= 0 && screenX <= 1) {
      // Determine if this should have a label by checking if it aligns with labelInterval
      const timeDiff = Math.abs(time - Math.round(time / labelInterval) * labelInterval);
      const shouldHaveLabel = timeDiff < tickInterval * 0.01; // Within 1% tolerance

      markers.push({
        position: screenX * 100,
        label: shouldHaveLabel ? `${measure}.${beatInMeasure}` : "",
        isTick: !shouldHaveLabel,
      });
    }
  }

  return (
    <Box
      ref={legendRef}
      style={{
        width: "100%",
        height: 15,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        position: "relative",
        cursor: "col-resize",
        borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        overflow: "hidden",
        userSelect: "none",
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Drag preview overlay */}
      <div
        ref={dragPreviewRef}
        style={{
          position: "absolute",
          top: 0,
          height: "100%",
          background: "rgba(255, 150, 0, 0.4)",
          pointerEvents: "none",
          display: "none",
          zIndex: 10,
        }}
      />
      {markers.map((marker, i) => (
        <Box
          key={i}
          style={{
            position: "absolute",
            left: `${marker.position}%`,
            top: 0,
            height: marker.isTick ? "40%" : "100%",
            borderLeft: marker.isTick ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid rgba(255, 255, 255, 0.4)",
            pointerEvents: "none",
          }}
        >
          {marker.label && (
            <Box
              style={{
                position: "absolute",
                left: 4,
                top: 0,
                fontSize: 10,
                color: "rgba(255, 255, 255, 0.7)",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              {marker.label}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
});

TimeLegend.displayName = "TimeLegend";
