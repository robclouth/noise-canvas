import { afterAll, describe, expect, it } from "vitest";
import type { EffectType } from "../../effects";
import { getNumberParameterDef } from "../../parameters";
import type { ParameterKey, State } from "../../store/types";
import { parityCanvas, parityData, parityRenderer, PARITY_FILE_PATH } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";
import { brushPaintsAt, prepareStrokeBatch, strokeRefusal } from "../file-stroke-dispatch";
import { reachFixes } from "../reach-fix";

/**
 * A brush that reads more of a long file than its canvas can hold at a spot
 * is told settings that would let it paint there, and each of them does.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

const max = (key: ParameterKey): number => getNumberParameterDef(key).max;

const CASES: { name: string; effect: EffectType; blocks: number; bpm?: number; step: Record<string, unknown> }[] = [
  {
    name: "Attract at its widest on a slow file",
    effect: "attract",
    blocks: 16,
    bpm: 60,
    step: {
      attractMap: 0,
      attractAmountX: max("attractAmountX"),
      attractAmountY: max("attractAmountY"),
      attractSmoothX: max("attractSmoothX"),
      attractSmoothY: max("attractSmoothY"),
    },
  },
  {
    name: "Evolve at its widest",
    effect: "evolve",
    blocks: 4,
    step: { evolveScaleX: max("evolveScaleX"), evolveScaleY: max("evolveScaleY") },
  },
  {
    name: "Attract at its widest",
    effect: "attract",
    blocks: 4,
    step: {
      attractMap: 0,
      attractAmountX: max("attractAmountX"),
      attractAmountY: max("attractAmountY"),
      attractSmoothX: max("attractSmoothX"),
      attractSmoothY: max("attractSmoothY"),
    },
  },
  {
    name: "Convolve through a long response",
    effect: "convolve",
    blocks: 4,
    step: { convolveIrSize: max("convolveIrSize") },
  },
];

/** `state` on a file at `bpm`, or as it is when none is given. */
function atBpm(state: State, bpm: number | undefined): State {
  return bpm ? { ...state, filepathsBpm: { [PARITY_FILE_PATH]: bpm } } : state;
}

describe("settings that let a refused brush paint", () => {
  it.each(CASES)(
    "names settings that paint for $name",
    ({ effect, blocks, bpm, step }) => {
      renderer ??= parityRenderer();
      const target = parityCanvas(parityData({ durationSeconds: 300 }), blocks, renderer.gl);
      try {
        const state = atBpm(
          fixtureBrush(effect, { ...step, effects: [{ id: effect, effect, enabled: true, params: step }] }),
          bpm,
        );
        const aim = { x: 0.5, y: 0.5 };
        expect(strokeRefusal(target.context, state, aim)).not.toBeNull();

        const fixes = reachFixes(state, (moved) => !brushPaintsAt(target.context, moved, aim), Infinity);
        expect(fixes.length).toBeGreaterThan(0);
        for (const fix of fixes) expect(brushPaintsAt(target.context, fix.fixed, aim), fix.text).toBe(true);
        expect(strokeRefusal(target.context, state, aim)).toMatch(/ Set .+ (to|between) /);
      } finally {
        target.dispose();
      }
    },
    120_000,
  );

  it("hands a fill the dab it could not paint, so the fill can say why", () => {
    renderer ??= parityRenderer();
    const target = parityCanvas(parityData({ durationSeconds: 300 }), 16, renderer.gl);
    try {
      const { effect, step, bpm } = CASES[0];
      const wide = atBpm(
        fixtureBrush(effect, { ...step, effects: [{ id: effect, effect, enabled: true, params: step }] }),
        bpm,
      );
      const plain = atBpm(fixtureBrush("dynamics", { dynamicsGainDb: -6 }), bpm);
      const refused = { state: wide, aimX: 0.5, aimY: 0.5 };
      target.canvas.beginStroke();
      try {
        const batch = prepareStrokeBatch(target.context, target.canvas, [
          { state: plain, aimX: 0.4, aimY: 0.5 },
          refused,
          { state: wide, aimX: 0.6, aimY: 0.5 },
        ]);
        expect(batch).toEqual({ painted: 1, refused });
      } finally {
        target.canvas.endStroke();
      }
    } finally {
      target.dispose();
    }
  });
});
