import { afterAll, describe, expect, it } from "vitest";
import type { EffectType } from "../../effects";
import { paintStroke, parityCanvas, parityData, parityRenderer, type ParityData } from "../../test/canvas-parity";
import { fixtureBrush } from "../../test/transform-fixture";
import { dabReadRegion } from "../file-stroke-dispatch";
import { gatherPixelRanges } from "../pixel-ranges";

/**
 * Every brush reads only inside the region the planner says it reads. The
 * file outside that region is replaced with other values, and the same dab
 * must paint exactly what it paints on the file as it is. A planner that reads
 * too little would cut a long file's tiles, and the stroke's own passes, short
 * of what the shader reads.
 */
const SECONDS = 60;
// Blocks the planning canvas holds; the dab itself paints on whole-file canvases.
const WINDOW_BLOCKS = 6;

let renderer: ReturnType<typeof parityRenderer> | null = null;
afterAll(() => renderer?.dispose());

/** A sine pattern on modulator 1 driving `keys` at full amount. */
const sweeping = (...keys: string[]): Record<string, unknown> => ({
  modulator1Mode: 0,
  modulator1PatternShape: 0,
  ...Object.fromEntries(keys.map((key) => [`${key}Mod1Amount`, 100])),
});

const CASES: { name: string; effect: EffectType; step: Record<string, unknown>; bpm?: number; y?: number }[] = [
  {
    name: "Blur at its widest",
    effect: "blur",
    step: { blurAmountTime: 100, blurNoiseTime: 100, blurAmountPitch: 100, blurNoisePitch: 100, blurEdgeMode: 1 },
    bpm: 60,
  },
  {
    name: "Repeat forward, accelerating, both axes",
    effect: "clone",
    step: {
      cloneCountX: 5,
      cloneSpaceBeats: 1,
      cloneShapeX: "geometric",
      cloneCountY: 4,
      cloneSpaceSemis: 2,
      cloneShapeY: "geometric",
      cloneEdgeMode: 1,
    },
  },
  {
    name: "Repeat up in pitch, accelerating",
    effect: "clone",
    step: {
      brushSizePitch: 6,
      cloneCountY: 3,
      cloneSpaceSemis: 3,
      cloneShapeY: "geometric",
      cloneDirectionY: 2,
      cloneDecay: 0,
      cloneEdgeMode: 1,
    },
    y: 0.2,
  },
  {
    name: "Repeat backward with a negative gap",
    effect: "clone",
    step: { cloneCountX: 6, cloneSpaceBeats: -2, cloneDirectionX: 2, cloneEdgeMode: 1 },
  },
  {
    name: "Repeat from the middle, harmonic in pitch",
    effect: "clone",
    step: {
      cloneCountX: 7,
      cloneSpaceBeats: 1.5,
      cloneDirectionX: 1,
      cloneCountY: 6,
      cloneSpaceSemis: 5,
      cloneShapeY: "harmonic",
      cloneDirectionY: 1,
      cloneEdgeMode: 1,
    },
  },
  {
    name: "Repeat with a modulated gap",
    effect: "clone",
    step: { cloneCountX: 4, cloneSpaceBeats: 1, cloneEdgeMode: 1, ...sweeping("cloneSpaceBeats") },
  },
  { name: "Evolve at its defaults", effect: "evolve", step: {} },
  { name: "Evolve at its widest", effect: "evolve", step: { evolveScaleX: 100, evolveScaleY: 100, evolveFlow: 100 } },
  { name: "Evolve without flow", effect: "evolve", step: { evolveFlow: 0, evolveScaleX: 100, evolveScaleY: 100 } },
  {
    name: "Transform scale swept by a pattern",
    effect: "transform",
    step: { transformScaleTime: 0.5, transformEdgeMode: 1, ...sweeping("transformScaleTime") },
  },
  {
    name: "Transform speed swept by a pattern",
    effect: "transform",
    step: { transformSpeed: 1.5, transformEdgeMode: 1, ...sweeping("transformSpeed") },
  },
  {
    name: "Transform rotation swept by a pattern",
    effect: "transform",
    step: { transformRotation: 20, transformEdgeMode: 1, ...sweeping("transformRotation") },
  },
  {
    name: "Transform shifted far",
    effect: "transform",
    step: { transformShiftBeats: -6, transformShiftSemis: 30, transformEdgeMode: 1 },
  },
  { name: "Convolve, long and backward", effect: "convolve", step: { convolveIrSize: 256, convolveIrRate: -2 } },
  {
    name: "Convolve with IR Start swept",
    effect: "convolve",
    step: { convolveIrSize: 128, convolveIrTimeOffset: 40, ...sweeping("convolveIrTimeOffset") },
  },
  { name: "Attract", effect: "attract", step: { attractMap: 0, attractAmountX: 100, attractAmountY: 100 } },
  { name: "Sort both ways", effect: "sort", step: { sortDirection: 2 } },
  { name: "Transmute to time", effect: "transmute", step: { transmuteTo: 2, transmuteAmount: 4 } },
];

/** A copy of the file with every bin outside `inside` given other values. */
function outsideReplaced(
  data: ParityData,
  inside: (band: number, start: number, end: number) => boolean,
): Float32Array {
  const out = data.packedData.slice();
  for (let band = 0; band < data.numBands; band++) {
    const offset = data.metadata[band * 4];
    const length = data.metadata[band * 4 + 1];
    const step = 2 ** data.metadata[band * 4 + 2];
    for (let k = 0; k < length; k++) {
      if (inside(band, k * step, (k + 1) * step)) continue;
      const at = (offset + k) * 4;
      out[at] = 0.97 - out[at] * 0.5;
      out[at + 1] += 1.7;
      out[at + 2] = 0.93 - out[at + 2] * 0.5;
      out[at + 3] -= 2.3;
    }
  }
  return out;
}

/** The pixels of `ranges` inside the region, as ranges: the rest are not written from reads. */
function insidePixels(
  data: ParityData,
  ranges: Uint32Array,
  inside: (band: number, start: number, end: number) => boolean,
): Uint32Array {
  const out: number[] = [];
  for (let r = 0; r < ranges.length; r += 2) {
    for (let pixel = ranges[r]; pixel < ranges[r] + ranges[r + 1]; pixel++) {
      let band = 0;
      while (band + 1 < data.numBands && data.metadata[(band + 1) * 4] <= pixel) band++;
      const k = pixel - data.metadata[band * 4];
      const step = 2 ** data.metadata[band * 4 + 2];
      if (inside(band, k * step, (k + 1) * step)) out.push(pixel, 1);
    }
  }
  return Uint32Array.from(out);
}

/**
 * What a dab paints on a whole-file canvas holding `packed`: the ranges it
 * changes and the state after it. With `everyRow` its passes write every row
 * of the file, not only the rows its pitch reach says later passes read.
 */
async function paintedOver(
  gl: ReturnType<typeof parityRenderer>["gl"],
  packed: Float32Array,
  dab: { x: number; y: number; state: ReturnType<typeof fixtureBrush> },
  everyRow = false,
): Promise<{ ranges: Uint32Array | null; state: Float32Array | null }> {
  const data = parityData({ durationSeconds: SECONDS });
  data.packedData.set(packed);
  const whole = parityCanvas(data, Infinity, gl);
  const renderer = whole.context.strokeRendererRef.current;
  if (everyRow && renderer) renderer.calculateScissorRows = () => null;
  try {
    const stroke = await paintStroke(whole, [dab]);
    expect(stroke.refused).toBeNull();
    return { ranges: stroke.ranges, state: await whole.canvas.getFBOData() };
  } finally {
    whole.dispose();
  }
}

describe("what a brush reads", () => {
  it.each(CASES.flatMap((c) => [0.3, 0.7].map((x) => ({ ...c, x }))))(
    "$name at $x stays inside its planned region",
    async ({ effect, step, bpm, x, y }) => {
      renderer ??= parityRenderer();
      const data = parityData({ durationSeconds: SECONDS });
      const planner = parityCanvas(data, WINDOW_BLOCKS, renderer.gl);
      const state = fixtureBrush(effect, { ...step, effects: [{ id: effect, effect, enabled: true, params: step }] });
      if (bpm) state.filepathsBpm = { ...state.filepathsBpm, "/parity.wav": bpm };
      const dab = { x, y: y ?? 0.5, state };
      try {
        const region = dabReadRegion(planner.context, state, dab);
        expect(region).not.toBeNull();
        const { beside, canvas, apart } = region!;
        const readApart = (start: number, end: number) => apart.some((span) => start < span.end && end > span.start);
        const want = await paintedOver(renderer.gl, data.packedData, dab);
        expect(want.ranges, "the dab paints").not.toBeNull();
        const full = await paintedOver(renderer.gl, data.packedData, dab, true);
        const painted = gatherPixelRanges(want.state!, want.ranges!);
        const unscissored = gatherPixelRanges(full.state!, want.ranges!);
        let rowsWorst = 0;
        for (let i = 0; i < painted.length; i++) rowsWorst = Math.max(rowsWorst, Math.abs(painted[i] - unscissored[i]));
        expect(rowsWorst, "the passes skip rows a later pass reads").toBe(0);

        const regions = {
          beside: (band: number, start: number, end: number) =>
            readApart(start, end) ||
            (band >= beside.bands.first &&
              band <= beside.bands.last &&
              start < beside.frames.end &&
              end > beside.frames.start),
          canvas: (_band: number, start: number, end: number) =>
            readApart(start, end) || (start < canvas.end && end > canvas.start),
        };
        for (const [name, inside] of Object.entries(regions)) {
          const got = await paintedOver(renderer.gl, outsideReplaced(data, inside), dab);
          const ranges = insidePixels(data, want.ranges!, inside);
          const a = gatherPixelRanges(want.state!, ranges);
          const b = gatherPixelRanges(got.state!, ranges);
          let worst = 0;
          for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
          expect(worst, `the ${name} region misses a read`).toBe(0);
        }
      } finally {
        planner.dispose();
      }
    },
    120_000,
  );
});
