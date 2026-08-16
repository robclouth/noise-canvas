import { HIDDEN_EFFECTS } from "../effects/types";
import type { UiAnchor } from "./ui-anchors";

/**
 * What every help surface derives from. The walkthrough spotlights these, the
 * discoverability overlay outlines them, the capture script crops screenshots
 * to them, and each one names its own place in the manual — so the app is
 * described once rather than once per surface.
 *
 * `UI_AREAS` is keyed by anchor and must be exhaustive over `UiAnchor`, which
 * makes adding a region without documenting it a compile error.
 */

export type UiArea = {
  /** Overlay label. */
  title: string;
  /** One line, shown under the title in the overlay. */
  blurb: string;
  /** Heading id in docs/manual.md — verified by the drift check. */
  manualSection: string;
  /**
   * A layout column that only wraps other areas. The `?` overlay skips these:
   * pointing at one always means one of its children, so offering the column
   * as well is a second answer to a question that only has one. The
   * walkthrough and the screenshot script still address them by name.
   */
  container?: boolean;
};

export const UI_AREAS = {
  "brush-panel": {
    title: "Brush panel",
    blurb: "Everything that defines the current brush, top to bottom.",
    manualSection: "brushes",
    container: true,
  },
  sidebar: {
    title: "Sidebar",
    blurb: "Your brush list on top, the history tree below.",
    manualSection: "the-interface",
    container: true,
  },
  transport: {
    title: "Transport",
    blurb: "Playback, the grid and scale your strokes snap to, meters, and the limiter.",
    manualSection: "transport-and-output",
  },
  "file-lane": {
    title: "Canvas",
    blurb: "One open file. Beats across, semitones up, orange and blue for the stereo image.",
    manualSection: "navigating-the-canvas",
  },
  "file-header": {
    title: "File header",
    blurb: "Tempo, onset sensitivity, splitting, filling the grid, and the per-file view controls.",
    manualSection: "working-with-files",
  },

  "section-macros": {
    title: "Macros",
    blurb: "Four knobs that can drive any modulatable parameter at any depth.",
    manualSection: "macros",
  },
  "section-steps": {
    title: "Steps",
    blurb: "Up to five complete brushes that one stroke runs through in order.",
    manualSection: "steps",
  },
  "section-source": {
    title: "Source",
    blurb: "The clone stamp: paint one part of a file, or another file, onto this one.",
    manualSection: "source",
  },
  "section-envelope": {
    title: "Envelope",
    blurb: "Where a stroke lands and how much energy it deposits.",
    manualSection: "envelope",
  },
  "section-options": {
    title: "Options",
    blurb: "Blend mode, pan, iterations, edge wrapping, and the warp algorithm.",
    manualSection: "options",
  },
  "section-effects": {
    title: "Effects",
    blurb: "What the brush actually does. Up to ten per step, in order, reorderable.",
    manualSection: "effects",
  },
  "section-modulators": {
    title: "Modulators",
    blurb: "Three 2D fields over time and pitch that any parameter can be driven by.",
    manualSection: "modulation",
  },

  "section-palette": {
    title: "Palettes",
    blurb: "Your brushes, grouped into named sets you open side by side.",
    manualSection: "the-palette",
  },
  "section-history": {
    title: "History",
    blurb: "A branching tree of every edit, on disk, surviving restarts.",
    manualSection: "history",
  },
} as const satisfies Record<UiAnchor, UiArea>;

export type UiAreaName = keyof typeof UI_AREAS;

/**
 * Interactions that apply to every parameter row in the app rather than to one
 * region. They own no anchor, so each names one to be demonstrated on.
 */
export type UiTechnique = {
  id: string;
  title: string;
  blurb: string;
  /** The area this is shown on. The technique is not about that area. */
  demonstrateOn: UiAnchor;
  manualSection: string;
};

export const UI_TECHNIQUES: readonly UiTechnique[] = [
  {
    id: "reset-parameter",
    title: "Double-click a label to reset it",
    blurb: "Returns the parameter to its default and clears every modulation amount on it.",
    demonstrateOn: "section-envelope",
    manualSection: "parameter-controls",
  },
  {
    id: "snap-drag",
    title: "Ctrl-drag to snap to musical values",
    blurb: "Holding Ctrl while dragging steps between beat divisions, semitone intervals and the like.",
    demonstrateOn: "section-envelope",
    manualSection: "parameter-controls",
  },
  {
    id: "parameter-menu",
    title: "Click a label for its menu",
    blurb: "Modulation amounts with their live range in real units, reset, randomisation, and step linking.",
    demonstrateOn: "section-envelope",
    manualSection: "parameter-controls",
  },
  {
    id: "randomize",
    title: "Randomise a whole section",
    blurb: "The ⋮ on any section header: Amount caps how far values move, Include Mod. rolls modulation too.",
    demonstrateOn: "section-effects",
    manualSection: "randomisation",
  },
  {
    id: "link-across-steps",
    title: "Link a parameter across steps",
    blurb: "The link icon in a label menu holds one value the same in every step of the brush.",
    demonstrateOn: "section-steps",
    manualSection: "linking-parameters-across-steps",
  },
  {
    id: "brush-hotkeys",
    title: "Bind a brush to a letter",
    blurb: "⋮ → Assign key…, then press a letter. 1–0 always select the first ten.",
    demonstrateOn: "section-palette",
    manualSection: "the-brush-list",
  },
  {
    id: "link-latency",
    title: "Right-click Link for latency compensation",
    blurb: "Ableton Link's offset control is on the right-click menu, not the button itself.",
    demonstrateOn: "transport",
    manualSection: "transport-and-output",
  },
] as const;

export const UI_AREA_NAMES = Object.keys(UI_AREAS) as UiAreaName[];

/** Widens away the `as const` literal types, which consumers never want. */
export function getArea(name: UiAreaName): UiArea {
  return UI_AREAS[name];
}

/**
 * Where a parameter is explained in the manual. Effect parameters resolve to
 * their own effect's section — the effect keys and the headings share a slug —
 * and everything else falls back to the section of the panel it lives in, so
 * only genuinely misfiled parameters need naming here.
 */
const PARAMETER_SECTIONS: Record<string, string> = {
  brushIntensity: "envelope",
  brushSizeTime: "envelope",
  brushSizePitch: "envelope",
  brushCurveTime: "envelope",
  brushCurvePitch: "envelope",
  brushSkewTime: "envelope",
  brushSkewPitch: "envelope",
  brushAnchorMode: "envelope",

  brushWrapMode: "options",
  brushIterations: "options",
  brushPan: "options",
  accumulate: "options",
  blendMode: "blend-modes",
  algorithm: "warp-algorithms",

  sourceFile: "source",
  sourcePositionMode: "source",
  sourceDataMode: "source",
  sourceTimeOffset: "source",
  sourcePitchOffset: "source",

  effects: "effects",

  displayMinDb: "the-interface",
  displayMaxDb: "the-interface",
  magnitudeLimit: "the-interface",
  minFreq: "the-interface",

  gridSizeBeats: "transport-and-output",
  gridSizeSemis: "transport-and-output",
  gridSwing: "transport-and-output",
  snapTime: "transport-and-output",
  snapPitch: "transport-and-output",
  scaleTonic: "transport-and-output",
  scaleType: "transport-and-output",
  limiterEnabled: "transport-and-output",
  reanalyzeStrokes: "transport-and-output",
  linkLatencyMs: "working-with-ableton-live",

  bandsPerOctave: "working-with-files",
};

/** Prefix rules for the parameter families generated per modulator or macro. */
const PARAMETER_PREFIXES: [string, string][] = [
  ["sequencer", "modulator-modes"],
  ["modulatorEnvelope", "modulator-modes"],
  ["modulatorPatternShape", "pattern-shapes-and-images"],
  ["modulatorTexturePath", "pattern-shapes-and-images"],
  ["modulatorMode", "modulator-modes"],
  ["modulator", "modulator-controls"],
  ["macro", "macros"],
];

/**
 * `effectType` when the parameter belongs to an effect, otherwise the table
 * above, otherwise a prefix rule. Returns null for the generated modulation
 * amounts, which are explained by the Modulation section as a whole, and for
 * effects the picker hides, which the manual does not cover.
 */
export function manualSectionForParameter(key: string, effectType?: string): string | null {
  if (effectType && HIDDEN_EFFECTS.has(effectType)) return null;
  // Effects whose manual heading differs from their state key.
  if (effectType === "clone") return "repeat";
  if (effectType === "synthesize") return "synthesise";
  if (effectType) return effectType;
  const named = PARAMETER_SECTIONS[key];
  if (named) return named;
  for (const [prefix, section] of PARAMETER_PREFIXES) {
    if (key.startsWith(prefix)) return section;
  }
  return null;
}
