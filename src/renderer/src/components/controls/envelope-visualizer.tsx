import { Box } from "@mantine/core";
import { selectParameter, useStore } from "@renderer/store";
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
  // Subscribe to envelope parameters from active step
  const delayTime = useStore(selectParameter("brushEnvelopeDelayTime")) as number;
  const attackTime = useStore(selectParameter("brushEnvelopeAttackTime")) as number;
  const sustainTime = useStore(selectParameter("brushEnvelopeSustainTime")) as number;
  const releaseTime = useStore(selectParameter("brushEnvelopeReleaseTime")) as number;
  const delayPitch = useStore(selectParameter("brushEnvelopeDelayPitch")) as number;
  const attackPitch = useStore(selectParameter("brushEnvelopeAttackPitch")) as number;
  const sustainPitch = useStore(selectParameter("brushEnvelopeSustainPitch")) as number;
  const releasePitch = useStore(selectParameter("brushEnvelopeReleasePitch")) as number;
  const intensity = useStore(selectParameter("brushIntensity")) as number;

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
