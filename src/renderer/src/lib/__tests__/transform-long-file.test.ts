import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityRenderer } from "../../test/canvas-parity";
import {
  loadTransformFixture,
  parityDataOf,
  transformBrush,
  type TransformFixture,
} from "../../test/transform-fixture";
import { bandAtPixel, type BandLayout } from "../band-layout";
import { BRUSH_ANCHOR_MODE_CENTER } from "../constants";

/**
 * A transform far into a long file paints what it paints near the start. The
 * fixture's audio is set 512 s into a file of silence, its coefficients turned
 * as an analysis turns delayed audio, and a move that neither stretches nor
 * rescales stored phase must then paint the same result, turned the same way.
 * Both brushes sit centred half way through their file: the phase terms count
 * a file's time as (frames − 1)/frames of a frame per frame, which only agrees
 * between two lengths at the same share of each.
 * Only the bands up to 700 Hz are kept, so a file 17 minutes long fits in a
 * test. Skipped unless VITE_TRANSFORM_GOLDEN is set, as the fixture lives in
 * the untracked .cache/transform-golden.
 */
const MODE = import.meta.env.VITE_TRANSFORM_GOLDEN as "record" | "check" | undefined;

/** A float holds it exactly, and at 44.1 kHz it is a whole number of the coarsest band's steps. */
const DELAY_SEC = 512;
const HIGHEST_HZ = 700;
/** Phase two paintings may differ by, where a texel is loud. */
const PHASE_TOLERANCE = 0.02;
const MAGNITUDE_TOLERANCE = 1e-3;
/** Share of texels that may be past tolerance, for the unwrapPhase seam. */
const SEAM_SHARE = 1e-3;
/** The long file's canvas window, in blocks: the dab paints far from the file's start through it. */
const WINDOW_BLOCKS = 6;

const MOVES: { name: string; step: Record<string, unknown> }[] = [
  { name: "reverse", step: { transformScaleTime: -1 } },
  { name: "shift +1 beat, bleed", step: { transformShiftBeats: 1, transformEdgeMode: 1 } },
  { name: "shift -0.5 beat, bleed", step: { transformShiftBeats: -0.5, transformEdgeMode: 1 } },
  {
    name: "reverse, shift +0.25 beat, bleed",
    step: { transformScaleTime: -1, transformShiftBeats: 0.25, transformEdgeMode: 1 },
  },
];

const CASES = [4, 6].flatMap((algorithm) => MOVES.map((move) => ({ algorithm, move })));

/** The fixture's bands up to HIGHEST_HZ, laid out on their own. */
function lowBands(fixture: TransformFixture): TransformFixture {
  const bands = fixture.bandFreqsHz.flatMap((hz, band) => (hz <= HIGHEST_HZ ? [band] : []));
  const bandOffsets: number[] = [];
  let texels = 0;
  for (const band of bands) {
    bandOffsets.push(texels);
    texels += fixture.bandLengths[band];
  }
  const packed = new Float32Array(texels * 4);
  bands.forEach((band, i) => {
    const from = fixture.bandOffsets[band] * 4;
    packed.set(fixture.packed.subarray(from, from + fixture.bandLengths[band] * 4), bandOffsets[i] * 4);
  });
  return withLayout(fixture, {
    bandOffsets,
    bandLengths: bands.map((band) => fixture.bandLengths[band]),
    bandStepLog2s: bands.map((band) => fixture.bandStepLog2s[band]),
    bandFreqsHz: bands.map((band) => fixture.bandFreqsHz[band]),
    numFrames: fixture.numFrames,
    packed,
    onsets: fixture.onsets,
  });
}

/**
 * The fixture's audio `delayFrames` into a file with as much silence after it,
 * so a position half way through either file meets the same audio. A delay
 * turns each band's stored phase by −2π · centre · delay.
 */
function delayed(fixture: TransformFixture, delayFrames: number): TransformFixture {
  const bandLengths = fixture.bandLengths.map(
    (length, band) => length + (2 * delayFrames) / 2 ** fixture.bandStepLog2s[band],
  );
  const bandOffsets: number[] = [];
  let texels = 0;
  for (const length of bandLengths) {
    bandOffsets.push(texels);
    texels += length;
  }
  const packed = new Float32Array(texels * 4);
  for (let band = 0; band < fixture.numBands; band++) {
    const shift = delayFrames / 2 ** fixture.bandStepLog2s[band];
    const cycles = (fixture.bandFreqsHz[band] * delayFrames) / fixture.sampleRate;
    const turn = -2 * Math.PI * (cycles - Math.floor(cycles));
    for (let k = 0; k < fixture.bandLengths[band]; k++) {
      const from = (fixture.bandOffsets[band] + k) * 4;
      const to = (bandOffsets[band] + shift + k) * 4;
      packed[to] = fixture.packed[from];
      packed[to + 1] = fixture.packed[from + 1] + turn;
      packed[to + 2] = fixture.packed[from + 2];
      packed[to + 3] = fixture.packed[from + 3] + turn;
    }
  }
  const delaySec = delayFrames / fixture.sampleRate;
  return withLayout(fixture, {
    bandOffsets,
    bandLengths,
    bandStepLog2s: fixture.bandStepLog2s,
    bandFreqsHz: fixture.bandFreqsHz,
    numFrames: fixture.numFrames + 2 * delayFrames,
    packed,
    onsets: fixture.onsets.map((value, i) => (i % 2 === 0 ? value + delaySec : value)),
  });
}

function withLayout(
  fixture: TransformFixture,
  layout: Pick<
    TransformFixture,
    "bandOffsets" | "bandLengths" | "bandStepLog2s" | "bandFreqsHz" | "numFrames" | "packed" | "onsets"
  >,
): TransformFixture {
  const numBands = layout.bandOffsets.length;
  return {
    ...fixture,
    ...layout,
    numBands,
    texels: layout.packed.length / 4,
    metadata: layout.bandOffsets.flatMap((offset, band) => [
      offset,
      layout.bandLengths[band],
      layout.bandStepLog2s[band],
      layout.bandFreqsHz[band],
    ]),
  };
}

function bandLayoutOfFixture(fixture: TransformFixture): BandLayout {
  return { numBands: fixture.numBands, metadata: Float64Array.from(fixture.metadata) };
}

let renderer: ReturnType<typeof parityRenderer> | null = null;
let near: TransformFixture | null = null;
let far: TransformFixture | null = null;

describe.skipIf(!MODE)("a transform far into a long file", () => {
  beforeAll(async () => {
    renderer = parityRenderer();
    near = lowBands(await loadTransformFixture());
    far = delayed(near, DELAY_SEC * near.sampleRate);
  });
  afterAll(() => renderer?.dispose());

  it.each(CASES)(
    "algorithm $algorithm: $move.name paints what it paints near the start",
    async ({ algorithm, move }) => {
      const paint = async (fixture: TransformFixture, windowBlocks: number) => {
        const canvas = parityCanvas(
          parityDataOf(fixture),
          windowBlocks,
          renderer!.gl,
          undefined,
          Float32Array.from(fixture.onsets),
        );
        try {
          const state = transformBrush(algorithm, { ...move.step, brushAnchorMode: BRUSH_ANCHOR_MODE_CENTER });
          const stroke = await paintStroke(canvas, [{ x: 0.5, y: 0.55, state }]);
          expect(stroke.refused).toBeNull();
          return { ranges: stroke.ranges!, values: stroke.values! };
        } finally {
          canvas.dispose();
        }
      };
      const nearStroke = await paint(near!, Infinity);
      const farStroke = await paint(far!, WINDOW_BLOCKS);

      // Where each far pixel's value sits in the far stroke's values.
      const farIndex = new Map<number, number>();
      let at = 0;
      for (let r = 0; r < farStroke.ranges.length; r += 2) {
        for (let pixel = farStroke.ranges[r]; pixel < farStroke.ranges[r] + farStroke.ranges[r + 1]; pixel++) {
          farIndex.set(pixel, at++);
        }
      }

      const nearLayout = bandLayoutOfFixture(near!);
      const matched = new Set<number>();
      let magnitude = 0;
      let beyond = 0;
      let checked = 0;
      let missing = 0;
      let worst = 0;
      at = 0;
      for (let r = 0; r < nearStroke.ranges.length; r += 2) {
        for (let pixel = nearStroke.ranges[r]; pixel < nearStroke.ranges[r] + nearStroke.ranges[r + 1]; pixel++, at++) {
          const band = bandAtPixel(nearLayout, pixel);
          const k = pixel - near!.bandOffsets[band];
          const farPixel = far!.bandOffsets[band] + (DELAY_SEC * near!.sampleRate) / 2 ** near!.bandStepLog2s[band] + k;
          const farAt = farIndex.get(farPixel);
          if (farAt === undefined) {
            missing++;
            continue;
          }
          matched.add(farPixel);
          for (let channel = 0; channel < 2; channel++) {
            const nearOut = nearStroke.values[at * 4 + channel * 2];
            const farOut = farStroke.values[farAt * 4 + channel * 2];
            const loud = Math.max(nearOut, farOut);
            magnitude = Math.max(magnitude, Math.abs(nearOut - farOut) / Math.max(loud, 1e-3));
            // What the delay turned the input by here, which the painting must turn by too.
            const turnIn = far!.packed[farPixel * 4 + channel * 2 + 1] - near!.packed[pixel * 4 + channel * 2 + 1];
            const turnOut = farStroke.values[farAt * 4 + channel * 2 + 1] - nearStroke.values[at * 4 + channel * 2 + 1];
            const d = turnOut - turnIn;
            const off = Math.abs(d - 2 * Math.PI * Math.round(d / (2 * Math.PI))) * Math.min(1, loud / 1e-3);
            if (off > PHASE_TOLERANCE) beyond++;
            checked++;
            worst = Math.max(worst, off);
          }
        }
      }
      // The far canvas may name more texels than it changed, but only ones it left as they were.
      let changedElsewhere = 0;
      for (const [pixel, index] of farIndex) {
        if (matched.has(pixel)) continue;
        for (let i = 0; i < 4; i++)
          if (farStroke.values[index * 4 + i] !== far!.packed[pixel * 4 + i]) changedElsewhere++;
      }
      expect(
        {
          sameFootprint: missing === 0 && changedElsewhere === 0,
          magnitude: magnitude < MAGNITUDE_TOLERANCE,
          phase: beyond <= SEAM_SHARE * checked,
        },
        `${missing} missing of ${at}, ${changedElsewhere} changed elsewhere; magnitude ${magnitude}; ${beyond} of ${checked} texels past ${PHASE_TOLERANCE} rad, worst ${worst}`,
      ).toEqual({ sameFootprint: true, magnitude: true, phase: true });
    },
    300_000,
  );
});
