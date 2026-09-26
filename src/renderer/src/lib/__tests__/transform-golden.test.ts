import { commands } from "@vitest/browser/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityRenderer } from "../../test/canvas-parity";
import {
  decodeBase64,
  encodeBase64,
  loadTransformFixture,
  parityDataOf,
  TRANSFORM_FIXTURE_DIR,
  transformBrush,
  type TransformFixture,
} from "../../test/transform-fixture";

/**
 * What every transform algorithm paints for a spread of moves, on a real
 * analysis (`scripts/transform-fixture.mjs`), against what it painted when
 * VITE_TRANSFORM_GOLDEN=record last ran. Skipped unless VITE_TRANSFORM_GOLDEN
 * is `record` or `check`, because the fixture and the recorded strokes live in
 * the untracked .cache/transform-golden.
 *
 * A recording is only as exact as the float maths that made it: a phase term
 * that multiplies a band's centre by a time six seconds in carries a rounding
 * of a few float steps of that product. Each band's phase may differ by that
 * much, and a few texels may differ by more, where a blend through
 * unwrapPhase sat on its ±π seam and the rounding tipped it the other way.
 */
const MODE = import.meta.env.VITE_TRANSFORM_GOLDEN as "record" | "check" | undefined;

const ALGORITHMS = [0, 1, 2, 3, 4, 6];

/** Seconds a recorded phase term multiplied a band's centre by, at most: two times across the fixture. */
const RECORDED_SPAN_SEC = 12;
/** Float steps of that product a recorded phase may be out by. */
const RECORDED_STEPS = 4;
/** Share of a case's texels that may be past tolerance, for the unwrapPhase seam. */
const SEAM_SHARE = 1e-3;
/**
 * Magnitude difference a case may have, relative to the texel's level. A read
 * a hundredth of a frame off lands elsewhere on the steep flank of a click.
 */
const MAGNITUDE_TOLERANCE = 3e-3;

const MOVES: { name: string; step: Record<string, unknown> }[] = [
  { name: "reverse", step: { transformScaleTime: -1 } },
  { name: "stretch 0.5", step: { transformScaleTime: 0.5 } },
  { name: "stretch 2", step: { transformScaleTime: 2 } },
  { name: "stretch 0.8", step: { transformScaleTime: 0.8 } },
  { name: "pitch +7", step: { transformShiftSemis: 7 } },
  { name: "pitch -12", step: { transformShiftSemis: -12 } },
  { name: "pitch +0.37", step: { transformShiftSemis: 0.37 } },
  { name: "pitch scale 0.5", step: { transformScalePitch: 0.5 } },
  { name: "pitch scale 2", step: { transformScalePitch: 2 } },
  { name: "pitch flip", step: { transformScalePitch: -1 } },
  { name: "shift +1 beat, bleed", step: { transformShiftBeats: 1, transformEdgeMode: 1 } },
  { name: "shift -0.5 beat, bleed", step: { transformShiftBeats: -0.5, transformEdgeMode: 1 } },
  { name: "speed 1.5", step: { transformSpeed: 1.5 } },
  { name: "speed 0.75", step: { transformSpeed: 0.75 } },
  { name: "turn 30", step: { transformRotation: 30 } },
  { name: "reverse, pitch +5", step: { transformScaleTime: -1, transformShiftSemis: 5 } },
  { name: "stretch 0.5, pitch -3", step: { transformScaleTime: 0.5, transformShiftSemis: -3 } },
  { name: "reverse, wrap", step: { transformScaleTime: -1, transformEdgeMode: 2 } },
  { name: "reverse, reflect", step: { transformScaleTime: -1, transformEdgeMode: 4 } },
];

const CASES = ALGORITHMS.flatMap((algorithm) => MOVES.map((move) => ({ algorithm, move })));

/** The phase each texel may differ by: a float's step at its band's largest product of centre and time, RECORDED_STEPS times, over a floor. */
function phaseTolerance(fixture: TransformFixture): Float32Array {
  const tolerance = new Float32Array(fixture.texels);
  for (let band = 0; band < fixture.numBands; band++) {
    const largest = 2 * Math.PI * fixture.bandFreqsHz[band] * RECORDED_SPAN_SEC;
    const step = 2 ** (Math.floor(Math.log2(largest)) - 23);
    const start = fixture.bandOffsets[band];
    tolerance.fill(1e-3 + RECORDED_STEPS * step, start, start + fixture.bandLengths[band]);
  }
  return tolerance;
}

let renderer: ReturnType<typeof parityRenderer> | null = null;
let fixture: TransformFixture | null = null;
let tolerance: Float32Array | null = null;

describe.skipIf(!MODE)("what the transform paints", () => {
  beforeAll(async () => {
    renderer = parityRenderer();
    fixture = await loadTransformFixture();
    tolerance = phaseTolerance(fixture);
  });
  afterAll(() => renderer?.dispose());

  it.each(CASES)(
    "algorithm $algorithm: $move.name",
    async ({ algorithm, move }) => {
      const onsets = Float32Array.from(fixture!.onsets);
      const canvas = parityCanvas(parityDataOf(fixture!), Infinity, renderer!.gl, undefined, onsets);
      try {
        const stroke = await paintStroke(canvas, [{ x: 0.42, y: 0.55, state: transformBrush(algorithm, move.step) }]);
        expect(stroke.refused).toBeNull();
        const ranges = stroke.ranges!;
        const values = stroke.values!;
        const name = `${TRANSFORM_FIXTURE_DIR}/a${algorithm}-${move.name.replace(/[^a-z0-9.+-]+/gi, "_")}`;
        if (MODE === "record") {
          await commands.writeFile(`${name}.ranges`, encodeBase64(new Uint8Array(ranges.buffer)), "base64");
          await commands.writeFile(`${name}.values`, encodeBase64(new Uint8Array(values.buffer)), "base64");
          return;
        }
        const wantRanges = new Uint32Array(decodeBase64(await commands.readFile(`${name}.ranges`, "base64")).buffer);
        const want = new Float32Array(decodeBase64(await commands.readFile(`${name}.values`, "base64")).buffer);
        expect(Array.from(ranges)).toEqual(Array.from(wantRanges));
        let magnitude = 0;
        let beyond = 0;
        let checked = 0;
        let worst = 0;
        let at = 0;
        for (let r = 0; r < ranges.length; r += 2) {
          for (let pixel = ranges[r]; pixel < ranges[r] + ranges[r + 1]; pixel++) {
            // [magnitude, phase] for each channel, in proportion to how loud the texel is.
            for (let channel = 0; channel < 2; channel++, at += 2) {
              const loud = Math.max(want[at], values[at]);
              magnitude = Math.max(magnitude, Math.abs(want[at] - values[at]) / Math.max(loud, 1e-3));
              const turned = values[at + 1] - want[at + 1];
              const off =
                Math.abs(turned - 2 * Math.PI * Math.round(turned / (2 * Math.PI))) * Math.min(1, loud / 1e-3);
              const over = off / tolerance![pixel];
              if (over > 1) beyond++;
              checked++;
              worst = Math.max(worst, over);
            }
          }
        }
        expect(
          { magnitude: magnitude < MAGNITUDE_TOLERANCE, beyond: beyond <= SEAM_SHARE * checked },
          `magnitude ${magnitude}, ${beyond} of ${checked} texels past tolerance, worst ${worst}×`,
        ).toEqual({ magnitude: true, beyond: true });
      } finally {
        canvas.dispose();
      }
    },
    120_000,
  );
});
