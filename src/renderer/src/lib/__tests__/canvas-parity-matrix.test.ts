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

function brushState(
  effect: EffectType | EffectType[],
  step: Record<string, unknown>,
  beats: number,
  accumulate: boolean,
): State {
  return createStateForEffects(Array.isArray(effect) ? effect : [effect], {
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

const REVERSE = { transformScaleTime: -1, transformEdgeMode: 0 };

/** `state` on a file at `bpm`. */
function atBpm(bpm: number, state: State): State {
  return { ...state, filepathsBpm: { [PARITY_FILE_PATH]: bpm } };
}

// Blocks a window holds that a tile of one block reads more than, for a brush
// that reads a few seconds around itself.
const SMALL_WINDOW_BLOCKS = 4;

/**
 * A stroke that is more than one dab, or a brush more than one step, and the
 * window it paints through when not `WINDOW_BLOCKS`.
 */
const SCENARIOS: {
  name: string;
  windowBlocks?: number;
  dabs: (seconds: number) => { x: number; y: number; state: State }[];
}[] = [
  {
    name: "a wide reversal over overlapping dabs, without Accumulate",
    dabs: () => {
      const state = brushState("transform", REVERSE, 31, false);
      return [
        { x: 0.5, y: 0.5, state },
        { x: 0.52, y: 0.5, state },
      ];
    },
  },
  {
    name: "a wide reversal that runs past the start of the file",
    dabs: () => [{ x: 0.01, y: 0.5, state: brushState("transform", { ...REVERSE, brushAnchorMode: 1 }, 31, false) }],
  },
  {
    name: "a wide blur that wraps round the end of the file",
    dabs: () => [
      {
        x: 0.99,
        y: 0.5,
        state: brushState(
          "blur",
          { blurAmountTime: 25, blurEdgeMode: 1, brushWrapMode: 1, brushAnchorMode: 1 },
          31,
          false,
        ),
      },
    ],
  },
  {
    name: "a short blur that wraps round the end of the file",
    dabs: () => [
      {
        x: 0.999,
        y: 0.5,
        state: brushState(
          "blur",
          { blurAmountTime: 25, blurEdgeMode: 1, brushWrapMode: 1, brushAnchorMode: 1 },
          1,
          false,
        ),
      },
    ],
  },
  {
    name: "a wide reversal whose step names the file it paints",
    dabs: () => [
      {
        x: 0.5,
        y: 0.5,
        state: brushState("transform", { ...REVERSE, sourceFile: { path: PARITY_FILE_PATH } }, 31, false),
      },
    ],
  },
  {
    name: "a transform shifted as far as it goes in time and pitch",
    dabs: () => [
      {
        x: 0.5,
        y: 0.3,
        state: brushState(
          "transform",
          { transformShiftBeats: 32, transformShiftSemis: 96, transformEdgeMode: 1 },
          4,
          false,
        ),
      },
    ],
  },
  {
    name: "an accumulating transform shifted back in time and down in pitch",
    dabs: () => [
      {
        x: 0.5,
        y: 0.7,
        state: brushState(
          "transform",
          { transformShiftBeats: -32, transformShiftSemis: -48, transformEdgeMode: 1 },
          4,
          true,
        ),
      },
    ],
  },
  {
    name: "a disabled narrow step before a wide reversal step",
    dabs: () => {
      const state = brushState("transform", REVERSE, 31, false);
      const steps = state.brushes[state.activeBrushIndex].steps;
      const narrow = brushState("dynamics", { dynamicsGainDb: -20 }, 1, false).brushes[state.activeBrushIndex].steps[0];
      steps.unshift({ ...narrow, id: "disabled-narrow", enabled: false });
      return [{ x: 0.5, y: 0.5, state }];
    },
  },
  {
    name: "a disabled reversal step before a wide Accumulate step",
    dabs: () => {
      const state = brushState("dynamics", { dynamicsGainDb: -20 }, 31, true);
      const steps = state.brushes[state.activeBrushIndex].steps;
      const reverse = brushState("transform", REVERSE, 31, false).brushes[state.activeBrushIndex].steps[0];
      steps.unshift({ ...reverse, id: "disabled-reverse", enabled: false });
      return [{ x: 0.5, y: 0.5, state }];
    },
  },
  {
    name: "an evolve wide in time, cut into tiles of half a block",
    windowBlocks: SMALL_WINDOW_BLOCKS,
    dabs: () => [
      { x: 0.5, y: 0.5, state: atBpm(60, brushState("evolve", { evolveScaleX: 40, brushSizePitch: 24 }, 4, false)) },
    ],
  },
  {
    name: "an evolve wide in pitch, cut into tiles of a sixteenth of a block",
    windowBlocks: SMALL_WINDOW_BLOCKS,
    dabs: () => [
      { x: 0.5, y: 0.5, state: atBpm(60, brushState("evolve", { evolveScaleY: 60, brushSizePitch: 24 }, 4, false)) },
    ],
  },
  {
    name: "an evolve then a sort both ways, cut into tiles of half a block",
    windowBlocks: SMALL_WINDOW_BLOCKS,
    dabs: () => [
      {
        x: 0.37,
        y: 0.5,
        state: atBpm(
          60,
          brushState(["evolve", "sort"], { evolveScaleY: 40, sortDirection: 2, brushSizePitch: 24 }, 4, false),
        ),
      },
    ],
  },
  {
    name: "a transform stretching time 100 times, on a small window",
    windowBlocks: SMALL_WINDOW_BLOCKS,
    // A whole-file canvas places a read through one float over the file, so
    // a 100-times stretch, which reads between bins everywhere, is compared
    // near the start, where that float is fine enough.
    dabs: (seconds) => [
      {
        x: 6 / seconds,
        y: 0.5,
        state: brushState(
          "transform",
          { transformScaleTime: 0.01, transformEdgeMode: 1, brushSizePitch: 24 },
          4,
          false,
        ),
      },
    ],
  },
  {
    name: "a blur at its widest at 60 bpm, on a small window",
    windowBlocks: SMALL_WINDOW_BLOCKS,
    dabs: () => [
      {
        x: 0.5,
        y: 0.5,
        state: atBpm(
          60,
          brushState(
            "blur",
            { blurAmountTime: 100, blurNoiseTime: 100, blurAmountPitch: 100, blurNoisePitch: 100, blurEdgeMode: 1 },
            2,
            false,
          ),
        ),
      },
    ],
  },
];

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

  it.each(LENGTHS.flatMap((seconds) => SCENARIOS.map((scenario) => ({ seconds, scenario }))))(
    "$seconds s: $scenario.name",
    async ({ seconds, scenario }) => {
      const dabs = scenario.dabs(seconds);
      const whole = canvas(Infinity, seconds);
      const windowed = canvas(scenario.windowBlocks ?? WINDOW_BLOCKS, seconds);
      const expected = await paintStroke(whole, dabs);
      const got = await paintStroke(windowed, dabs);
      expect(await expectSameStroke(whole, expected, got)).toBeGreaterThan(0);
    },
    300_000,
  );
});
