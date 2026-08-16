import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useCallback, useEffect, useRef } from "react";
import { Vector2 } from "three";
import { shallow } from "zustand/shallow";
import { computeTimeMarkers } from "../lib/time-markers";
import { screenToZoomed, snapToSwungGridRound, zoomedToScreen } from "../lib/utils";
import { LOOP_DRAG_COLOUR } from "./loop-region";

interface TimeLegendProps {
  fileId: string;
}

export const TimeLegend = memo(({ fileId }: TimeLegendProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath;
  const bpm = useStore((state) => state.filepathsBpm[filePath]);
  const gridSizeBeats = useStore((state) => state.gridSizeBeats);
  const gridSwing = useStore((state) => state.gridSwing);
  const snapTime = useStore((state) => state.snapTime);
  const setFilePlaybackStartTime = useStore((state) => state.setFilePlaybackStartTime);
  const togglePlayback = useStore((state) => state.togglePlayback);
  const isPlaying = useStore((state) => state.isPlaying);
  const activeFileId = useStore((state) => state.activeFileId);
  const setPlaybackTime = useStore((state) => state.setPlaybackTime);

  const legendRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const dragStartTimeRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const getTimeFromX = useCallback(
    (clientX: number, rect: DOMRect): number => {
      if (!file?.spectrogramData) return 0;
      const state = useStore.getState();
      const x = (clientX - rect.left) / rect.width;
      const uv = screenToZoomed(new Vector2(x, 0.5), state.filesZoom[fileId], state.filesOffset[fileId]);
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
      let time = uv.x * totalDuration;
      if (snapTime) {
        const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
        time = snapToSwungGridRound(time, gridIntervalSeconds, gridSwing / 100);
      }
      return Math.max(0, Math.min(time, totalDuration));
    },
    [file, fileId, gridSizeBeats, gridSwing, snapTime, bpm],
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

      // The legend belongs to its own file, which need not be the active one.
      // Only the active file's region drives the player, so an inactive file's
      // region is stored without touching playback.
      const writeLoopRegion = (region: { start: number; end: number } | null) => {
        const store = useStore.getState();
        if (store.activeFileId === fileId) store.setLoopRegion(region);
        else store.setFileLoopRegion(fileId, region);
      };

      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        const endTime = getTimeFromX(event.clientX, rect);
        const loopStart = Math.min(startTime, endTime);
        const loopEnd = Math.max(startTime, endTime);
        if (loopEnd > loopStart) {
          writeLoopRegion({ start: loopStart, end: loopEnd });
          setFilePlaybackStartTime(fileId, loopStart);
        }
      } else {
        // It was a plain click — set playback position
        writeLoopRegion(null);
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

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const container = legendRef.current;
      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!canvas || !container || !spectrogramData) return;

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const state = useStore.getState();
      const file = openFiles[fileId];
      const markers = computeTimeMarkers({
        zoom: state.filesZoom[fileId] ?? 0,
        offset: state.filesOffset[fileId] ?? 0,
        totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
        bpm: (file && state.filepathsBpm[file.filePath]) || 120,
        gridSizeBeats: state.gridSizeBeats,
        widthPx: width,
      });

      ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textBaseline = "top";
      for (const marker of markers) {
        const x = Math.round(marker.position * width) + 0.5;
        ctx.strokeStyle = marker.isTick ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.4)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, marker.isTick ? height * 0.4 : height);
        ctx.stroke();
        if (marker.label) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
          ctx.fillText(marker.label, x + 4, 1);
        }
      }
    };

    const legendFile = openFiles[fileId];
    const unsubscribe = useStore.subscribe(
      (state) => ({
        zoom: state.filesZoom[fileId],
        offset: state.filesOffset[fileId],
        bpm: legendFile && state.filepathsBpm[legendFile.filePath],
        gridSizeBeats: state.gridSizeBeats,
        loading: state.filesLoading[fileId],
      }),
      draw,
      { equalityFn: shallow, fireImmediately: true },
    );

    const observer = new ResizeObserver(draw);
    if (legendRef.current) observer.observe(legendRef.current);

    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [fileId]);

  if (!file?.spectrogramData) return null;

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
          background: LOOP_DRAG_COLOUR,
          pointerEvents: "none",
          display: "none",
          zIndex: 10,
        }}
      />
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none" }} />
    </Box>
  );
});

TimeLegend.displayName = "TimeLegend";
