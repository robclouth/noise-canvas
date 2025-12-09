import { Box } from "@mantine/core";
import { useStore } from "@renderer/store";
import { useMemo } from "react";

interface EnvelopeVisualizerProps {
  height?: number;
}

// Generate gradient stops for an envelope
function generateEnvelopeGradient(
  delay: number,
  attack: number,
  sustain: number,
  release: number,
  intensity: number,
): string {
  const total = delay + attack + sustain + release;
  if (total === 0) return "transparent";

  // Normalize stages to percentages
  const d = (delay / total) * 100;
  const a = (attack / total) * 100;
  const s = (sustain / total) * 100;
  const r = (release / total) * 100;

  const delayEnd = d;
  const attackEnd = d + a;
  const sustainEnd = d + a + s;
  const releaseEnd = d + a + s + r;

  // Adjust intensity (0-100 to color value)
  const maxBrightness = Math.floor((intensity / 100) * 255);
  const peakColor = `rgb(${maxBrightness}, ${maxBrightness}, ${maxBrightness})`;

  const stops: string[] = [];

  // Delay phase (stays at 0)
  if (delay > 0) {
    stops.push(`rgb(0, 0, 0) 0%`);
    stops.push(`rgb(0, 0, 0) ${delayEnd}%`);
  }

  // Attack phase (ramp up)
  stops.push(`rgb(0, 0, 0) ${delayEnd}%`);
  stops.push(`${peakColor} ${attackEnd}%`);

  // Sustain phase (stays at peak)
  if (sustain > 0) {
    stops.push(`${peakColor} ${sustainEnd}%`);
  }

  // Release phase (ramp down)
  stops.push(`rgb(0, 0, 0) ${releaseEnd}%`);

  return stops.join(", ");
}

export const EnvelopeVisualizer = ({ height = 80 }: EnvelopeVisualizerProps) => {
  // Subscribe to envelope parameters
  const delayTime = useStore((state) => state.brushEnvelopeDelayTime);
  const attackTime = useStore((state) => state.brushEnvelopeAttackTime);
  const sustainTime = useStore((state) => state.brushEnvelopeSustainTime);
  const releaseTime = useStore((state) => state.brushEnvelopeReleaseTime);
  const delayPitch = useStore((state) => state.brushEnvelopeDelayPitch);
  const attackPitch = useStore((state) => state.brushEnvelopeAttackPitch);
  const sustainPitch = useStore((state) => state.brushEnvelopeSustainPitch);
  const releasePitch = useStore((state) => state.brushEnvelopeReleasePitch);
  const intensity = useStore((state) => state.brushIntensity);

  // Generate gradients
  const horizontalGradient = useMemo(() => {
    const stops = generateEnvelopeGradient(delayTime, attackTime, sustainTime, releaseTime, intensity);
    return `linear-gradient(to right, ${stops})`;
  }, [delayTime, attackTime, sustainTime, releaseTime, intensity]);

  const verticalGradient = useMemo(() => {
    const stops = generateEnvelopeGradient(delayPitch, attackPitch, sustainPitch, releasePitch, intensity);
    return `linear-gradient(to top, ${stops})`;
  }, [delayPitch, attackPitch, sustainPitch, releasePitch, intensity]);

  return (
    <Box
      style={{
        width: "100%",
        height: `${height}px`,
        borderRadius: "4px",
        overflow: "hidden",
        border: "1px solid var(--mantine-color-dark-4)",
        background: `${horizontalGradient}, ${verticalGradient}`,
        backgroundBlendMode: "multiply",
      }}
    />
  );
};
