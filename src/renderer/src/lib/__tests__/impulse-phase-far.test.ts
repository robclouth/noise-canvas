import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer, type ParityData } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";

/**
 * An impulse painted far into a long file is as exact as one near its start:
 * every band's phase is −2π·f·T for the one time T the brush starts at. The
 * test file runs at 256 Hz for twenty minutes, so f·T reaches 1.5e5 turns,
 * where a float product of f and T is out by a twentieth of a radian.
 */
const SECONDS = 1200;
const SAMPLE_RATE = 256;
/** Window blocks: the dab paints through a canvas holding a span of the file. */
const WINDOW_BLOCKS = 6;
/** Radians a band may sit off the one start time. */
const PHASE_TOLERANCE = 5e-3;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

/** The band each pixel of `ranges` lies in, from the packed band offsets. */
function bandOfPixel(data: ParityData, pixel: number): number {
  let lo = 0;
  let hi = data.numBands - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (data.metadata[mid * 4] <= pixel) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Distance of x from the nearest whole number. */
const offTurn = (x: number): number => Math.abs(x - Math.round(x));

/**
 * The start time, searched around `near` in steps of `step` frames, that the
 * painted phases agree with best, and the worst band's distance from it in
 * radians.
 */
function bestStart(
  phases: { rate: number; phase: number }[],
  near: number,
  span: number,
  step: number,
): { start: number; worst: number } {
  let best = { start: near, worst: Infinity };
  for (let t = near - span; t <= near + span; t += step) {
    let worst = 0;
    for (const { rate, phase } of phases) {
      worst = Math.max(worst, offTurn(phase / (2 * Math.PI) + rate * t));
      if (worst >= best.worst) break;
    }
    if (worst < best.worst) best = { start: t, worst };
  }
  return { start: best.start, worst: best.worst * 2 * Math.PI };
}

describe("an impulse far into a long file", () => {
  it.each([0.02, 0.97])(
    "puts every band on one start time at %s of the file",
    async (x) => {
      renderer ??= parityRenderer();
      const data = parityData({ durationSeconds: SECONDS, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
      const canvas = parityCanvas(data, WINDOW_BLOCKS, renderer.gl);
      try {
        const state = fixtureBrush("synthesize", {
          effects: [{ id: "impulse", effect: "synthesize", enabled: true, params: { synthesizeBrushType: 2 } }],
        });
        const stroke = await paintStroke(canvas, [{ x, y: 0.5, state }]);
        expect(stroke.refused).toBeNull();
        const ranges = stroke.ranges!;
        const values = stroke.values!;

        // The middle pixel of each band's run lies inside the brush's time
        // span; a band the brush covers in pitch has changed it.
        const original = parityData({
          durationSeconds: SECONDS,
          sampleRate: SAMPLE_RATE,
          bandsPerOctave: 4,
        }).packedData;
        const phases: { rate: number; phase: number }[] = [];
        let at = 0;
        for (let r = 0; r < ranges.length; r += 2) {
          const pixel = ranges[r] + (ranges[r + 1] >> 1);
          const value = at + (ranges[r + 1] >> 1) * 4;
          at += ranges[r + 1] * 4;
          if (Math.abs(values[value + 1] - original[pixel * 4 + 1]) < 1e-3) continue;
          const band = bandOfPixel(data, pixel);
          phases.push({ rate: data.metadata[band * 4 + 3] / SAMPLE_RATE, phase: values[value + 1] });
        }
        expect(phases.length).toBeGreaterThan(3);

        const near = x * data.numFrames;
        const coarse = bestStart(phases, near, 2048, 1 / 16);
        const fine = bestStart(phases, coarse.start, 1 / 16, 1 / 4096);
        expect(fine.worst, `start ${fine.start} of ${data.numFrames} frames`).toBeLessThan(PHASE_TOLERANCE);
      } finally {
        canvas.dispose();
      }
    },
    120_000,
  );
});
