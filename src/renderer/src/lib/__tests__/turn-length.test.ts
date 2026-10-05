import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer, type ParityData } from "../../test/canvas-parity";
import { transformBrush } from "../../test/transform-fixture";

/**
 * A turned Transform paints the same on a short file and a long one: the turn
 * lays beats onto semitones, so neither the file's length nor the span the
 * canvas holds changes it. Both files hold the same sound at the same times.
 */
const AT_SECONDS = 20;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

/** A file of `seconds` whose coefficients depend only on their frame and band. */
function timedData(seconds: number): ParityData {
  const data = parityData({ durationSeconds: seconds });
  for (let band = 0; band < data.numBands; band++) {
    const offset = data.metadata[band * 4];
    const bins = data.metadata[band * 4 + 1];
    const step = 2 ** data.metadata[band * 4 + 2];
    for (let k = 0; k < bins; k++) {
      const frame = k * step;
      const i = (offset + k) * 4;
      data.packedData[i] = 0.5 + 0.4 * Math.sin(frame / 37 + band * 0.7);
      data.packedData[i + 1] = 0;
      data.packedData[i + 2] = 0.5 + 0.4 * Math.cos(frame / 53 + band * 0.3);
      data.packedData[i + 3] = 0;
    }
  }
  return data;
}

/** The painted values by band and bin. */
async function paintedBins(seconds: number, windowBlocks: number): Promise<Map<string, number[]>> {
  renderer ??= parityRenderer();
  const data = timedData(seconds);
  const canvas = parityCanvas(data, windowBlocks, renderer.gl);
  try {
    const state = transformBrush(4, { transformRotation: 30, transformEdgeMode: 1 });
    const stroke = await paintStroke(canvas, [{ x: AT_SECONDS / seconds, y: 0.5, state }]);
    expect(stroke.refused).toBeNull();
    const out = new Map<string, number[]>();
    let at = 0;
    const ranges = stroke.ranges!;
    for (let r = 0; r < ranges.length; r += 2) {
      for (let p = ranges[r]; p < ranges[r] + ranges[r + 1]; p++, at += 4) {
        let band = 0;
        while (band + 1 < data.numBands && data.metadata[(band + 1) * 4] <= p) band++;
        const k = p - data.metadata[band * 4];
        out.set(`${band}:${k}`, [stroke.values![at], stroke.values![at + 2]]);
      }
    }
    return out;
  } finally {
    canvas.dispose();
  }
}

describe("a turned transform", () => {
  it("paints the same on a 60-second file and a 240-second one", async () => {
    const short = await paintedBins(60, Infinity);
    const long = await paintedBins(240, 4);
    let compared = 0;
    let worst = 0;
    for (const [key, values] of short) {
      const other = long.get(key);
      if (!other) continue;
      compared++;
      worst = Math.max(worst, Math.abs(values[0] - other[0]), Math.abs(values[1] - other[1]));
    }
    expect(compared).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-3);
  }, 120_000);
});
