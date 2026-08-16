import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useEffect, useRef } from "react";
import { shallow } from "zustand/shallow";
import { getFileOnsets } from "../lib/file-onsets";
import { getMaxPyramid, queryMax } from "../lib/max-pyramid";
import { getOnsetStrengthBins } from "../lib/onset-map";
import { screenToZoomed } from "../lib/utils";
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

      const windowStart = screenToZoomed(new Vector2(0, 0.5), zoom, offset).x;
      const windowEnd = screenToZoomed(new Vector2(1, 0.5), zoom, offset).x;
      const windowSpan = windowEnd - windowStart || 1;

      const onsets = getFileOnsets(fileId);

      // Binary-search the visible slice; onsets are sorted by time.
      const startSec = windowStart * totalDuration;
      const endSec = windowEnd * totalDuration;
      let lo = 0;
      let hi = onsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (onsets[mid].timeSec < startSec) lo = mid + 1;
        else hi = mid;
      }
      const firstVisible = lo;
      hi = onsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (onsets[mid].timeSec <= endSec) lo = mid + 1;
        else hi = mid;
      }
      const endVisible = lo;

      const drawMarker = (screenX: number, strength: number) => {
        ctx.fillStyle = `rgba(${MARKER_COLOR}, ${MIN_ALPHA + (1 - MIN_ALPHA) * strength})`;
        ctx.fillRect(screenX * width - MARKER_WIDTH_PX / 2, 0, MARKER_WIDTH_PX, height);
      };

      if (endVisible - firstVisible <= width * 2) {
        for (let i = firstVisible; i < endVisible; i++) {
          drawMarker((onsets[i].timeSec / totalDuration - windowStart) / windowSpan, onsets[i].strength);
        }
      } else {
        // Denser than the pixel grid: draw each column's strongest hit.
        const bins = getOnsetStrengthBins(onsets, totalDuration);
        const pyramid = getMaxPyramid(bins);
        const binCount = bins.length;
        for (let x = 0; x < width; x++) {
          const uvStart = windowStart + (x / width) * windowSpan;
          const uvEnd = windowStart + ((x + 1) / width) * windowSpan;
          const first = Math.max(0, Math.floor(uvStart * binCount));
          const last = Math.min(binCount - 1, Math.max(first, Math.ceil(uvEnd * binCount) - 1));
          const strength = queryMax(pyramid, first, last);
          if (strength > 0) drawMarker((x + 0.5) / width, strength);
        }
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
