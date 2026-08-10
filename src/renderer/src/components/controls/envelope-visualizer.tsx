import { Box } from "@mantine/core";
import { selectParameter, useStore } from "@renderer/store";
import { renderBrushEnvelope } from "@renderer/lib/brush-envelope";
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
    renderBrushEnvelope(img.data, w, h, { curveTime, skewTime, curvePitch, skewPitch }, intensity);

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
