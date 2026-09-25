import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { memo, useEffect, useRef } from "react";
import { Vector2 } from "three";
import { shallow } from "zustand/shallow";
import { getMaxPyramid, queryMax } from "../lib/max-pyramid";
import { screenToZoomed } from "../lib/utils";
import { LEVEL_STRIP_HEIGHT } from "@renderer/lib/file-view-metrics";

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

/**
 * Colour for one slice, written as RGB at `at`: dark to white with level,
 * warming to yellow near full scale, then reddening with how far the slice ran
 * out of headroom.
 */
function writeLevelColor(peak: number, overDb: number, out: Uint8ClampedArray, at: number): void {
  const db = 20 * Math.log10(Math.max(peak, 1e-7));

  let from = FLOOR_COLOR;
  let to = FLOOR_COLOR;
  let t = 0;
  if (db > FLOOR_DB && db < HOT_DB) {
    from = FLOOR_COLOR;
    to = FULL_COLOR;
    t = (db - FLOOR_DB) / (HOT_DB - FLOOR_DB);
  } else if (db >= HOT_DB) {
    from = FULL_COLOR;
    to = HOT_COLOR;
    t = Math.min(1, (db - HOT_DB) / -HOT_DB);
  }
  const red = overDb > 0 ? Math.min(1, overDb / OVER_FULL_RED_DB) : 0;
  for (let channel = 0; channel < 3; channel++) {
    const level = Math.round(from[channel] + (to[channel] - from[channel]) * t);
    out[at + channel] = red > 0 ? Math.round(level + (CLIP_COLOR[channel] - level) * red) : level;
  }
  out[at + 3] = 255;
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
  const imageRef = useRef<ImageData | null>(null);

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

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const levels = openFiles[fileId]?.outputLevels;
      if (!levels || levels.peaks.length === 0) return;

      const state = useStore.getState();
      const zoom = state.filesZoom[fileId] ?? 0;
      const offset = state.filesOffset[fileId] ?? 0;
      const points = levels.peaks.length;

      const windowStart = screenToZoomed(new Vector2(0, 0.5), zoom, offset).x;
      const windowEnd = screenToZoomed(new Vector2(1, 0.5), zoom, offset).x;
      const windowSpan = windowEnd - windowStart;
      const peakPyramid = getMaxPyramid(levels.peaks);
      const overDbPyramid = getMaxPyramid(levels.overDb);

      const columns = canvas.width;
      let image = imageRef.current;
      if (!image || image.width !== columns || image.height !== canvas.height) {
        image = ctx.createImageData(columns, canvas.height);
        imageRef.current = image;
      }
      const pixels = image.data;
      pixels.fill(0, 0, columns * 4);
      // One column per device pixel, carrying the loudest slice it covers so a
      // single overloaded hop survives being zoomed out.
      for (let x = 0; x < columns; x++) {
        const uvStart = windowStart + (x / columns) * windowSpan;
        const uvEnd = windowStart + ((x + 1) / columns) * windowSpan;
        if (uvEnd < 0 || uvStart > 1) continue;

        const first = Math.max(0, Math.floor(uvStart * points));
        const last = Math.min(points - 1, Math.max(first, Math.ceil(uvEnd * points) - 1));
        writeLevelColor(queryMax(peakPyramid, first, last), queryMax(overDbPyramid, first, last), pixels, x * 4);
      }
      for (let row = 1; row < canvas.height; row++) pixels.copyWithin(row * columns * 4, 0, columns * 4);
      ctx.putImageData(image, 0, 0);
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
        busy: state.filesBusy[fileId],
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
