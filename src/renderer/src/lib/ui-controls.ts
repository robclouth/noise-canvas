/**
 * Every control in the main interface that is not a parameter: buttons,
 * toggles, meters and the custom widgets. One entry gives a control both its
 * tooltip and its entry in the help overlay, so the two cannot drift apart.
 *
 * `label` and `description` are the translatable fields. Everything reads them
 * through `getControl`, so a locale only has to replace those two per entry.
 */

export type UiControl = {
  /** Two or three words. The help overlay titles the control with this. */
  label: string;
  /** One sentence saying what the control does. Shown as the tooltip and in the overlay. */
  description: string;
  /** Heading id in docs/manual.md. */
  manualSection?: string;
};

export const UI_CONTROLS = {
  // Transport
  "transport-play": {
    label: "Play / Stop",
    description: "Starts and stops playback of every open file.",
    manualSection: "transport-and-output",
  },
  "transport-loop": {
    label: "Loop",
    description: "Repeats playback from the start instead of stopping at the end.",
    manualSection: "transport-and-output",
  },
  "transport-audition": {
    label: "Audition strokes",
    description: "Plays back the region you painted as soon as a stroke finishes.",
    manualSection: "transport-and-output",
  },
  "transport-link": {
    label: "Ableton Link",
    description: "Syncs tempo and playback with other Ableton Link apps on the network.",
    manualSection: "working-with-ableton-live",
  },
  "output-meter": {
    label: "Output level",
    description: "Shows the output level of the left and right channels.",
    manualSection: "transport-and-output",
  },

  // Menu bar
  "menu-help": {
    label: "Help overlay",
    description: "Dims the interface and describes whatever the pointer is over.",
    manualSection: "getting-help",
  },
  "menu-memory": {
    label: "Memory use",
    description: "Shows how much of the graphics memory budget the open files hold.",
    manualSection: "menus",
  },

  // File header
  "file-resolution": {
    label: "Analysis resolution",
    description: "Sets how this file's analysis trades time detail against pitch detail.",
    manualSection: "analysis-resolution",
  },
  "file-channels": {
    label: "Channels",
    description: "Switches this file between mono and stereo, analysing it again.",
    manualSection: "mono-and-stereo",
  },
  "file-onsets": {
    label: "Onsets",
    description: "Sets how far down this file's level range a hit still counts as an onset.",
    manualSection: "onsets",
  },
  "file-bpm": {
    label: "BPM",
    description: "Sets the tempo of this file, which drives grid snapping and beat-based sizes.",
    manualSection: "working-with-files",
  },
  "file-split": {
    label: "Split",
    description: "Separates the file into parts, each in its own lane.",
    manualSection: "splitting-a-file",
  },
  "file-fill-grid": {
    label: "Fill grid",
    description: "Paints the current brush on every grid cell, across the loop region or the whole file.",
    manualSection: "fill-grid",
  },
  "file-duplicate": {
    label: "Duplicate",
    description: "Copies the file into a new lane you can edit on its own.",
    manualSection: "working-with-files",
  },
  "file-minimize": {
    label: "Minimize",
    description: "Moves the file off the canvas to the dock, leaving it open.",
    manualSection: "navigating-the-canvas",
  },
  "file-fullscreen": {
    label: "Fullscreen",
    description: "Expands the file to fill the canvas area, and back again.",
    manualSection: "navigating-the-canvas",
  },
  "file-close": {
    label: "Close",
    description: "Closes the file, asking first if it has unsaved edits.",
    manualSection: "working-with-files",
  },
  dock: {
    label: "Dock",
    description: "Holds minimized files, which stay open and usable as sources while off the canvas.",
    manualSection: "navigating-the-canvas",
  },
  "dock-file": {
    label: "Minimized file",
    description: "Restores this file to the canvas.",
    manualSection: "navigating-the-canvas",
  },
  "dock-close": {
    label: "Close",
    description: "Closes this file without restoring it to the canvas.",
    manualSection: "navigating-the-canvas",
  },

  // Stem groups
  "stem-sync-view": {
    label: "Link views",
    description: "Ties zoom and scroll together across the parts of a split.",
    manualSection: "stem-groups",
  },
  "stem-merge": {
    label: "Merge parts",
    description: "Combines every part of a split into one new file, leaving the parts open.",
    manualSection: "stem-groups",
  },
  "stem-close": {
    label: "Close split",
    description: "Closes every part of a split at once.",
    manualSection: "stem-groups",
  },

  // History
  "history-undo": {
    label: "Undo",
    description: "Steps back to the previous state of this file.",
    manualSection: "history",
  },
  "history-redo": {
    label: "Redo",
    description: "Steps forward again after an undo.",
    manualSection: "history",
  },
  "history-entry": {
    label: "History entry",
    description: "Returns the file to this point in its history.",
    manualSection: "history",
  },
  "history-menu": {
    label: "History menu",
    description: "Exports or purges the stored history of this file.",
    manualSection: "history",
  },

  // Palettes
  "palette-header": {
    label: "Palette",
    description: "Names one open palette, and folds its brushes away.",
    manualSection: "the-palette",
  },
  "palette-add": {
    label: "Add palette",
    description: "Opens the palette browser, which starts an empty one or opens a saved set.",
    manualSection: "the-palette",
  },
  "palette-row": {
    label: "Palette",
    description: "Opens this palette and its brushes in the sidebar.",
    manualSection: "the-palette",
  },
  "palette-menu": {
    label: "Palette menu",
    description: "Saves, renames, closes or removes this palette.",
    manualSection: "the-palette",
  },

  // Brushes
  "brush-add": {
    label: "Add brush",
    description: "Opens the brush picker to add a brush to this palette.",
    manualSection: "the-brush-list",
  },
  "brush-row": {
    label: "Brush",
    description: "Selects this brush for painting.",
    manualSection: "the-brush-list",
  },
  "brush-menu": {
    label: "Brush menu",
    description: "Renames, duplicates, exports or removes this brush.",
    manualSection: "the-brush-list",
  },

  // Effects
  "effect-add": {
    label: "Add effect",
    description: "Adds an effect to the end of this brush's chain.",
    manualSection: "effects",
  },
  "effect-header": {
    label: "Effect",
    description: "Names the effect, and drags to reorder it within the chain.",
    manualSection: "effects",
  },
  "effect-enable": {
    label: "Enable effect",
    description: "Turns this effect on and off without taking it out of the chain.",
    manualSection: "effects",
  },
  "effect-duplicate": {
    label: "Duplicate",
    description: "Copies this effect and its settings into a new one after it.",
    manualSection: "effects",
  },
  "effect-reset": {
    label: "Reset",
    description: "Returns every parameter in this section to its default.",
    manualSection: "parameter-controls",
  },
  "effect-remove": {
    label: "Remove",
    description: "Takes this effect out of the chain.",
    manualSection: "effects",
  },
  "section-menu": {
    label: "Section menu",
    description: "Randomizes, resets or copies the parameters in this section.",
    manualSection: "parameter-controls",
  },
  "section-randomize": {
    label: "Randomize section",
    description: "Randomizes the parameters in this section that are set to take part.",
    manualSection: "randomization",
  },
  "section-preset": {
    label: "Preset",
    description: "Sets every parameter in this section at once.",
    manualSection: "section-presets",
  },
  "section-save-preset": {
    label: "Add preset",
    description: "Keeps this section's current settings as a preset of your own.",
    manualSection: "section-presets",
  },
  "preset-menu": {
    label: "Preset menu",
    description: "Duplicates this preset, and renames or deletes it when it is one of your own.",
    manualSection: "section-presets",
  },

  // Steps
  "step-select": {
    label: "Step",
    description: "Makes this step the one you are editing and painting with.",
    manualSection: "steps",
  },
  "step-add": {
    label: "Add step",
    description: "Adds a step to the end of the sequence.",
    manualSection: "steps",
  },
  "step-duplicate": {
    label: "Duplicate step",
    description: "Copies the current step and its parameters into a new step.",
    manualSection: "steps",
  },
  "step-delete": {
    label: "Delete step",
    description: "Removes the current step from the sequence.",
    manualSection: "steps",
  },

  // Randomization
  "randomize-dice": {
    label: "Randomize",
    description: "Randomizes every parameter that is set to take part.",
    manualSection: "randomization",
  },
  "randomize-amount": {
    label: "Randomize amount",
    description: "Sets how far randomizing moves each parameter from its current value.",
    manualSection: "randomization",
  },

  // Parameter menu
  "param-reset": {
    label: "Reset",
    description: "Returns this parameter and its modulation to the default.",
    manualSection: "parameter-controls",
  },
  "param-rename-macro": {
    label: "Rename",
    description: "Renames this macro.",
    manualSection: "macros",
  },
  "param-manual": {
    label: "Manual",
    description: "Opens the manual at the section that explains this parameter.",
    manualSection: "getting-help",
  },
  "param-randomise": {
    label: "Randomise",
    description: "Includes this parameter when the dice randomizes the brush.",
    manualSection: "randomization",
  },
  "param-step-linked": {
    label: "Step Linked",
    description: "Shares one value for this parameter across every step.",
    manualSection: "linking-parameters-across-steps",
  },

  // Modulators
  "modulator-shape": {
    label: "Shape",
    description: "Chooses the pattern the modulator scans across the canvas.",
    manualSection: "pattern-shapes-and-images",
  },
  "sequencer-grid": {
    label: "Sequencer grid",
    description: "Sets the modulator's value for each step of its sequence.",
    manualSection: "the-sequencer-grid",
  },
  "sequencer-randomize": {
    label: "Randomise",
    description: "Fills the grid with random values.",
    manualSection: "the-sequencer-grid",
  },
  "sequencer-fill": {
    label: "Fill",
    description: "Switches every step on, at full value.",
    manualSection: "the-sequencer-grid",
  },
  "sequencer-clear": {
    label: "Clear",
    description: "Switches every step off, keeping the values it holds.",
    manualSection: "the-sequencer-grid",
  },
} as const satisfies Record<string, UiControl>;

export type UiControlName = keyof typeof UI_CONTROLS;

export const UI_CONTROL_NAMES = Object.keys(UI_CONTROLS) as UiControlName[];

export const HELP_ATTR = "data-help";
const HELP_TITLE_ATTR = "data-help-title";
const HELP_TEXT_ATTR = "data-help-text";

/**
 * The single read path for control copy, and so the seam a translation hooks
 * into: a locale replaces `label` and `description` here and every tooltip and
 * help card follows.
 */
export function getControl(name: UiControlName): UiControl {
  return UI_CONTROLS[name];
}

/** Marks an element as the control `name`, for the help overlay to find. */
export function helpProps(name: UiControlName): { "data-help": UiControlName } {
  return { [HELP_ATTR]: name };
}

export function controlSelector(name: UiControlName): string {
  return `[${HELP_ATTR}="${name}"]`;
}

/**
 * Overrides the registry copy for one instance of a control, where the thing
 * names and describes itself better than a shared sentence can — an effect
 * card, a brush row. The registry entry still supplies the fallback.
 */
export function helpInstance(title: string, text: string): Record<string, string> {
  return { [HELP_TITLE_ATTR]: title, [HELP_TEXT_ATTR]: text };
}

export function readHelpInstance(element: Element): { title: string; text: string } | null {
  const title = element.getAttribute(HELP_TITLE_ATTR);
  const text = element.getAttribute(HELP_TEXT_ATTR);
  return title && text ? { title, text } : null;
}
