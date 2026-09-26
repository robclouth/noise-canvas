import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EffectType } from "../../effects/types";
import type { State } from "../../store/types";
import {
  expectSameStroke,
  paintStroke,
  parityCanvas,
  parityData,
  parityRenderer,
  PARITY_FILE_PATH,
  type ParityCanvas,
} from "../../test/canvas-parity";
import { createStateForEffects } from "../../test/render-harness";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

// Every brush the matrix paints: an effect and the settings that change what
// it reads.
const BRUSHES: { name: string; effect: EffectType; step: Record<string, unknown> }[] = [
  { name: "passthrough", effect: "passthrough", step: {} },
  { name: "dynamics", effect: "dynamics", step: { dynamicsGainDb: -20 } },
  { name: "transform pitch shift", effect: "transform", step: { transformShiftSemis: 3 } },
  { name: "transform time shift, bleed", effect: "transform", step: { transformShiftBeats: 1, transformEdgeMode: 1 } },
  { name: "transform stretch, cut", effect: "transform", step: { transformScaleTime: 0.5, transformEdgeMode: 0 } },
  { name: "transform reverse, cut", effect: "transform", step: { transformScaleTime: -1, transformEdgeMode: 0 } },
  { name: "transform turn", effect: "transform", step: { transformRotation: 30 } },
  { name: "blur, cut", effect: "blur", step: { blurAmountTime: 25, blurEdgeMode: 0 } },
  { name: "blur, bleed", effect: "blur", step: { blurAmountTime: 25, blurEdgeMode: 1 } },
  { name: "blur, wrap", effect: "blur", step: { blurAmountTime: 25, blurEdgeMode: 2 } },
  { name: "blur in pitch", effect: "blur", step: { blurAmountTime: 0, blurAmountPitch: 50 } },
  { name: "repeat, bleed", effect: "clone", step: { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneEdgeMode: 1 } },
  { name: "repeat, wrap", effect: "clone", step: { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneEdgeMode: 2 } },
  { name: "synthesise", effect: "synthesize", step: {} },
  { name: "evolve", effect: "evolve", step: {} },
  { name: "binaural", effect: "binaural", step: {} },
  { name: "sort along time", effect: "sort", step: { sortDirection: 0 } },
  { name: "sort along pitch", effect: "sort", step: { sortDirection: 1 } },
  { name: "sort both ways", effect: "sort", step: { sortDirection: 2 } },
  { name: "transmute", effect: "transmute", step: {} },
  { name: "transmute to time", effect: "transmute", step: { transmuteTo: 2 } },
  { name: "waveshape", effect: "waveshape", step: {} },
  { name: "align", effect: "align", step: {} },
  { name: "attract", effect: "attract", step: {} },
  { name: "convolve", effect: "convolve", step: {} },
];

// Blocks the windowed canvas holds: twelve seconds, so a brush of 31 beats is
// wider than it.
const WINDOW_BLOCKS = 6;

// File lengths in seconds; VITE_PARITY_SECONDS=300,600 runs the long ones.
const LENGTHS: number[] = String(import.meta.env.VITE_PARITY_SECONDS ?? "60")
  .split(",")
  .map(Number);

// One beat, wider than the window, and the whole file.
const WIDTHS = [
  { name: "one beat", beats: 1 },
  { name: "wider than the window", beats: 31 },
  { name: "the whole file", beats: 32 },
];

function brushState(effect: EffectType, step: Record<string, unknown>, beats: number, accumulate: boolean): State {
  return createStateForEffects([effect], {
    brushSizeTime: beats,
    brushSizePitch: 12,
    stepOverrides: { ...step, accumulate },
    overrides: {
      activeFileId: "parity",
      filepathsBpm: { [PARITY_FILE_PATH]: 120 },
      filepathsOnsetSensitivity: {},
      filesSelection: {},
      filesZoomY: {},
      filesOffsetY: {},
      filesZoom: {},
      filesOffset: {},
    },
  });
}

const CASES = LENGTHS.flatMap((seconds) =>
  BRUSHES.flatMap((brush) =>
    WIDTHS.flatMap((width) =>
      [false, true].map((accumulate) => ({
        label: `${seconds} s: ${brush.name}, ${width.name}${accumulate ? ", accumulate" : ""}`,
        seconds,
        brush,
        width,
        accumulate,
      })),
    ),
  ),
);

// One renderer for the whole run, as the app has: the effects are shared and
// keep targets of the renderer that first drew them.
let renderer: ReturnType<typeof parityRenderer> | null = null;

beforeAll(() => {
  renderer = parityRenderer();
});

afterAll(() => {
  renderer?.dispose();
  renderer = null;
});

function canvas(windowBlocks: number, seconds = 60): ParityCanvas {
  if (!renderer) throw new Error("no renderer");
  const made = parityCanvas(parityData({ durationSeconds: seconds }), windowBlocks, renderer.gl);
  disposers.push(made.dispose);
  return made;
}

describe("a windowed canvas paints what a whole-file canvas paints", () => {
  it("cuts the file into many more blocks than the window holds", () => {
    const windowed = canvas(WINDOW_BLOCKS);
    expect(windowed.canvas.holdsWholeFile).toBe(false);
    expect(windowed.canvas.grid.blockCount).toBeGreaterThan(12);
  });

  it.each(CASES)(
    "$label",
    async ({ seconds, brush, width, accumulate }) => {
      const state = brushState(brush.effect, brush.step, width.beats, accumulate);
      const dabs = [{ x: 0.5, y: 0.5, state }];
      const whole = canvas(Infinity, seconds);
      const windowed = canvas(WINDOW_BLOCKS, seconds);
      const expected = await paintStroke(whole, dabs);
      const got = await paintStroke(windowed, dabs);
      await expectSameStroke(whole, expected, got);
    },
    300_000,
  );
});
