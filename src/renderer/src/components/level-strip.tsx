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
/** dB past headroom at which a slice reads fully red. */
const OVER_FULL_RED_DB = 2;

const FLOOR_COLOR = [22, 22, 26];
const FULL_COLOR = [236, 236, 242];
const HOT_COLOR = [250, 205, 60];
const CLIP_COLOR = [255, 58, 44];

function mixColor(from: number[], to: number[], t: number): number[] {
  return from.map((value, channel) => Math.round(value + (to[channel] - value) * t));
}

/**
 * Colour for one slice: dark to white with level, warming to yellow near full
 * scale, then reddening with how far the slice ran out of headroom.
 */
function levelColor(peak: number, overDb: number): string {
  const db = 20 * Math.log10(Math.max(peak, 1e-7));

  let rgb: number[];
  if (db <= FLOOR_DB) {
    rgb = FLOOR_COLOR;
  } else if (db < HOT_DB) {
    rgb = mixColor(FLOOR_COLOR, FULL_COLOR, (db - FLOOR_DB) / (HOT_DB - FLOOR_DB));
  } else {
    rgb = mixColor(FULL_COLOR, HOT_COLOR, Math.min(1, (db - HOT_DB) / -HOT_DB));
  }

  if (overDb > 0) rgb = mixColor(rgb, CLIP_COLOR, Math.min(1, overDb / OVER_FULL_RED_DB));
  return `rgb(${rgb.join(",")})`;
}

interface LevelStripProps {
  fileId: string;
}

/**
 * A strip above the spectrogram carrying the synthesized output's peak level
 * against time, reddening with how far it ran out of headroom.
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
        let overDb = 0;
        for (let point = first; point <= last; point++) {
          if (levels.peaks[point] > peak) peak = levels.peaks[point];
          if (levels.overDb[point] > overDb) overDb = levels.overDb[point];
        }

        ctx.fillStyle = levelColor(peak, overDb);
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
