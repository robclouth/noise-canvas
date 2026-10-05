import { afterAll, describe, expect, it } from "vitest";
import {
  paintStroke,
  parityCanvas,
  parityData,
  parityRenderer,
  worstDifference,
  type ParityData,
} from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";

/**
 * Attract pulling toward a picked field file paints the same whether the file
 * it paints and the field file each hold the whole file or a window of it.
 */
const SECONDS = 120;
const FIELD_PATH = "/field.wav";

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

/** A field that differs from the painted file everywhere. */
function fieldData(): ParityData {
  const data = parityData({ durationSeconds: SECONDS });
  for (let i = 0; i < data.packedData.length; i += 2) data.packedData[i] = 1 - data.packedData[i];
  return data;
}

async function paintWith(destBlocks: number, fieldBlocks: number, fieldPath: string | null = FIELD_PATH) {
  renderer ??= parityRenderer();
  const field = parityCanvas(fieldData(), fieldBlocks, renderer.gl, undefined, undefined, {
    id: "field",
    filePath: FIELD_PATH,
  });
  const dest = parityCanvas(parityData({ durationSeconds: SECONDS }), destBlocks, renderer.gl, undefined, undefined, {
    others: [field],
  });
  const state = fixtureBrush("attract", {
    attractAmountY: 100,
    attractMap: 0,
    attractSourceFile: fieldPath ? { path: fieldPath } : null,
  });
  try {
    const stroke = await paintStroke(dest, [{ x: 0.81, y: 0.5, state }]);
    expect(stroke.refused).toBeNull();
    return { ranges: stroke.ranges!, values: stroke.values!, dest, field };
  } catch (error) {
    dest.dispose();
    field.dispose();
    throw error;
  }
}

describe("attract toward a picked field file", () => {
  it.each([
    [2, Infinity],
    [Infinity, 2],
    [2, 2],
  ])(
    "paints with the painted file at %s blocks and the field at %s as with both whole",
    async (d, f) => {
      const want = await paintWith(Infinity, Infinity);
      const have = await paintWith(d, f);
      try {
        const wantValues = await want.dest.canvas.readPixelRanges(have.ranges);
        const diff = worstDifference(wantValues, have.values);
        expect(diff.magnitude).toBeLessThan(1e-4);
        expect(diff.phase).toBeLessThan(1e-2);
        // The field file, not the painted one, shaped the pull.
        const selfField = await paintWith(Infinity, Infinity, null);
        try {
          const selfValues = await selfField.dest.canvas.readPixelRanges(have.ranges);
          expect(worstDifference(selfValues, have.values).magnitude).toBeGreaterThan(1e-2);
        } finally {
          selfField.dest.dispose();
          selfField.field.dispose();
        }
      } finally {
        for (const run of [want, have]) {
          run.dest.dispose();
          run.field.dispose();
        }
      }
    },
    120_000,
  );
});
