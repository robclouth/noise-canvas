import type { EffectItem } from "@renderer/effects/types";
import { useStore } from "@renderer/store";
import { getFileIdByPath } from "@renderer/store/files";
import { driver, type DriveStep, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../assets/walkthrough.css";
import { anchorSelector, laneSelector, type AnchorName } from "./ui-anchors";

/** Opened at the start of every run so the tour has something to paint on. */
const DEMO_FILE = "bundled://break-loop.mp3";
/** The demo file's real tempo, forced on every run regardless of what a previous run left behind. */
const DEMO_BPM = 160;

/**
 * Sections the tour points at, by the label the Section component collapses on.
 * A user who collapsed one of these before re-running the tour would otherwise
 * get a spotlight on a bare header.
 */
const SECTIONS_TO_EXPAND = ["Effects", "Envelope", "Modulators", "Palette", "History"];

/**
 * Arms a one-shot gate: the step advances when the user does the thing rather
 * than when they click Next, and the subscription is dropped either way.
 */
type Gate = (advance: () => void) => () => void;

/** Advances once a new, empty brush becomes active. */
const emptyBrushAddedGate: Gate = (advance) => {
  const before = useStore.getState().brushes.length;
  return useStore.subscribe(
    (state) => state.brushes.length,
    (count) => {
      if (count <= before) return;
      const step = useStore.getState().getActiveStep();
      if (((step?.effects ?? []) as EffectItem[]).length === 0) advance();
    },
  );
};

/** Advances once the active step gains a Transform effect. */
const transformAddedGate: Gate = (advance) => {
  return useStore.subscribe(
    (state) => state.brushes[state.activeBrushIndex],
    () => {
      const step = useStore.getState().getActiveStep();
      const hasTransform = ((step?.effects ?? []) as EffectItem[]).some((item) => item.effect === "transform");
      if (hasTransform) advance();
    },
  );
};

/** Advances when a painted stroke finishes. */
const strokePaintedGate: Gate = (advance) => {
  return useStore.subscribe(
    (state) => state.isStroking,
    (isStroking, wasStroking) => {
      if (wasStroking && !isStroking) advance();
    },
  );
};

type Step = {
  anchor?: AnchorName;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  gate?: Gate;
};

const STEPS: Step[] = [
  {
    title: "Let's take a look",
    description:
      "A few things are easier to show than to explain, so this walks through where everything lives. Takes about a minute.",
  },
  {
    anchor: "file-lane",
    side: "top",
    title: "This is your sound",
    description:
      "Time runs left to right in <b>beats</b>, pitch runs bottom to top in <b>semitones</b>, and brightness is loudness. Colour shows the stereo image: orange leans left, blue leans right, grey is equal in both.",
  },
  {
    anchor: "file-lane",
    side: "top",
    title: "Getting around it",
    description:
      "<b>Right-click drag</b> to pan through time, and <b>Cmd/Ctrl + scroll</b> (or pinch) to zoom around the cursor. Pitch is separate: <b>drag the legend</b> down the left edge, sideways to zoom, up and down to scroll. Plain vertical scroll moves the file list, not the file.",
  },
  {
    anchor: "brush-panel",
    side: "right",
    title: "This is your brush",
    description: "Everything down this side defines the brush: what it does to the sound, and where the stroke lands.",
  },
  {
    anchor: "section-palette",
    side: "left",
    title: "Start with a fresh one",
    description:
      "Click <b>Add brush</b> at the bottom of the palette and pick <b>New</b> for an empty brush to build from scratch. It comes with a random name; rename it any time from the row's <b>⋮</b> menu.",
    gate: emptyBrushAddedGate,
  },
  {
    anchor: "section-effects",
    side: "right",
    title: "Give it something to do",
    description: "Click <b>Add effect</b> and pick <b>Transform</b>. A brush with no effects does nothing.",
    gate: transformAddedGate,
  },
  {
    anchor: "effect-transform",
    side: "right",
    title: "Make it stretch",
    description:
      "Turn <b>Scale ↔</b> above 1 to stretch the sound out in time, or below 1 to squash it. Negative values play it backwards.<br><br>Every value works the same way. Drag it, hold <b>Ctrl</b> to snap to musical units, or hold <b>Shift</b> for fine control. <b>Right-click</b> a value for a list of preset ones, <b>click its label</b> for the menu: modulation, randomisation and the rest, and <b>double-click the label</b> to put it back to its default.",
  },
  {
    anchor: "section-envelope",
    side: "right",
    title: "Decide where it lands",
    description:
      "Try <b>Size ↔</b> at <b>Full</b> to see it span the whole file, then bring it down to around <b>4 beats</b> so the stroke covers a bar or so. Curve shapes its edges, from a sharp spike to a hard rectangle, and Skew moves the peak.",
  },
  {
    anchor: "file-lane",
    side: "top",
    title: "Now paint",
    description: "Drag across the spectrogram. The brush is applied wherever you take it.",
    gate: strokePaintedGate,
  },
  {
    anchor: "transport",
    side: "top",
    title: "Hear it",
    description:
      "Space plays and stops. The brush icon auto-plays whatever you just painted. The grid and scale controls here are what your strokes snap to.",
  },
  {
    anchor: "section-history",
    side: "left",
    title: "Nothing is lost",
    description:
      "Every stroke becomes a node. Undo walks back up the tree and leaves the branch you came from intact, so you can wander off and come back. It survives quitting, too.",
  },
  {
    anchor: "section-palette",
    side: "left",
    title: "Start from a palette",
    description:
      "A palette is a folder of brushes for one job. Seven ship with the app, and you can have several open at once. The number keys jump between the first ten brushes.",
  },
  {
    anchor: "section-modulators",
    side: "right",
    title: "Make it move",
    description:
      "That Transform was fixed across the whole stroke. Three modulators paint 2D fields over time and pitch: patterns, textures, envelope followers, sequencers. Any parameter with a <b>blue dot</b> next to its label can be modulated.",
  },
  {
    anchor: "file-fill-grid",
    side: "bottom",
    title: "Or don't paint at all",
    description:
      "The grid icon paints the brush on every cell of the grid: every beat, every onset, every note of a scale, whatever you have the grid set to. One click lays them all down as a single stroke.",
  },
  {
    anchor: "menu-help",
    side: "bottom",
    title: "That's the tour",
    description:
      "There is a lot more underneath: multi-step brushes, painting from other files, stem splitting, Ableton Live integration. Press <b>?</b> any time to see every part of the window at once, or <b>Cmd/Ctrl+/</b> to open the manual.",
  },
];

let active: Driver | null = null;
let releaseGate: (() => void) | null = null;

function clearGate(): void {
  releaseGate?.();
  releaseGate = null;
}

/**
 * `file-lane` is the one anchor that exists once per open file, so a bare
 * selector would spotlight whichever lane happens to be first. Every lane step
 * means the demo file the tour just opened.
 */
function selectorFor(anchor: AnchorName, fileId: string | null): string {
  if (anchor === "file-lane" && fileId) return laneSelector(fileId);
  return anchorSelector(anchor);
}

function toDriveStep(step: Step, fileId: string | null, instance: () => Driver | null): DriveStep {
  return {
    ...(step.anchor ? { element: selectorFor(step.anchor, fileId) } : {}),
    popover: {
      title: step.title,
      description: step.description,
      ...(step.side ? { side: step.side, align: "start" as const } : {}),
      // A gated step hides its buttons so the only way on is doing the thing.
      ...(step.gate ? { showButtons: ["close" as const] } : {}),
      onPopoverRender: () => {
        clearGate();
        if (!step.gate) return;
        releaseGate = step.gate(() => {
          clearGate();
          // The gate fires synchronously off a store subscription, ahead of React's
          // render for whatever the user's action just added. If the next step
          // anchors on that new element (e.g. a just-added effect card), advancing
          // in the same tick makes driver.js query for it too early and fall back
          // to a dummy centered element. Two rAFs guarantee a paint has happened.
          requestAnimationFrame(() => requestAnimationFrame(() => instance()?.moveNext()));
        });
      },
    },
  };
}

/** Opens the sections the tour spotlights so none of them is a bare header. */
function expandTourSections(): void {
  const { sectionCollapsed, setSectionCollapsed } = useStore.getState();
  for (const label of SECTIONS_TO_EXPAND) {
    if (sectionCollapsed[label]) setSectionCollapsed(label, false);
  }
}

/**
 * Waits for a file's lane to mount and brings it into view, so the tour's first
 * spotlight lands on something the user can already see.
 */
async function revealLane(fileId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const lane = document.querySelector(laneSelector(fileId));
    if (lane) {
      lane.scrollIntoView({ block: "start" });
      // One frame for the scroll to land before driver.js measures the element.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Starts the walkthrough on the demo file, whatever else is open. Opening it
 * activates the existing lane if it is already loaded, so the tour always knows
 * which lane it means rather than touring whatever the user happened to load.
 */
export async function startWalkthrough(): Promise<void> {
  if (active) return;

  // Forced ahead of open/activate so the transport reads it back correctly,
  // regardless of what a previous run may have left in this path's stored BPM.
  useStore.getState().setFilepathBpm(DEMO_FILE, DEMO_BPM);
  await useStore.getState().openFilePath(DEMO_FILE);
  // Resolved by path rather than from activeFileId: reopening a minimized file
  // restores it without activating it.
  const tourFileId = getFileIdByPath(DEMO_FILE) ?? null;
  if (tourFileId) {
    await useStore.getState().setActiveFileId(tourFileId);
    await revealLane(tourFileId);
  }
  expandTourSections();

  run(STEPS, tourFileId);
  useStore.getState().setWalkthroughSeen(true);
}

function run(steps: Step[], fileId: string | null): void {
  const instance = driver({
    showProgress: true,
    progressText: "{{current}} of {{total}}",
    animate: true,
    smoothScroll: true,
    allowClose: true,
    overlayColor: "#000",
    overlayOpacity: 0.6,
    stagePadding: 4,
    stageRadius: 4,
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    popoverClass: "walkthrough-popover",
    steps: steps.map((step) => toDriveStep(step, fileId, () => active)),
    onDestroyed: () => {
      clearGate();
      active = null;
    },
  });

  active = instance;
  instance.drive();
}

export function isWalkthroughRunning(): boolean {
  return active !== null;
}
