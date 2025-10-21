import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, MouseEventHandler, useCallback } from "react";
import { Vector2 } from "three";
import { screenToZoomed } from "../lib/utils";

interface TimeLegendProps {
  fileId: string;
}

export const TimeLegend = memo(({ fileId }: TimeLegendProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath;
  const bpm = useStore((state) => (filePath ? (state.fileSettings[filePath]?.bpm ?? 120) : 120));
  const zoom = useStore((state) => (filePath ? (state.fileSettings[filePath]?.zoom ?? 0) : 0));
  const offset = useStore((state) => (filePath ? (state.fileSettings[filePath]?.offset ?? 0) : 0));
  const gridSizeBeats = useStore((state) => state.gridSizeBeats.value);
  const setFilePlaybackStartTime = useStore((state) => state.setFilePlaybackStartTime);
  const togglePlayback = useStore((state) => state.togglePlayback);
  const isPlaying = useStore((state) => state.isPlaying);
  const activeFileId = useStore((state) => state.activeFileId);
  const setPlaybackTime = useStore((state) => state.setPlaybackTime);

  const handleClick: MouseEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (!file) return;

      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width === 0) return;

      const x = (event.clientX - rect.left) / rect.width;
      const screenUv = new Vector2(x, 0.5);

      // Convert from screen coordinates to zoomed coordinates
      const uv = screenToZoomed(screenUv, zoom, offset);

      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      let clickTime = uv.x * totalDuration;

      // Snap to grid if enabled
      if (gridSizeBeats > 0) {
        const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
        clickTime = Math.round(clickTime / gridIntervalSeconds) * gridIntervalSeconds;
      }

      // Clamp to valid range
      clickTime = Math.max(0, Math.min(clickTime, totalDuration));

      // Set the playback start time for this file
      setFilePlaybackStartTime(fileId, clickTime);

      // Clear auto-playback end time since this is manual playback
      useStore.getState().setAutoPlayEndTime(null);

      // If this is the active file and already playing
      if (activeFileId === fileId && isPlaying) {
        setPlaybackTime(clickTime);
      }
      // If not playing, just start playing from this position
      else if (activeFileId === fileId) {
        await togglePlayback();
      }
    },
    [
      fileId,
      file,
      zoom,
      offset,
      gridSizeBeats,
      bpm,
      setFilePlaybackStartTime,
      togglePlayback,
      isPlaying,
      activeFileId,
      setPlaybackTime,
    ],
  );

  if (!file) return null;

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
      style={{
        width: "100%",
        height: 15,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        position: "relative",
        cursor: "pointer",
        borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        overflow: "hidden",
      }}
      onClick={handleClick}
    >
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
