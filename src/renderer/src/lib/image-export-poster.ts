/**
 * Poster layout: the spectrogram floated on a light-grey mount with a soft drop
 * shadow, and the file's name set in the band below it. Every dimension derives
 * from the image's shorter edge, so the plate looks the same at 2K and at 8K.
 */
export interface PosterLayout {
  width: number;
  height: number;
  plotX: number;
  plotY: number;
  plotW: number;
  plotH: number;
  margin: number;
  captionH: number;
}

const TITLE_COLOR = "rgba(255, 255, 255, 0.94)";
const SHADOW_COLOR = "rgba(0, 0, 0, 0.85)";
const FONT_STACK = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif';

const MARGIN_FRACTION = 0.055;
const CAPTION_FRACTION = 0.135;
const SHADOW_BLUR_FRACTION = 0.032;
const SHADOW_OFFSET_FRACTION = 0.013;

export function computePosterLayout(width: number, height: number): PosterLayout {
  const shortEdge = Math.min(width, height);
  const margin = Math.round(shortEdge * MARGIN_FRACTION);
  const captionH = Math.round(shortEdge * CAPTION_FRACTION);
  return {
    width,
    height,
    plotX: margin,
    plotY: margin,
    plotW: Math.max(2, width - margin * 2),
    plotH: Math.max(2, height - margin - captionH),
    margin,
    captionH,
  };
}

export interface PosterInfo {
  title: string;
}

/**
 * Draws the plot onto its mount and sets the title below it. `plot` must already
 * be rendered at the layout's plot size, and `mountColor` comes from the ramp the
 * plot was drawn with (see colormapMountColor).
 */
export function drawPoster(
  ctx: CanvasRenderingContext2D,
  plot: CanvasImageSource,
  layout: PosterLayout,
  info: PosterInfo,
  mountColor: string,
): void {
  const { width, height, plotX, plotY, plotW, plotH, captionH } = layout;
  const shortEdge = Math.min(width, height);

  ctx.fillStyle = mountColor;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = shortEdge * SHADOW_BLUR_FRACTION;
  ctx.shadowOffsetY = shortEdge * SHADOW_OFFSET_FRACTION;
  ctx.drawImage(plot, plotX, plotY, plotW, plotH);
  ctx.restore();

  // The title sits in the middle of the band the plot leaves below it.
  const titleSize = Math.round(captionH * 0.32);
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = `600 ${titleSize}px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(info.title, plotX, plotY + plotH + captionH / 2);
}
