import { afterAll, describe, expect, it } from "vitest";
import { Vector2 } from "three";
import type { EffectType } from "../../effects";
import type { State } from "../../store/types";
import {
  outliersByBand,
  paintStroke,
  parityCanvas,
  parityData,
  parityRenderer,
  PARITY_FILE_PATH,
} from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";
import { readRenderTargetPixelsAsync } from "../async-readpixels";
import { packedFold } from "../constants";
import { gatherPixelRanges } from "../pixel-ranges";
import { dabSpan, dispatchStroke } from "../file-stroke-dispatch";

/**
 * On a canvas over the whole file, the hover preview of a brush that wraps
 * round the file past its end draws on the canvas as the file lies, while
 * the dab itself paints on the file turned round; the two show the same.
 */
let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

const CASES: { name: string; effect: EffectType; step: Record<string, unknown> }[] = [
  { name: "a shift", effect: "transform", step: { transformShiftBeats: 3, transformEdgeMode: 1 } },
  { name: "a blur", effect: "blur", step: { blurAmountTime: 50, blurEdgeMode: 1 } },
  { name: "an evolve", effect: "evolve", step: { evolveScaleX: 97, evolveFlow: 2 } },
  { name: "copies", effect: "clone", step: { cloneCountX: 6, cloneSpaceBeats: 1, cloneEdgeMode: 1 } },
];

/** A brush of one effect that wraps round the file in time, anchored at its corner. */
function wrappingBrush(effect: EffectType, step: Record<string, unknown>): State {
  const brush = { ...step, brushWrapMode: 3, brushAnchorMode: 1, brushSizePitch: 24, brushSizeTime: 4 };
  const state = fixtureBrush(effect, { ...brush, effects: [{ id: effect, effect, enabled: true, params: step }] });
  state.filepathsBpm = { ...state.filepathsBpm, [PARITY_FILE_PATH]: 61 };
  return state;
}

describe("the preview of a brush that wraps past the end of the file", () => {
  it.each(
    CASES.flatMap((c) => [
      { ...c, where: "near the end", x: 0.995 },
      { ...c, where: "across the end", x: 0.9995 },
    ]),
  )(
    "shows what $name paints $where",
    async ({ effect, step, x }) => {
      renderer ??= parityRenderer();
      const data = parityData({ durationSeconds: 30 });
      const painted = parityCanvas(data, Infinity, renderer.gl);
      const previewed = parityCanvas(parityData({ durationSeconds: 30 }), Infinity, renderer.gl);
      try {
        const state = wrappingBrush(effect, step);
        const dab = await paintStroke(painted, [{ x, y: 0.5, state }]);
        expect(dab.refused).toBeNull();
        const ranges = dab.ranges ?? new Uint32Array(0);

        const aim = new Vector2(x, 0.5);
        const { canvas, context } = previewed;
        const span = dabSpan(context, state, aim, canvas);
        const { hover, needs } = span;
        expect(canvas.holdsFrames(hover.start, hover.end, needs.original)).toBe(true);
        expect(dispatchStroke(context, state, aim, true, { span })).toBe(true);

        const strokeRenderer = context.strokeRendererRef.current;
        if (!strokeRenderer) throw new Error("the canvas has no renderer");
        const display = strokeRenderer.getPreviewDisplay();
        expect(display.active).toBe(true);
        const target = strokeRenderer["pingPong"] === 0 ? strokeRenderer["fbo2"] : strokeRenderer["fbo1"];
        const { width, height } = packedFold(data.texels);
        const preview = await readRenderTargetPixelsAsync(renderer.gl, target, 0, 0, width, height);
        const committed = await canvas.getFBOData();
        if (!committed) throw new Error("the canvas holds no state");
        const binRanges = display.binRanges.image.data as Float32Array;

        const shown = new Float32Array(ranges.length === 0 ? 0 : (dab.values?.length ?? 0));
        let band = 0;
        let at = 0;
        for (let i = 0; i + 1 < ranges.length; i += 2) {
          for (let pixel = ranges[i]; pixel < ranges[i] + ranges[i + 1]; pixel++, at++) {
            while (band + 1 < data.numBands && data.metadata[(band + 1) * 4] <= pixel) band++;
            const bin = pixel - data.metadata[band * 4];
            const inPreview = bin >= binRanges[band * 4] && bin < binRanges[band * 4 + 1];
            shown.set((inPreview ? preview : committed).subarray(pixel * 4, pixel * 4 + 4), at * 4);
          }
        }
        const before = gatherPixelRanges(committed, ranges);
        const changed = (dab.values ?? new Float32Array(0)).filter((value, i) => value !== before[i]).length;
        expect(changed).toBeGreaterThan(ranges.length);
        for (const [b, entry] of outliersByBand(data, ranges, dab.values ?? new Float32Array(0), shown)) {
          expect(entry.outliers, `band ${b}`).toBe(0);
        }
      } finally {
        painted.dispose();
        previewed.dispose();
      }
    },
    120_000,
  );
});
