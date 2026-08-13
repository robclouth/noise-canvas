import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useEffect, useRef } from "react";
import { Vector2 } from "three";
import { shallow } from "zustand/shallow";
import { screenToZoomed } from "../lib/utils";
import { ONSET_LEGEND_HEIGHT } from "./onset-legend";

const LEVEL_STRIP_HEIGHT = Math.round(ONSET_LEGEND_HEIGHT / 2);

/** Level the ramp starts to lift off the floor. */
const FLOOR_DB = -60;
/** Level the ramp reaches white, above which it warms towards yellow. */
const HOT_DB = -6;

const FLOOR_COLOR = [22, 22, 26];
const FULL_COLOR = [236, 236, 242];
const HOT_COLOR = [250, 205, 60];
const CLIP_COLOR = [255, 58, 44];

function mixChannel(from: number[], to: number[], t: number, channel: number): number {
  return Math.round(from[channel] + (to[channel] - from[channel]) * t);
}

/** Colour for one slice: dark to white with level, warming to yellow near full scale. */
function levelColor(peak: number): string {
  const db = 20 * Math.log10(Math.max(peak, 1e-7));
  if (db <= FLOOR_DB) return `rgb(${FLOOR_COLOR.join(",")})`;

  if (db < HOT_DB) {
    const t = (db - FLOOR_DB) / (HOT_DB - FLOOR_DB);
    return `rgb(${mixChannel(FLOOR_COLOR, FULL_COLOR, t, 0)},${mixChannel(FLOOR_COLOR, FULL_COLOR, t, 1)},${mixChannel(FLOOR_COLOR, FULL_COLOR, t, 2)})`;
  }

  const t = Math.min(1, (db - HOT_DB) / -HOT_DB);
  return `rgb(${mixChannel(FULL_COLOR, HOT_COLOR, t, 0)},${mixChannel(FULL_COLOR, HOT_COLOR, t, 1)},${mixChannel(FULL_COLOR, HOT_COLOR, t, 2)})`;
}

interface LevelStripProps {
  fileId: string;
}

/**
 * A strip above the spectrogram carrying the synthesized output's peak level
 * against time, red wherever it ran out of headroom.
 */
export const LevelStrip = memo(({ fileId }: LevelStripProps) => {
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

      const levels = openFiles[fileId]?.outputLevels;
      if (!levels || levels.peaks.length === 0) return;

      const state = useStore.getState();
      const zoom = state.filesZoom[fileId] ?? 0;
      const offset = state.filesOffset[fileId] ?? 0;
      const points = levels.peaks.length;

      // One column per pixel, carrying the loudest slice it covers so a single
      // overloaded hop survives being zoomed out.
      for (let x = 0; x < width; x++) {
        const uvStart = screenToZoomed(new Vector2(x / width, 0.5), zoom, offset).x;
        const uvEnd = screenToZoomed(new Vector2((x + 1) / width, 0.5), zoom, offset).x;
        if (uvEnd < 0 || uvStart > 1) continue;

        const first = Math.max(0, Math.floor(uvStart * points));
        const last = Math.min(points - 1, Math.max(first, Math.ceil(uvEnd * points) - 1));

        let peak = 0;
        let clipped = false;
        for (let point = first; point <= last; point++) {
          if (levels.peaks[point] > peak) peak = levels.peaks[point];
          if (levels.clipped[point]) clipped = true;
        }

        ctx.fillStyle = clipped ? `rgb(${CLIP_COLOR.join(",")})` : levelColor(peak);
        ctx.fillRect(x, 0, 1, height);
      }
    };

    const unsubscribe = useStore.subscribe(
      (state) => ({
        zoom: state.filesZoom[fileId],
        offset: state.filesOffset[fileId],
        // Not store state, but read here so the pass that replaces the levels
        // repaints on the store update that comes with it. Keyed on identity,
        // so every writer must hand over a new object rather than edit this one.
        levels: openFiles[fileId]?.outputLevels,
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
        height: LEVEL_STRIP_HEIGHT,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        position: "relative",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </Box>
  );
});

LevelStrip.displayName = "LevelStrip";
