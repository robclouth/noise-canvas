import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";
import { selectionBandRange, selectionFrameRange, selectionMaskTest } from "../selection";
import { lassoSelection } from "../selection-mask";
import { bandIndexToPitchUv, BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "../utils";

/**
 * A stroke over a shaped selection paints exactly the bins the selection's
 * own test holds, through a canvas window as over the whole file, and to the
 * frame however long the selection.
 */
const SECONDS = 600;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

describe("a stroke over a shaped selection", () => {
  it.each([Infinity, 6])(
    "paints the bins the selection holds, with the canvas at %s blocks",
    async (blocks) => {
      renderer ??= parityRenderer();
      const data = parityData({ durationSeconds: SECONDS });
      const canvas = parityCanvas(data, blocks, renderer.gl);
      try {
        // A triangle spanning eight minutes, so a column grid would be seconds wide.
        const selection = lassoSelection(
          [
            { time: 300, pitchUv: 0.7 },
            { time: 60, pitchUv: 0.3 },
            { time: 540, pitchUv: 0.3 },
          ],
          data,
        );
        if (!selection) throw new Error("no selection");
        const state = fixtureBrush("dynamics", {
          dynamicsGainDb: 12,
          brushSizeTime: BRUSH_SIZE_TIME_FULL,
          brushSizePitch: BRUSH_SIZE_PITCH_FULL,
        });
        state.filesSelection = { parity: selection };
        const stroke = await paintStroke(canvas, [{ x: 0.5, y: 0.5, state }]);
        expect(stroke.refused).toBeNull();

        const test = selectionMaskTest(selection, data.sampleRate, data.numBands)!;
        const { lowBand, highBand } = selectionBandRange(selection, data.numBands);

        // The middle row turns on where its scanline meets the triangle's left
        // edge, to within a few milliseconds.
        const midBand = Math.floor((lowBand + highBand) / 2);
        const y = bandIndexToPitchUv(midBand + 0.5, data.numBands);
        const crossSec = 60 + ((y - 0.3) / 0.4) * 240;
        const crossFrame = Math.round(crossSec * data.sampleRate);
        const margin = Math.ceil(0.005 * data.sampleRate);
        expect(test(midBand, crossFrame + margin)).toBe(true);
        expect(test(midBand, crossFrame - margin)).toBe(false);
        const { startFrame, endFrame } = selectionFrameRange(selection, data.sampleRate);
        const painted = new Map<number, number>();
        let at = 0;
        for (let r = 0; r < stroke.ranges!.length; r += 2) {
          for (let p = stroke.ranges![r]; p < stroke.ranges![r] + stroke.ranges![r + 1]; p++, at += 4) {
            painted.set(p, stroke.values![at]);
          }
        }
        let inside = 0;
        const wrong: string[] = [];
        for (let band = lowBand; band <= highBand; band++) {
          const offset = data.metadata[band * 4];
          const bins = data.metadata[band * 4 + 1];
          const step = 2 ** data.metadata[band * 4 + 2];
          for (let k = Math.floor(startFrame / step); k * step < endFrame && k < bins; k++) {
            const edge = k * step;
            if (edge < startFrame) continue;
            const want = test(band, edge);
            const value = painted.get(offset + k) ?? data.packedData[(offset + k) * 4];
            const changed = Math.abs(value - data.packedData[(offset + k) * 4]) > 1e-6;
            if (want) inside++;
            if (changed !== want) wrong.push(`band ${band} frame ${edge}: ${changed ? "painted" : "left"}`);
          }
        }
        expect(inside).toBeGreaterThan(1000);
        expect(wrong.slice(0, 8), `${wrong.length} bins wrong`).toEqual([]);
      } finally {
        canvas.dispose();
      }
    },
    300_000,
  );
});
