import type { MantineTheme } from "@mantine/core";
import type { BrushColor } from "@renderer/store/types";

export const BASE_HUES = [
  "grape",
  "red",
  "yellow",
  "green",
  "violet",
  "cyan",
  "pink",
  "orange",
  "indigo",
  "teal",
] as const;

export type BaseHue = (typeof BASE_HUES)[number];

// Variations are ordered from most-distinguishable primary row to
// secondary/lighter rows. None are dark enough to read as black or low-contrast.
export const PALETTE_VARIATIONS: readonly { shade: number; saturation: number }[] = [
  { shade: 5, saturation: 1.0 }, // primary vivid
  { shade: 3, saturation: 1.0 }, // light pastel
];

const keyOf = (c: BrushColor) => `${c.hue}:${c.variation}`;

/**
 * Picks the next brush color in palette order: all hues at variation 0,
 * then all hues at variation 1, etc. Falls through to variation 0 of the
 * first hue once every combination is used.
 */
export function pickNextBrushColor(existing: BrushColor[]): BrushColor {
  const usedKeys = new Set(existing.map(keyOf));
  for (let variation = 0; variation < PALETTE_VARIATIONS.length; variation++) {
    for (const hue of BASE_HUES) {
      const color: BrushColor = { hue, variation };
      if (!usedKeys.has(keyOf(color))) return color;
    }
  }
  return { hue: BASE_HUES[0], variation: 0 };
}

export const STEP_HUES: readonly BaseHue[] = ["red", "yellow", "green", "cyan", "violet"] as const;

export function pickNextStepColor(existing: (BrushColor | undefined)[]): BrushColor {
  const usedHues = new Set(existing.filter((c): c is BrushColor => !!c).map((c) => c.hue));
  for (const hue of STEP_HUES) {
    if (!usedHues.has(hue)) return { hue, variation: 0 };
  }
  return { hue: STEP_HUES[0], variation: 0 };
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

export function resolveBrushColor(color: BrushColor, theme: MantineTheme): string {
  const variation = PALETTE_VARIATIONS[color.variation] ?? PALETTE_VARIATIONS[0];
  const hueColors = theme.colors[color.hue];
  const base = hueColors?.[variation.shade] ?? hueColors?.[6] ?? "#888888";

  if (variation.saturation >= 0.999) return base;

  const { r, g, b } = parseHex(base);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newS = Math.max(0, Math.min(1, s * variation.saturation));
  return `hsl(${h.toFixed(1)}, ${(newS * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}
