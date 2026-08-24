import {
  buildWindowLayout,
  layoutPixelCount,
  windowAlignment,
  type PackedLayout,
  type WindowLayout,
} from "./window-layout";

/**
 * Packed texels a window may hold. The shaders address a texel by adding a
 * band's offset to a bin index in a float32, and above 2^24 that sum can no
 * longer count texels one at a time: several bins collapse onto one texel and
 * the display draws them as a block. A window under the ceiling addresses
 * exactly.
 */
export const EXACT_ADDRESS_PIXELS = 2 ** 24;

/** How far past the view the window reaches, and how large it may grow. */
export interface WindowPolicy {
  /** Slack held on each side of the view, as a fraction of the view's span. */
  marginFraction: number;
  /** Packed pixels the window may hold. Zero or less lifts the cap. */
  maxPixels: number;
}

export const DEFAULT_WINDOW_POLICY: WindowPolicy = { marginFraction: 0.5, maxPixels: EXACT_ADDRESS_PIXELS };

/** True when `window` holds every frame of `[startFrame, endFrame)`. */
export function windowCovers(window: WindowLayout, startFrame: number, endFrame: number): boolean {
  return window.startFrame <= startFrame && window.endFrame >= endFrame;
}

/** The view span a zoom power and offset put on screen, in file frames. */
export function viewFrameSpan(
  numFrames: number,
  zoomPower: number,
  offset: number,
): { startFrame: number; endFrame: number } {
  const span = numFrames / 2 ** Math.max(0, zoomPower);
  const start = zoomPower > 0 ? offset * (numFrames - span) : 0;
  return { startFrame: Math.floor(start), endFrame: Math.ceil(start + span) };
}

/** Packed pixels a window over `[startFrame, endFrame)` would hold. */
export function windowPixelCount(file: PackedLayout, startFrame: number, endFrame: number): number {
  return layoutPixelCount(buildWindowLayout(file, startFrame, endFrame));
}

/** The widest span around `centre` that stays inside the cap. */
function capSpan(file: PackedLayout, centre: number, wanted: number, maxPixels: number): number {
  const align = windowAlignment(file);
  const around = (width: number): { startFrame: number; endFrame: number } => {
    const start = Math.max(0, Math.min(file.numFrames - width, centre - width / 2));
    return { startFrame: start, endFrame: start + width };
  };

  // The count rises with the width one band bin at a time, so bisect it rather
  // than scaling by a ratio: each band contributes a constant as well as a
  // share of the span, and a ratio ignores the constants.
  let low = align;
  let high = wanted;
  if (windowPixelCount(file, around(low).startFrame, around(low).endFrame) > maxPixels) return low;
  while (high - low > align) {
    const mid = low + Math.floor((high - low) / 2 / align) * align;
    if (mid <= low) break;
    const probe = around(mid);
    if (windowPixelCount(file, probe.startFrame, probe.endFrame) <= maxPixels) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * The span a window would hold for this view: the view widened by the margin,
 * or — when that is past the cap — the largest allowed span around the view's
 * centre. A view wider than the cap keeps its centre resident and leaves the
 * rest to the overview, which is what the display reads at that zoom anyway.
 */
function demandSpan(
  file: PackedLayout,
  startFrame: number,
  endFrame: number,
  policy: WindowPolicy,
): { startFrame: number; endFrame: number } {
  const margin = (endFrame - startFrame) * Math.max(0, policy.marginFraction);
  const start = Math.max(0, Math.floor(startFrame - margin));
  const end = Math.min(file.numFrames, Math.ceil(endFrame + margin));
  if (policy.maxPixels <= 0 || windowPixelCount(file, start, end) <= policy.maxPixels) {
    return { startFrame: start, endFrame: end };
  }

  const centre = (startFrame + endFrame) / 2;
  const width = capSpan(file, centre, end - start, policy.maxPixels);
  const capped = Math.max(0, Math.min(file.numFrames - width, centre - width / 2));
  return { startFrame: Math.floor(capped), endFrame: Math.ceil(capped + width) };
}

/**
 * The window to hold for a view of `[startFrame, endFrame)`, or `null` to keep
 * `current`. A window is kept while it still covers the view, so the margin is
 * the hysteresis: after a move the view can travel that far before paying for
 * another gather.
 */
export function chooseWindow(
  file: PackedLayout,
  startFrame: number,
  endFrame: number,
  current: WindowLayout | null,
  policy: WindowPolicy = DEFAULT_WINDOW_POLICY,
): WindowLayout | null {
  if (current && current.file === file && windowCovers(current, startFrame, endFrame)) return null;
  const span = demandSpan(file, startFrame, endFrame, policy);
  const next = buildWindowLayout(file, span.startFrame, span.endFrame);
  if (current && next.startFrame === current.startFrame && next.endFrame === current.endFrame) return null;
  return next;
}
