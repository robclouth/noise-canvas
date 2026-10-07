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
 * is told settings that would let it paint there, and each of them does. The
 * views beside the canvas are held small, so that a brush refuses at all.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

const max = (key: ParameterKey): number => getNumberParameterDef(key).max;

const CASES: { name: string; effect: EffectType; blocks: number; bpm?: number; step: Record<string, unknown> }[] = [
  {
    name: "Blur at its widest on a slow file",
    effect: "blur",
    blocks: 4,
    bpm: 60,
    step: {
      blurAmountTime: max("blurAmountTime"),
      blurNoiseTime: max("blurNoiseTime"),
      blurAmountPitch: max("blurAmountPitch"),
      blurEdgeMode: 1,
    },
  },
  {
    name: "Evolve at its widest on a slow file",
    effect: "evolve",
    blocks: 4,
    bpm: 60,
    step: { evolveScaleX: max("evolveScaleX"), evolveScaleY: max("evolveScaleY"), evolveFlow: max("evolveFlow") },
  },
];

// The share of a window a view painted beside the canvas may hold here, so
// that a brush reading far refuses and one reading near paints on the canvas.
const BESIDE_SHARE = 1 / 32;

/** A canvas of `blocks` over a long parity file whose views beside it hold only `BESIDE_SHARE` of a window. */
function starvedCanvas(gl: ReturnType<typeof parityRenderer>["gl"], blocks: number): ReturnType<typeof parityCanvas> {
  const target = parityCanvas(parityData({ durationSeconds: 300 }), blocks, gl);
  const budget = Math.floor(target.canvas.texelBudget * BESIDE_SHARE);
  Object.defineProperty(target.canvas, "texelBudget", { get: () => budget });
  return target;
}

/** `state` on a file at `bpm`, or as it is when none is given. */
function atBpm(state: State, bpm: number | undefined): State {
  return bpm ? { ...state, filepathsBpm: { [PARITY_FILE_PATH]: bpm } } : state;
}

describe("settings that let a refused brush paint", () => {
  it.each(CASES)(
    "names settings that paint for $name",
    ({ effect, blocks, bpm, step }) => {
      renderer ??= parityRenderer();
      const target = starvedCanvas(renderer.gl, blocks);
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
    const target = starvedCanvas(renderer.gl, CASES[0].blocks);
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
