/**
 * Poster layout: the spectrogram floated on a light-grey mount with a soft drop
 * shadow, and the file's name set in the band below it. The plate's dimensions
 * derive from the image's shorter edge, so it looks the same at 2K and at 8K,
 * except for the clear space under the title, which follows the image height so
 * the title stays above the bottom of a story-shaped crop.
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
  titleSize: number;
  /** Centre line of the title, for a "middle" text baseline. */
  titleY: number;
}

const TITLE_COLOR = "rgba(255, 255, 255, 0.94)";
const SHADOW_COLOR = "rgba(0, 0, 0, 0.85)";
const FONT_STACK = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif';

const MARGIN_FRACTION = 0.085;
const TITLE_FRACTION = 0.043;
/** Instagram keeps its own overlays inside the bottom 250 px of a 1080x1920 story. */
const BOTTOM_SAFE_FRACTION = 0.13;
const SHADOW_BLUR_FRACTION = 0.032;
const SHADOW_OFFSET_FRACTION = 0.013;

export function computePosterLayout(width: number, height: number): PosterLayout {
  const shortEdge = Math.min(width, height);
  const margin = Math.round(shortEdge * MARGIN_FRACTION);
  const titleSize = Math.round(shortEdge * TITLE_FRACTION);
  const captionH = margin + titleSize + Math.round(height * BOTTOM_SAFE_FRACTION);
  const plotY = margin;
  const plotH = Math.max(2, height - margin - captionH);
  return {
    width,
    height,
    plotX: margin,
    plotY,
    plotW: Math.max(2, width - margin * 2),
    plotH,
    margin,
    captionH,
    titleSize,
    titleY: plotY + plotH + margin + titleSize / 2,
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
  const { width, height, plotX, plotY, plotW, plotH, titleSize, titleY } = layout;
  const shortEdge = Math.min(width, height);

  ctx.fillStyle = mountColor;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = shortEdge * SHADOW_BLUR_FRACTION;
  ctx.shadowOffsetY = shortEdge * SHADOW_OFFSET_FRACTION;
  ctx.drawImage(plot, plotX, plotY, plotW, plotH);
  ctx.restore();

  ctx.fillStyle = TITLE_COLOR;
  ctx.font = `600 ${titleSize}px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(info.title, plotX, titleY);
}
