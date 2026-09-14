/** A colour as three components in 0..1, the way the display shader wants it. */
export type Rgb = [number, number, number];

/** The hue pair a layer paints its left and right channels in. */
export interface LayerTint {
  left: Rgb;
  right: Rgb;
}

// The picture is two hues a spread apart either side of a centre. Left and
// right therefore add towards the centre hue, and the layers of a stack add
// towards white where they overlap.
const CENTRE_HUE = 120;
const LONE_SPREAD = 90;

// The widest a stack's hues may lean before neighbours meet: two fifths of the
// gap between one layer's hue and the next.
const SPREAD_SHARE = 0.4;

/** Fully saturated colour at `hue` degrees. */
export function hueToRgb(hue: number): Rgb {
  const sector = (((hue % 360) + 360) % 360) / 60;
  const ramp = 1 - Math.abs((sector % 2) - 1);
  if (sector < 1) return [1, ramp, 0];
  if (sector < 2) return [ramp, 1, 0];
  if (sector < 3) return [0, 1, ramp];
  if (sector < 4) return [0, ramp, 1];
  if (sector < 5) return [ramp, 0, 1];
  return [1, 0, ramp];
}

/**
 * The hue pair for layer `index` of a stack of `count`. A lone layer is the
 * orange and blue the picture has always used; its two halves add to white.
 * A stack fans its layers around the wheel and narrows the spread so no two
 * layers' hues meet.
 */
export function layerTint(index: number, count: number): LayerTint {
  const layers = Math.max(1, count);
  const hue = layers > 1 ? CENTRE_HUE + (index * 360) / layers : CENTRE_HUE;
  const spread = layers > 1 ? Math.min(LONE_SPREAD, (SPREAD_SHARE * 360) / layers) : LONE_SPREAD;
  return { left: hueToRgb(hue - spread), right: hueToRgb(hue + spread) };
}

/** What a layer with nothing behind it paints in. */
export const LONE_LAYER_TINT: LayerTint = layerTint(0, 1);

/** Removes hue from a background layer while retaining each channel's luminance. */
export function greyscaleTint(tint: LayerTint): LayerTint {
  const grey = ([r, g, b]: Rgb): Rgb => {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [luminance, luminance, luminance];
  };
  return { left: grey(tint.left), right: grey(tint.right) };
}
