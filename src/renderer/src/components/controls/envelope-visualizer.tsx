import { Box } from "@mantine/core";
import { selectParameter, useStore } from "@renderer/store";
import { brushEnvelopeShape } from "@renderer/lib/brush-envelope";
import { useEffect, useRef } from "react";

interface EnvelopeVisualizerProps {
  height?: number;
}

const WIDTH = 256;

export const EnvelopeVisualizer = ({ height = 80 }: EnvelopeVisualizerProps) => {
  const curveTime = useStore(selectParameter("brushCurveTime")) as number;
  const skewTime = useStore(selectParameter("brushSkewTime")) as number;
  const curvePitch = useStore(selectParameter("brushCurvePitch")) as number;
  const skewPitch = useStore(selectParameter("brushSkewPitch")) as number;
  const intensity = useStore(selectParameter("brushIntensity")) as number;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.createImageData(w, h);
    const data = img.data;

    const curveX = curveTime / 100;
    const skewX = (skewTime + 100) / 200;
    const curveY = curvePitch / 100;
    const skewY = (skewPitch + 100) / 200;

    const xProfile = new Float32Array(w);
    for (let i = 0; i < w; i++) {
      xProfile[i] = brushEnvelopeShape(i / (w - 1), curveX, skewX);
    }
    const yProfile = new Float32Array(h);
    for (let j = 0; j < h; j++) {
      const t = 1 - j / (h - 1);
      yProfile[j] = brushEnvelopeShape(t, curveY, skewY);
    }

    const scale = Math.max(0, Math.min(1, intensity / 100));

    for (let j = 0; j < h; j++) {
      const yv = yProfile[j];
      const rowOffset = j * w * 4;
      for (let i = 0; i < w; i++) {
        const v = Math.round(xProfile[i] * yv * scale * 255);
        const k = rowOffset + i * 4;
        data[k] = v;
        data[k + 1] = v;
        data[k + 2] = v;
        data[k + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [curveTime, skewTime, curvePitch, skewPitch, intensity]);

  return (
    <Box
      style={{
        width: "100%",
        height: `${height}px`,
        borderRadius: "4px",
        overflow: "hidden",
        border: "1px solid var(--mantine-color-dark-4)",
        background: "#000",
      }}
    >
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={height}
        style={{ display: "block", width: "100%", height: "100%", imageRendering: "auto" }}
      />
    </Box>
  );
};
