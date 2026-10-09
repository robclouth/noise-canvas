/** A colour as three components in 0..1, the way the display shader wants it. */
export type Rgb = [number, number, number];

/** The hue pair a layer paints its left and right channels in. */
export interface LayerTint {
  left: Rgb;
  right: Rgb;
}

/** The orange and blue every layer paints its left and right channels in. The two add to white. */
export const STEREO_TINT: LayerTint = { left: [1, 0.5, 0], right: [0, 0.5, 1] };

/** Removes hue from a background layer while retaining each channel's luminance. */
export function greyscaleTint(tint: LayerTint): LayerTint {
  const grey = ([r, g, b]: Rgb): Rgb => {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [luminance, luminance, luminance];
  };
  return { left: grey(tint.left), right: grey(tint.right) };
}
