import { HIDDEN_EFFECTS } from "../effects/types";
import type { UiAnchor } from "./ui-anchors";

/**
 * What every help surface derives from. The walkthrough spotlights these, the
 * discoverability overlay outlines them, the deep tours run inside them, the
 * capture script crops screenshots to them, and each one names its own place in
 * the manual — so the app is described once rather than once per surface.
 *
 * `UI_AREAS` is keyed by anchor and must be exhaustive over `UiAnchor`, which
 * makes adding a region without documenting it a compile error.
 */

/** One popover in a deep tour. Deep tours never gate — they run straight through. */
export type AreaTourStep = {
  /** Defaults to the area's own anchor when the step is about the area itself. */
  anchor?: UiAnchor;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
};

export type UiArea = {
  /** Overlay label, and the deep tour's name. */
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
  /** Present only where an area teaches something a tooltip can't. */
  deepTour?: AreaTourStep[];
  /** Recipe ids in docs/recipes.md, surfaced from the overlay. */
  recipes?: string[];
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
    recipes: ["chop-to-the-hits", "erase-a-hit"],
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
    deepTour: [
      {
        title: "Painting without a mouse",
        description:
          "The grid icon paints the current brush on every cell of the grid, across the whole file or across a loop region you drag on the time legend. It commits as one stroke and one undo, and a large fill runs behind a progress dialog you can cancel.",
      },
      {
        title: "The grid decides the rhythm",
        description:
          "There are no separate settings — a fill reads the <b>Beats</b>, <b>Swing</b> and <b>Semis</b> grids you already set. Set the time grid to <b>Onsets</b> and it follows the file's own hits; set the pitch grid to <b>Scale</b> and it lands on the notes of the selected scale.",
      },
      {
        title: "The brush decides the size",
        description:
          "<b>Size ↔</b> and <b>Size ↕</b> behave exactly as they do by hand: at <b>Grid</b> each stroke fills its cell so the fill tiles edge to edge, at a fixed value every stroke takes that size, and at <b>Full</b> it spans the axis.",
      },
      {
        title: "Making the strokes differ",
        description:
          "Every stroke uses the same brush, so variation comes from modulation — a modulator is a field across the canvas, so strokes in different places sample different values. A Random pattern on <b>Strength</b> varies each one; a sequencer on it draws the rhythm outright.",
      },
    ],
    recipes: ["mute-a-vocal", "paint-a-rhythm-across-the-file", "sweep-a-brush-up-the-spectrum"],
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
    deepTour: [
      {
        title: "One stroke, several stages",
        description:
          "Each tab is a complete brush — its own effects, envelope and modulators. A single stroke runs through <b>all</b> of them in order, so step 1 can synthesize a tone, step 2 blur it, and step 3 place it in space.",
      },
      {
        title: "Steps keep their identity",
        description:
          "Drag to reorder, and the colours travel with the steps rather than the slots — reordering reads as moving a stage, not relabelling one. The strip is fixed width, so adding a step never rescales the others.",
      },
      {
        anchor: "brush-panel",
        side: "right",
        title: "Almost everything is per-step",
        description:
          "Switching tabs switches this whole panel. Only the genuinely global things — the grid, the scale, the transport — stay put. To hold one parameter steady across every step, open its label menu and toggle the <b>link</b> icon.",
      },
    ],
  },
  "section-source": {
    title: "Source",
    blurb: "The clone stamp: paint one part of a file, or another file, onto this one.",
    manualSection: "source",
    deepTour: [
      {
        title: "Paint from somewhere else",
        description:
          "By default a brush reads from the file it's painting on. Hold <b>Shift</b> and click any open file's canvas to pick somewhere else instead — a brush-sized rectangle previews what you're about to sample.",
      },
      {
        title: "How the source follows you",
        description:
          "<b>Follow</b> drags the source along with your stroke. <b>Fixed</b> reads the same spot every time, which is how you paint one hit repeatedly. <b>Anchored</b> keeps the offset you started with, so the source moves in parallel.",
      },
      {
        title: "Reading the original",
        description:
          "<b>Read From → Original</b> samples the file's unedited analysis rather than its current state. Painted over a region you regret, that is a local undo — the Restore brush is nothing but this.",
      },
      {
        anchor: "file-lane",
        side: "top",
        title: "Files don't have to match",
        description:
          "Source and destination can differ in tempo, length and analysis resolution. Positions are mapped through a frequency-preserving map, so painting a 90 BPM pad onto a 174 BPM break works without either being resampled first.",
      },
    ],
    recipes: ["rearrange-beats", "undo-one-region"],
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
    recipes: ["pitch-up-or-down", "reverse-a-phrase"],
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
    deepTour: [
      {
        title: "Fields, not LFOs",
        description:
          "A modulator is evaluated <b>per pixel</b> — it's a 2D field laid over time and pitch, not an envelope on a timeline. That's why the shapes are textures and patterns rather than waveforms alone.",
      },
      {
        title: "Rate is in beats and semitones",
        description:
          "<b>Rate ↔</b> is how many beats one cycle spans and <b>Rate ↕</b> how many semitones. At 0 an axis reads <b>Off</b> and the pattern stops varying along it — one axis off gives you stripes, both on gives you a texture.",
      },
      {
        title: "Anchored to the canvas or the brush",
        description:
          "<b>Phase Mode → Canvas</b> pins the pattern to the file, so separate strokes uncover one continuous field. <b>Brush</b> carries it along with each stroke, so every stroke gets the same shape wherever you put it.",
      },
      {
        anchor: "brush-panel",
        side: "right",
        title: "Wiring one up",
        description:
          "Click any parameter's <b>label</b> to open its menu. Every modulator, macro and contextual source is listed there with an amount. 0% is the slider value, ±100% is pure modulation across that parameter's whole legal range — it can't go out of range.",
      },
      {
        title: "Modulators modulate each other",
        description:
          "Modulator parameters are themselves modulatable, one level deep — modulator 1 can drive modulator 2's rate, or a macro can drive a depth. (Off on Windows, where the shaders it unrolls take too long to compile.)",
      },
    ],
    recipes: ["turn-a-pad-into-a-rhythm"],
  },

  "section-palette": {
    title: "Palettes",
    blurb: "Your brushes, grouped into named sets you open side by side.",
    manualSection: "the-palette",
    deepTour: [
      {
        title: "Brushes stay open",
        description:
          "Have as many as you like — each is an independent set of steps, effects, modulators and macros. The coloured dots on a row are the effects it uses, so you can read what a brush does without loading it.",
      },
      {
        title: "Jump to one with a key",
        description:
          "<b>1–9</b> and <b>0</b> always select the first ten in the list. Any brush can also be bound to a letter: <b>⋮ → Assign key…</b>, then press a letter. That letter then jumps to it from anywhere in the app.",
      },
      {
        title: "Palettes are folders",
        description:
          "Each grey band titles one open palette and folds its brushes away. Open as many as you like — seven ship with the app, one per job — and drag a brush from one to another. The ⋮ on the section heading opens more.",
      },
      {
        title: "Two libraries, two levels",
        description:
          "One brush saves to <i>Documents/Noise Canvas/Presets</i>; a whole palette saves to <i>Palettes</i> beside it. Both show a dirty marker once they drift, and both have <b>Save</b> and <b>Save as…</b> on the ⋮.",
      },
    ],
  },
  "section-history": {
    title: "History",
    blurb: "A branching tree of every edit, on disk, surviving restarts.",
    manualSection: "history",
    deepTour: [
      {
        title: "Undo doesn't destroy anything",
        description:
          "Undo a few steps, paint something else, and the steps you undid stay as a branch rather than being thrown away. Click any node to jump the file straight back to it, then click your way back out.",
      },
      {
        title: "Mark the ones you like",
        description:
          "Double-click a node to rename it, right-click to <b>Favorite</b> it. Both make a long tree navigable later, when a column of timestamps no longer tells you which take was the good one.",
      },
      {
        title: "Getting audio out of it",
        description:
          "<b>Export branch…</b> renders one numbered WAV per node down a lineage, which is how you audition variations in a DAW. The <b>⋮</b> menu adds Export Favorites and <b>Purge History</b>, which reclaims disk without touching the current state.",
      },
    ],
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
    title: "Shift-drag to snap to musical values",
    blurb: "Holding Shift while dragging steps between beat divisions, semitone intervals and the like.",
    demonstrateOn: "section-envelope",
    manualSection: "parameter-controls",
  },
  {
    id: "parameter-menu",
    title: "Click a label for its menu",
    blurb: "Modulation amounts with their live range in real units, reset, randomize exclusion, and step linking.",
    demonstrateOn: "section-envelope",
    manualSection: "parameter-controls",
  },
  {
    id: "randomize",
    title: "Randomize a whole section",
    blurb: "The ⋮ on any section header: Amount caps how far values move, Include Mod. rolls modulation too.",
    demonstrateOn: "section-effects",
    manualSection: "randomization",
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

export function deepTourFor(name: UiAreaName): AreaTourStep[] {
  return getArea(name).deepTour ?? [];
}

/** Areas with a deep tour, in the order the overlay should offer them. */
export function areasWithDeepTours(): UiAreaName[] {
  return UI_AREA_NAMES.filter((name) => deepTourFor(name).length > 0);
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
  if (effectType) return effectType;
  const named = PARAMETER_SECTIONS[key];
  if (named) return named;
  for (const [prefix, section] of PARAMETER_PREFIXES) {
    if (key.startsWith(prefix)) return section;
  }
  return null;
}
