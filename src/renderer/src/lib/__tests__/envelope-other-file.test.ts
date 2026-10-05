import { afterAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityData, parityRenderer, type ParityData } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";

/**
 * A brush painting from another file, with its gain following that file's
 * level, paints the same onto a short file and a long one: the level is read
 * at the same time of the other file, not at the same share of it.
 */
const AT_SECONDS = 20;
const SOURCE_PATH = "/source.wav";

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

/** A file whose coefficients depend only on their frame and band, with a level that swells over seconds. */
function timedData(seconds: number): ParityData {
  const data = parityData({ durationSeconds: seconds });
  for (let band = 0; band < data.numBands; band++) {
    const offset = data.metadata[band * 4];
    const bins = data.metadata[band * 4 + 1];
    const step = 2 ** data.metadata[band * 4 + 2];
    for (let k = 0; k < bins; k++) {
      const frame = k * step;
      const i = (offset + k) * 4;
      const swell = 0.05 + 0.9 * (0.5 + 0.5 * Math.sin(frame / 700));
      data.packedData[i] = swell * (0.6 + 0.4 * Math.sin(band * 0.7));
      data.packedData[i + 1] = 0;
      data.packedData[i + 2] = swell * (0.6 + 0.4 * Math.cos(band * 0.3));
      data.packedData[i + 3] = 0;
    }
  }
  return data;
}

async function paintedBins(destSeconds: number, step: Record<string, unknown>): Promise<Map<string, number>> {
  renderer ??= parityRenderer();
  const source = parityCanvas(timedData(60), Infinity, renderer.gl, undefined, undefined, {
    id: "source",
    filePath: SOURCE_PATH,
  });
  const data = timedData(destSeconds);
  const dest = parityCanvas(data, Infinity, renderer.gl, undefined, undefined, { others: [source] });
  try {
    const state = fixtureBrush("dynamics", { sourceFile: { path: SOURCE_PATH }, ...step });
    const stroke = await paintStroke(dest, [{ x: AT_SECONDS / destSeconds, y: 0.5, state }]);
    expect(stroke.refused).toBeNull();
    const out = new Map<string, number>();
    let at = 0;
    const ranges = stroke.ranges!;
    for (let r = 0; r < ranges.length; r += 2) {
      for (let p = ranges[r]; p < ranges[r] + ranges[r + 1]; p++, at += 4) {
        let band = 0;
        while (band + 1 < data.numBands && data.metadata[(band + 1) * 4] <= p) band++;
        out.set(`${band}:${p - data.metadata[band * 4]}`, stroke.values![at]);
      }
    }
    return out;
  } finally {
    dest.dispose();
    source.dispose();
  }
}

async function worstBetweenLengths(step: Record<string, unknown>): Promise<{ compared: number; worst: number }> {
  const short = await paintedBins(60, step);
  const long = await paintedBins(240, step);
  let compared = 0;
  let worst = 0;
  for (const [key, value] of short) {
    const other = long.get(key);
    if (other === undefined) continue;
    compared++;
    worst = Math.max(worst, Math.abs(value - other));
  }
  return { compared, worst };
}

describe("painting from another file", () => {
  it("reads the same time of it onto a short file and a long one", async () => {
    const { compared, worst } = await worstBetweenLengths({ dynamicsGainDb: 0 });
    expect(compared).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1e-4);
  }, 120_000);

  it("follows that file's level at the same time onto a short file and a long one", async () => {
    const { compared, worst } = await worstBetweenLengths({
      dynamicsGainDb: 0,
      dynamicsGainDbMod1Amount: 100,
      modulator1Mode: 1,
    });
    expect(compared).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1e-2);
  }, 120_000);
});
