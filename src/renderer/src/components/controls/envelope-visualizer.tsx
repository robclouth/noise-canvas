import { Box } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useEffect, useRef } from "react";

interface EnvelopeVisualizerProps {
  delayX: number;
  attackX: number;
  sustainX: number;
  releaseX: number;
  delayY: number;
  attackY: number;
  sustainY: number;
  releaseY: number;
  intensity: number;
  height?: number;
}

// Calculate envelope gain at a normalized position (0-1)
function calculateGain(pos: number, delay: number, attack: number, sustain: number, release: number): number {
  const total = delay + attack + sustain + release;
  if (total === 0) return 0;

  // Normalize stages
  const d = delay / total;
  const a = attack / total;
  const s = sustain / total;
  const r = release / total;

  const delayEnd = d;
  const attackEnd = d + a;
  const sustainEnd = d + a + s;
  const releaseEnd = d + a + s + r;

  if (pos < delayEnd) {
    return 0;
  } else if (pos < attackEnd) {
    const attackDuration = a;
    if (attackDuration > 0) {
      const progress = (pos - delayEnd) / attackDuration;
      // Smoothstep
      const t = Math.max(0, Math.min(1, progress));
      return t * t * (3 - 2 * t);
    }
    return 1;
  } else if (pos < sustainEnd) {
    return 1;
  } else if (pos < releaseEnd) {
    const releaseDuration = r;
    if (releaseDuration > 0) {
      const progress = (pos - sustainEnd) / releaseDuration;
      // Smoothstep from 1 to 0
      const t = Math.max(0, Math.min(1, progress));
      return 1 - t * t * (3 - 2 * t);
    }
    return 0;
  }
  return 0;
}

export const EnvelopeVisualizer = ({
  delayX,
  attackX,
  sustainX,
  releaseX,
  delayY,
  attackY,
  sustainY,
  releaseY,
  intensity,
  height = 80,
}: EnvelopeVisualizerProps) => {
  const { ref: measureRef, width } = useElementSize();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = Math.floor(width * dpr);
    const canvasHeight = Math.floor(height * dpr);

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Create image data at full canvas resolution
    const imageData = ctx.createImageData(canvasWidth, canvasHeight);
    const data = imageData.data;

    // Normalize intensity (0-100 to 0-1)
    const intensityNormalized = intensity / 100;

    // Calculate envelope for each pixel
    for (let y = 0; y < canvasHeight; y++) {
      for (let x = 0; x < canvasWidth; x++) {
        const posX = x / canvasWidth;
        const posY = 1 - y / canvasHeight; // Flip Y so bottom is 0

        const gainX = calculateGain(posX, delayX, attackX, sustainX, releaseX);
        const gainY = calculateGain(posY, delayY, attackY, sustainY, releaseY);
        const combinedGain = gainX * gainY * intensityNormalized;

        const brightness = Math.floor(combinedGain * 255);
        const idx = (y * canvasWidth + x) * 4;
        data[idx] = brightness; // R
        data[idx + 1] = brightness; // G
        data[idx + 2] = brightness; // B
        data[idx + 3] = 255; // A
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, [delayX, attackX, sustainX, releaseX, delayY, attackY, sustainY, releaseY, intensity, width, height]);

  return (
    <Box
      ref={measureRef}
      style={{
        width: "100%",
        height: `${height}px`,
        borderRadius: "4px",
        overflow: "hidden",
        border: "1px solid var(--mantine-color-dark-4)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
    </Box>
  );
};
