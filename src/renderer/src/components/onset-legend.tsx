import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useEffect, useRef } from "react";
import { shallow } from "zustand/shallow";
import { getFileOnsets } from "../lib/file-onsets";
import { zoomedToScreen } from "../lib/utils";
import { Vector2 } from "three";

export const ONSET_LEGEND_HEIGHT = 15;

// Mantine orange[6]-ish, matching the transient-aware effects' accent.
const MARKER_COLOR = "255, 140, 51";
const MARKER_WIDTH_PX = 1;
// A quiet onset still counts — it is snapped to and re-anchored like any other
// — so the level only separates the hits visually rather than fading them out.
const MIN_ALPHA = 0.35;

interface OnsetLegendProps {
  fileId: string;
}

/**
 * A strip above the spectrogram carrying one line per detected onset, so the
 * hits are readable without anything being drawn over the picture itself.
 */
export const OnsetLegend = memo(({ fileId }: OnsetLegendProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

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

      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!spectrogramData) return;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      if (!(totalDuration > 0)) return;

      const state = useStore.getState();
      const zoom = state.filesZoom[fileId] ?? 0;
      const offset = state.filesOffset[fileId] ?? 0;

      for (const onset of getFileOnsets(fileId)) {
        const screenX = zoomedToScreen(new Vector2(onset.timeSec / totalDuration, 0.5), zoom, offset).x;
        if (screenX < 0 || screenX > 1) continue;
        ctx.fillStyle = `rgba(${MARKER_COLOR}, ${MIN_ALPHA + (1 - MIN_ALPHA) * onset.strength})`;
        ctx.fillRect(screenX * width - MARKER_WIDTH_PX / 2, 0, MARKER_WIDTH_PX, height);
      }
    };

    const file = openFiles[fileId];
    const unsubscribe = useStore.subscribe(
      (state) => ({
        zoom: state.filesZoom[fileId],
        offset: state.filesOffset[fileId],
        sensitivity: file && state.filepathsOnsetSensitivity[file.filePath],
        // Not store state, but read here so a re-detection or a synthesis that
        // returns new onsets repaints on the store update that comes with it.
        onsets: openFiles[fileId]?.onsets,
        loading: state.filesLoading[fileId],
      }),
      draw,
      { equalityFn: shallow, fireImmediately: true },
    );

    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [fileId]);

  return (
    <Box
      ref={containerRef}
      style={{
        width: "100%",
        height: ONSET_LEGEND_HEIGHT,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
        position: "relative",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </Box>
  );
});

OnsetLegend.displayName = "OnsetLegend";
