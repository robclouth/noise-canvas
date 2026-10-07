import { afterAll, describe, expect, it } from "vitest";
import type { EffectType } from "../../effects";
import { getNumberParameterDef } from "../../parameters";
import type { ParameterKey, State } from "../../store/types";
import { parityCanvas, parityData, parityRenderer, PARITY_FILE_PATH } from "../../test/canvas-parity";
import { REACH_CASES } from "../../test/reach-cases";
import { fixtureBrush } from "../../test/transform-fixture";
import { strokeRefusal } from "../file-stroke-dispatch";

/**
 * No brush is refused on a long file whose canvas holds only a few blocks of
 * it: every effect at its widest, as the first step, after another step,
 * and repeated.
 */
const SECONDS = 300;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

const max = (key: ParameterKey): number => getNumberParameterDef(key).max;

type Census = { name: string; effect: EffectType; step: Record<string, unknown>; bpm?: number; y?: number };

const WIDEST: Census[] = [
  {
    name: "Evolve at its widest on a slow file",
    effect: "evolve",
    bpm: 60,
    step: { evolveScaleX: max("evolveScaleX"), evolveScaleY: max("evolveScaleY"), evolveFlow: max("evolveFlow") },
  },
  {
    name: "Attract toward a modulator at its widest",
    effect: "attract",
    step: {
      attractMap: 3,
      attractAmountX: max("attractAmountX"),
      attractAmountY: max("attractAmountY"),
      attractSmoothX: max("attractSmoothX"),
      attractSmoothY: max("attractSmoothY"),
    },
  },
  {
    name: "Attract toward the sound at its widest",
    effect: "attract",
    step: {
      attractMap: 0,
      attractAmountX: max("attractAmountX"),
      attractAmountY: max("attractAmountY"),
      attractSmoothX: max("attractSmoothX"),
      attractSmoothY: max("attractSmoothY"),
    },
  },
  {
    name: "Attract toward another file at its widest",
    effect: "attract",
    step: {
      attractMap: 0,
      attractSourceFile: { path: PARITY_FILE_PATH },
      attractAmountX: max("attractAmountX"),
      attractAmountY: max("attractAmountY"),
      attractSmoothX: max("attractSmoothX"),
      attractSmoothY: max("attractSmoothY"),
    },
  },
  {
    name: "Convolve from an IR Start a pattern sweeps",
    effect: "convolve",
    step: {
      convolveIrSize: max("convolveIrSize"),
      convolveIrTimeOffset: 50,
      modulator1Mode: 0,
      modulator1PatternShape: 0,
      convolveIrTimeOffsetMod1Amount: 100,
    },
  },
];

const BRUSHES: Census[] = [
  ...(Object.entries(REACH_CASES) as [EffectType, Census[]][]).flatMap(([effect, cases]) =>
    cases.map((c) => ({ ...c, effect })),
  ),
  ...WIDEST,
];

/** The brush of one effect, and the step that holds it. */
function brushOf({ effect, step, bpm }: Census): State {
  const state = fixtureBrush(effect, { ...step, effects: [{ id: effect, effect, enabled: true, params: step }] });
  if (bpm) state.filepathsBpm = { ...state.filepathsBpm, [PARITY_FILE_PATH]: bpm };
  return state;
}

const WAYS: { name: string; blocks: number; x: number; shape: (state: State) => State }[] = [
  { name: "first step", blocks: 4, x: 0.5, shape: (state) => state },
  {
    name: "after a Dynamics step",
    blocks: 4,
    x: 0.5,
    shape: (state) => {
      const brush = state.brushes[state.activeBrushIndex];
      const before = fixtureBrush("dynamics", { dynamicsGainDb: -6 }).brushes[state.activeBrushIndex].steps[0];
      brush.steps.unshift({ ...before, id: "census-dynamics" });
      return state;
    },
  },
  {
    name: "three iterations",
    blocks: 4,
    x: 0.5,
    shape: (state) => {
      const step = state.brushes[state.activeBrushIndex].steps[0];
      Object.assign(step, { brushIterations: 3 });
      return state;
    },
  },
];

describe("no brush is refused on a long file", () => {
  it.each(WAYS.flatMap((way) => BRUSHES.map((brush) => ({ ...brush, way }))))(
    "$name, $way.name",
    (census) => {
      renderer ??= parityRenderer();
      const target = parityCanvas(parityData({ durationSeconds: SECONDS }), census.way.blocks, renderer.gl);
      try {
        const state = census.way.shape(brushOf(census));
        expect(strokeRefusal(target.context, state, { x: census.way.x, y: census.y ?? 0.5 })).toBeNull();
      } finally {
        target.dispose();
      }
    },
    120_000,
  );
});
