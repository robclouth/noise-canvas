import type { BrushEnvelopeShapeParams } from "./brush-envelope";

export interface EnvelopePreset extends BrushEnvelopeShapeParams {
  id: string;
  name: string;
  /** What the shape does to a stroke, in terms of the sound. */
  description: string;
}

/**
 * Starting points for the brush envelope. Each one sets only the curve and skew
 * of both axes — brush size, strength and anchor are left alone so a preset can
 * be dropped onto an existing brush without resizing it.
 */
export const ENVELOPE_PRESETS: EnvelopePreset[] = [
  {
    id: "block",
    name: "Block",
    description: "Hard-edged rectangle. The effect applies at full strength everywhere inside the brush.",
    curveTime: 100,
    skewTime: -100,
    curvePitch: 100,
    skewPitch: -100,
  },
  {
    id: "soft",
    name: "Soft",
    description: "Rounded edges on all four sides. The usual choice for blending an edit into its surroundings.",
    curveTime: 40,
    skewTime: 0,
    curvePitch: 40,
    skewPitch: 0,
  },
  {
    id: "bell",
    name: "Bell",
    description: "Smooth hump peaking at the centre of the brush in both axes.",
    curveTime: 0,
    skewTime: 0,
    curvePitch: 0,
    skewPitch: 0,
  },
  {
    id: "spike",
    name: "Spike",
    description: "Tight point at the centre with a long falloff. Concentrates the effect on one spot.",
    curveTime: -70,
    skewTime: 0,
    curvePitch: -70,
    skewPitch: 0,
  },
  {
    id: "pluck",
    name: "Pluck",
    description: "Instant attack at the stroke's start decaying over its length — percussive hits and plucks.",
    curveTime: -60,
    skewTime: -100,
    curvePitch: 100,
    skewPitch: -100,
  },
  {
    id: "swell",
    name: "Swell",
    description: "Builds from nothing to full strength at the end of the stroke — reverse hits and risers.",
    curveTime: -60,
    skewTime: 100,
    curvePitch: 100,
    skewPitch: -100,
  },
  {
    id: "fade-out",
    name: "Fade Out",
    description: "Straight ramp from full strength down to nothing across the stroke.",
    curveTime: 0,
    skewTime: -100,
    curvePitch: 100,
    skewPitch: -100,
  },
  {
    id: "fade-in",
    name: "Fade In",
    description: "Straight ramp from nothing up to full strength across the stroke.",
    curveTime: 0,
    skewTime: 100,
    curvePitch: 100,
    skewPitch: -100,
  },
  {
    id: "low-weighted",
    name: "Low",
    description: "Even across time, strongest at the bottom of the brush and fading upwards.",
    curveTime: 100,
    skewTime: -100,
    curvePitch: -30,
    skewPitch: -100,
  },
  {
    id: "high-weighted",
    name: "High",
    description: "Even across time, strongest at the top of the brush and fading downwards.",
    curveTime: 100,
    skewTime: -100,
    curvePitch: -30,
    skewPitch: 100,
  },
  {
    id: "band",
    name: "Band",
    description: "Full width in time, narrowing to a band around the centre pitch.",
    curveTime: 100,
    skewTime: -100,
    curvePitch: -40,
    skewPitch: 0,
  },
  {
    id: "stab",
    name: "Stab",
    description: "Short burst at the stroke's start across a soft band of pitches.",
    curveTime: -80,
    skewTime: -100,
    curvePitch: 20,
    skewPitch: 0,
  },
];
