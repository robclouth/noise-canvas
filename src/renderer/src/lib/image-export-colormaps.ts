import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from "three";

/**
 * Colour ramps for image export. "native" reproduces the editor's own look
 * (grey for mono, orange/blue channel tint for stereo) and has no ramp; the
 * others are perceptual ramps sampled as evenly spaced sRGB control points and
 * interpolated into a 256-entry LUT.
 */
export type ColormapId = "native" | "mono" | "magma" | "viridis" | "ice" | "random";

export interface ColormapDef {
  id: ColormapId;
  label: string;
  /**
   * Evenly spaced sRGB control points from the floor to the peak. Empty for
   * "native", which has no ramp, and for "random", whose points are generated.
   */
  anchors: string[];
}

export const COLORMAPS: readonly ColormapDef[] = [
  { id: "native", label: "Editor", anchors: [] },
  { id: "mono", label: "Mono", anchors: ["#000000", "#2a2a2a", "#595959", "#8d8d8d", "#c4c4c4", "#ffffff"] },
  {
    id: "magma",
    label: "Magma",
    anchors: ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55964", "#fb8761", "#fec287", "#fcfdbf"],
  },
  {
    id: "viridis",
    label: "Viridis",
    anchors: ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"],
  },
  {
    id: "ice",
    label: "Ice",
    anchors: ["#00030a", "#0a1c3d", "#12406e", "#1a6f96", "#3aa0ad", "#7fcfc4", "#cdeee8", "#ffffff"],
  },
  { id: "random", label: "Random", anchors: [] },
] as const;

const LUT_SIZE = 256;
/** Enough control points that a multi-stop hue path resolves as a smooth sweep. */
export const RANDOM_ANCHOR_COUNT = 15;

function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Expands evenly spaced control points into a 256-entry RGBA ramp. Blending
 * happens on the stored sRGB values, matching how the source colour maps are
 * tabulated, so the LUT tracks their published appearance.
 */
export function buildColormapLut(anchors: string[]): Uint8Array {
  const out = new Uint8Array(LUT_SIZE * 4);
  const points = anchors.map(parseHex);
  const segments = Math.max(points.length - 1, 1);

  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const scaled = t * segments;
    const lo = Math.min(Math.floor(scaled), segments - 1);
    const frac = scaled - lo;
    const a = points[lo];
    const b = points[Math.min(lo + 1, points.length - 1)];
    out[i * 4 + 0] = Math.round(a[0] + (b[0] - a[0]) * frac);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function hslToHex(h: number, s: number, l: number): string {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [chroma, x, 0]
      : hp < 2
        ? [x, chroma, 0]
        : hp < 3
          ? [0, chroma, x]
          : hp < 4
            ? [0, x, chroma]
            : hp < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  const channel = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v + m)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`;
}

function relativeLuma(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The lightness at which a hue reaches a given luminance. Luminance rises
 * monotonically with HSL lightness at a fixed hue and saturation, so a bisection
 * lands on it exactly.
 */
function lightnessForLuma(hue: number, saturation: number, targetLuma: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (relativeLuma(hslToHex(hue, saturation, mid)) < targetLuma) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * A fresh ramp that wanders: four to six hue stops, each a long jump from the
 * last in either direction, with saturation shifting between them. What holds it
 * together is the luminance, which climbs on the same fixed curve the shipped
 * ramps follow — solving lightness for a target luminance rather than setting it
 * directly means the hue path can go anywhere without the ramp stalling in dark
 * hues like blue or washing out to white in bright ones.
 */
export function randomColormapAnchors(): string[] {
  const stopCount = 4 + Math.floor(Math.random() * 3);
  const hues: number[] = [Math.random() * 360];
  const saturations: number[] = [];
  for (let k = 0; k < stopCount; k++) {
    if (k > 0) hues.push(hues[k - 1] + (60 + Math.random() * 180) * (Math.random() < 0.5 ? -1 : 1));
    saturations.push(0.6 + Math.random() * 0.4);
  }
  const peakLuma = 215 + Math.random() * 33;

  const anchors: string[] = [];
  for (let i = 0; i < RANDOM_ANCHOR_COUNT; i++) {
    const t = i / (RANDOM_ANCHOR_COUNT - 1);
    const position = t * (stopCount - 1);
    const stop = Math.min(Math.floor(position), stopCount - 2);
    const blend = position - stop;
    const hue = hues[stop] + (hues[stop + 1] - hues[stop]) * blend;
    const saturation = saturations[stop] + (saturations[stop + 1] - saturations[stop]) * blend;
    const targetLuma = peakLuma * Math.pow(t, 1.4);
    anchors.push(hslToHex(hue, saturation, lightnessForLuma(hue, saturation, targetLuma)));
  }
  return anchors;
}

let randomAnchors = randomColormapAnchors();

/** The control points a colormap is built from. Empty for "native". */
export function colormapAnchors(id: ColormapId): string[] {
  if (id === "random") return randomAnchors;
  return COLORMAPS.find((c) => c.id === id)?.anchors ?? [];
}

const lutTextures = new Map<ColormapId, DataTexture>();

/** The LUT texture for a colormap, built once and cached. Null for "native". */
export function getColormapTexture(id: ColormapId): DataTexture | null {
  const anchors = colormapAnchors(id);
  if (anchors.length === 0) return null;

  const cached = lutTextures.get(id);
  if (cached) return cached;

  const tex = new DataTexture(buildColormapLut(anchors), LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  lutTextures.set(id, tex);
  return tex;
}

/** The hue of a colour, or null when it is a neutral grey. */
function hexToHue(hex: string): number | null {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

/** Where along a ramp its defining hue sits — past the floor, before the peak washes out. */
const MOUNT_SAMPLE_POSITION = 0.35;
const MOUNT_SATURATION = 0.22;
const MOUNT_LIGHTNESS = 0.145;

/**
 * The poster mount for a colormap: that ramp's own hue pulled down to a dark,
 * mostly-desaturated grey. Light enough for the plot's drop shadow to read
 * against, tinted enough to belong to the image it surrounds. Neutral for
 * "Editor" and "Mono", which have no hue of their own.
 */
export function colormapMountColor(id: ColormapId): string {
  const anchors = colormapAnchors(id);
  if (anchors.length === 0) return hslToHex(0, 0, MOUNT_LIGHTNESS);
  const hue = hexToHue(anchors[Math.round(MOUNT_SAMPLE_POSITION * (anchors.length - 1))]);
  return hue === null ? hslToHex(0, 0, MOUNT_LIGHTNESS) : hslToHex(hue, MOUNT_SATURATION, MOUNT_LIGHTNESS);
}

/** Draws a new random ramp and drops the LUT built from the previous one. */
export function rerollRandomColormap(): void {
  randomAnchors = randomColormapAnchors();
  lutTextures.get("random")?.dispose();
  lutTextures.delete("random");
}
