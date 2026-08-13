import type { EffectItem } from "@renderer/effects/types";
import { useStore } from "@renderer/store";
import { getFileIdByPath } from "@renderer/store/files";
import { driver, type DriveStep, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../assets/walkthrough.css";
import { anchorSelector, laneSelector, type UiAnchor } from "./ui-anchors";
import { deepTourFor, type UiAreaName } from "./ui-areas";

/** Opened at the start of every run so the tour has something to paint on. */
const DEMO_FILE = "bundled://pad-loop.mp3";

/**
 * Sections the tour points at, by the label the Section component collapses on.
 * A user who collapsed one of these before re-running the tour would otherwise
 * get a spotlight on a bare header.
 */
const SECTIONS_TO_EXPAND = ["Effects", "Envelope", "Modulators", "Brushes", "History", "Generate"];

/**
 * Arms a one-shot gate: the step advances when the user does the thing rather
 * than when they click Next, and the subscription is dropped either way.
 */
type Gate = (advance: () => void) => () => void;

/** Advances once the active step gains an effect. */
const effectAddedGate: Gate = (advance) => {
  const countEffects = (): number => {
    const step = useStore.getState().getActiveStep();
    return ((step?.effects ?? []) as EffectItem[]).length;
  };
  const before = countEffects();
  return useStore.subscribe(
    (state) => state.brushes[state.activeBrushIndex],
    () => {
      if (countEffects() > before) advance();
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
  anchor?: UiAnchor;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  gate?: Gate;
};

const STEPS: Step[] = [
  {
    title: "Welcome to Noise Canvas",
    description:
      "Hey, it's Rob. Welcome to Noise Canvas — a tool for spectrally destroying samples. I've tried to make it as intuitive as I can, but a few things are easier shown than found, so this should make it a bit less mysterious. Takes about a minute.",
  },
  {
    anchor: "file-lane",
    side: "top",
    title: "This is your sound",
    description:
      "Time runs left to right in <b>beats</b>, pitch runs bottom to top in <b>semitones</b>, and brightness is loudness. Colour shows the stereo image — orange leans left, blue leans right, grey is equal in both.",
  },
  {
    anchor: "file-lane",
    side: "top",
    title: "Getting around it",
    description:
      "<b>Right-click drag</b> to pan through time, and <b>Cmd/Ctrl + scroll</b> (or pinch) to zoom around the cursor. Pitch is separate: <b>drag the legend</b> down the left edge — sideways to zoom, up and down to scroll. Plain vertical scroll moves the file list, not the file.",
  },
  {
    anchor: "brush-panel",
    side: "right",
    title: "This is your brush",
    description: "Everything down this side defines the brush: what it does to the sound, and where the stroke lands.",
  },
  {
    anchor: "section-effects",
    side: "right",
    title: "Give it something to do",
    description: "Click <b>Add effect</b> and pick <b>Blur</b>. A brush with no effects does nothing.",
    gate: effectAddedGate,
  },
  {
    anchor: "section-envelope",
    side: "right",
    title: "Decide where it lands",
    description:
      "Size sets how much time and pitch one stroke covers, in beats and semitones. Curve shapes its edges, from a sharp spike to a hard rectangle, and Skew moves the peak.",
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
    anchor: "section-brushes",
    side: "left",
    title: "Start from a preset",
    description:
      "27 factory brushes to pull apart and build on. The number keys jump between the first ten, and you can bind your own letters.",
  },
  {
    anchor: "section-modulators",
    side: "right",
    title: "Make it move",
    description:
      "That Blur was fixed across the whole stroke. Three modulators paint 2D fields over time and pitch — patterns, textures, envelope followers, sequencers — and any parameter with a menu can be driven by them.",
  },
  {
    anchor: "file-header",
    side: "bottom",
    title: "Or don't paint at all",
    description:
      "The grid icon paints the brush on every cell of the grid — every beat, every onset, every note of a scale, whatever you have the grid set to. One click lays them all down as a single stroke.",
  },
  {
    anchor: "brush-panel",
    side: "right",
    title: "That's the tour",
    description:
      "There is a lot more underneath: multi-step brushes, painting from other files, stem splitting, Ableton Live. Press <b>?</b> any time to see every part of the window at once, and the manual is on <b>Help → Manual</b>.",
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
function selectorFor(anchor: UiAnchor, fileId: string | null): string {
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
          instance()?.moveNext();
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

/** Shared driver.js setup, so a deep tour looks and behaves like the tour. */
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

/**
 * Runs one area's tour, from the discoverability overlay. Deep tours never
 * gate (D4): someone who opened the overlay is looking something up, not being
 * taught to build, so making them perform to advance would only be in the way.
 */
export async function startDeepTour(area: UiAreaName): Promise<void> {
  if (active) return;

  const steps = deepTourFor(area);
  if (steps.length === 0) return;

  expandTourSections();

  // A tour that spotlights a lane needs one on screen; the demo file is the
  // one the app can always produce.
  const needsLane = steps.some((step) => (step.anchor ?? area) === "file-lane");
  let fileId = useStore.getState().activeFileId;
  if (needsLane && !fileId) {
    await useStore.getState().openFilePath(DEMO_FILE);
    fileId = getFileIdByPath(DEMO_FILE) ?? null;
    if (fileId) await revealLane(fileId);
  }

  run(
    steps.map((step) => ({
      anchor: step.anchor ?? area,
      title: step.title,
      description: step.description,
      ...(step.side ? { side: step.side } : {}),
    })),
    fileId,
  );
}

export function isWalkthroughRunning(): boolean {
  return active !== null;
}
