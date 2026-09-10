import type { EffectType } from "@renderer/effects/types";

/**
 * Stable handles on the UI regions that other tooling addresses by name: the
 * first-run walkthrough spotlights them, and scripts/capture-ui.mjs crops
 * screenshots to them for the manual.
 *
 * Each name maps to the container at the nesting level those consumers want —
 * a section anchor covers its header and body together, a panel anchor covers
 * the whole column. Renaming one here is a compile error at every use site,
 * which is the point: the walkthrough and the docs can't drift apart silently.
 */
export const UI_ANCHORS = [
  // Layout columns
  "brush-panel",
  "sidebar",
  "transport",
  // A single file's layer in the canvas column, and its header strip
  "file-layer",
  "file-header",
  // Brush panel sections, top to bottom
  "section-macros",
  "section-steps",
  "section-source",
  "section-envelope",
  "section-options",
  "section-effects",
  "section-modulators",
  // Sidebar sections
  "section-palette",
  "section-history",
  // The pattern bar above the transport
] as const;

export type UiAnchor = (typeof UI_ANCHORS)[number];

/** One effect card inside the Effects list, keyed by which effect it hosts. */
export type EffectAnchor = `effect-${EffectType}`;

/**
 * One-off controls the walkthrough spotlights directly, rather than the
 * coarser section/panel they sit in. Not part of `UI_ANCHORS`: they have no
 * "?" overlay area of their own (their `data-help` entry already covers
 * that), so they're exempt from the area-registry exhaustiveness check.
 */
export const CONTROL_ANCHORS = ["file-fill-grid", "menu-help"] as const;
export type ControlAnchor = (typeof CONTROL_ANCHORS)[number];

export type AnchorName = UiAnchor | EffectAnchor | ControlAnchor;

export const ANCHOR_ATTR = "data-anchor";

/**
 * Qualifies the one anchor that is not a singleton. `file-layer` exists once per
 * open file, so consumers that mean a particular file have to say which.
 */
export const ANCHOR_FILE_ATTR = "data-anchor-file";

/** Spread onto a component to mark it as the anchor for `name`. */
export function anchorProps(name: AnchorName): { "data-anchor": AnchorName } {
  return { [ANCHOR_ATTR]: name };
}

/** Spread onto a file layer so `layerSelector` can address that file's layer. */
export function layerAnchorProps(fileId: string): { "data-anchor": AnchorName; "data-anchor-file": string } {
  return { [ANCHOR_ATTR]: "file-layer", [ANCHOR_FILE_ATTR]: fileId };
}

/** CSS selector matching the element tagged with `name`. */
export function anchorSelector(name: AnchorName): string {
  return `[${ANCHOR_ATTR}="${name}"]`;
}

/** CSS selector matching one specific file's layer rather than the first one. */
export function layerSelector(fileId: string): string {
  return `${anchorSelector("file-layer")}[${ANCHOR_FILE_ATTR}="${fileId}"]`;
}
