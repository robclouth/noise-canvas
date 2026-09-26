import { commands } from "@vitest/browser/context";
import { Vector2 } from "three";
import { effects } from "../../effects";
import type { State } from "../../store/types";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { DEFAULT_ONSET_SENSITIVITY } from "../constants";
import { getOnsetTexture } from "../onset-map";
import { StrokeRenderer, type SourceFileInfo } from "../stroke-renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paintStroke, parityCanvas, parityRenderer, type ParityData } from "../../test/canvas-parity";
import {
  decodeBase64,
  encodeBase64,
  loadTransformFixture,
  parityDataOf,
  fixtureBrush,
  TRANSFORM_FIXTURE_DIR,
  transformBrush,
  type TransformFixture,
} from "../../test/transform-fixture";
import { bandAtPixel, type BandLayout } from "../band-layout";
import { BRUSH_ANCHOR_MODE_CENTER } from "../constants";

/**
 * What every transform algorithm paints for a spread of moves, on a real
 * analysis (`scripts/transform-fixture.mjs`), against what it painted when
 * VITE_TRANSFORM_GOLDEN=record last ran. Skipped unless VITE_TRANSFORM_GOLDEN
 * is `record` or `check`, because the fixture and the recorded strokes live in
 * the untracked .cache/transform-golden. A recording pins whatever shader made
 * it, so record on the commit before a change and check after it.
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

const ATTRACT_MOVES: { name: string; step: Record<string, unknown> }[] = [
  { name: "pitch pull, source", step: { attractAmountY: 100 } },
  { name: "pitch pull, scale", step: { attractMap: 1, attractAmountY: 100 } },
  { name: "time pull, source", step: { attractAmountX: 100, attractAmountY: 0 } },
  { name: "time pull, grid", step: { attractMap: 2, attractAmountX: 100, attractAmountY: 0 } },
  { name: "pitch and time pull", step: { attractAmountX: 60, attractAmountY: 60 } },
];

const CASES = [
  ...ALGORITHMS.flatMap((algorithm) =>
    MOVES.map((move) => ({
      label: `algorithm ${algorithm}: ${move.name}`,
      key: `a${algorithm}-${move.name}`,
      state: () => transformBrush(algorithm, move.step),
    })),
  ),
  ...ATTRACT_MOVES.map((move) => ({
    label: `attract: ${move.name}`,
    key: `attract-${move.name}`,
    state: () => fixtureBrush("attract", move.step),
  })),
];

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

// Both suites paint through one renderer: the effects keep the targets of the
// renderer that first drew them.
let renderer: ReturnType<typeof parityRenderer> | null = null;
const sharedRenderer = (): ReturnType<typeof parityRenderer> => (renderer ??= parityRenderer());
afterAll(() => renderer?.dispose());

let fixture: TransformFixture | null = null;
let tolerance: Float32Array | null = null;

describe.skipIf(!MODE)("what the transform paints", () => {
  beforeAll(async () => {
    fixture = await loadTransformFixture();
    tolerance = phaseTolerance(fixture);
  });
  it.each(CASES)(
    "$label",
    async ({ key, state }) => {
      const onsets = Float32Array.from(fixture!.onsets);
      const canvas = parityCanvas(parityDataOf(fixture!), Infinity, sharedRenderer().gl, undefined, onsets);
      try {
        const stroke = await paintStroke(canvas, [{ x: 0.42, y: 0.55, state: state() }]);
        expect(stroke.refused).toBeNull();
        const ranges = stroke.ranges!;
        const values = stroke.values!;
        const name = `${TRANSFORM_FIXTURE_DIR}/${key.replace(/[^a-z0-9.+-]+/gi, "_")}`;
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
/** A float holds it exactly, and at 44.1 kHz it is a whole number of the coarsest band's steps. */
const DELAY_SEC = 512;
const HIGHEST_HZ = 700;
/** Phase two paintings may differ by, where a texel is loud. */
const PHASE_TOLERANCE = 0.02;
const LONG_MAGNITUDE_TOLERANCE = 1e-3;
/** The long file's canvas window, in blocks: the dab paints far from the file's start through it. */
const WINDOW_BLOCKS = 6;

const LONG_MOVES: { name: string; step: Record<string, unknown> }[] = [
  { name: "reverse", step: { transformScaleTime: -1 } },
  { name: "shift +1 beat, bleed", step: { transformShiftBeats: 1, transformEdgeMode: 1 } },
  { name: "shift -0.5 beat, bleed", step: { transformShiftBeats: -0.5, transformEdgeMode: 1 } },
  {
    name: "reverse, shift +0.25 beat, bleed",
    step: { transformScaleTime: -1, transformShiftBeats: 0.25, transformEdgeMode: 1 },
  },
];

const LONG_CASES = [
  ...[4, 6].flatMap((algorithm) =>
    LONG_MOVES.map((move) => ({
      label: `algorithm ${algorithm}: ${move.name}`,
      state: (step: Record<string, unknown>) => transformBrush(algorithm, { ...move.step, ...step }),
    })),
  ),
  // Attract moves nothing by a stretch or a stored-phase scale, so it must
  // agree far in on every map.
  ...ATTRACT_MOVES.map((move) => ({
    label: `attract: ${move.name}`,
    state: (step: Record<string, unknown>) => fixtureBrush("attract", { ...move.step, ...step }),
  })),
];

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

let near: TransformFixture | null = null;
let far: TransformFixture | null = null;

describe.skipIf(!MODE)("a transform far into a long file", () => {
  beforeAll(async () => {
    near = lowBands(await loadTransformFixture());
    far = delayed(near, DELAY_SEC * near.sampleRate);
  });

  it.each(LONG_CASES)(
    "$label paints what it paints near the start",
    async ({ state: brush }) => {
      const paint = async (fixture: TransformFixture, windowBlocks: number) => {
        const canvas = parityCanvas(
          parityDataOf(fixture),
          windowBlocks,
          sharedRenderer().gl,
          undefined,
          Float32Array.from(fixture.onsets),
        );
        try {
          const state = brush({ brushAnchorMode: BRUSH_ANCHOR_MODE_CENTER });
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
          magnitude: magnitude < LONG_MAGNITUDE_TOLERANCE,
          phase: beyond <= SEAM_SHARE * checked,
        },
        `${missing} missing of ${at}, ${changedElsewhere} changed elsewhere; magnitude ${magnitude}; ${beyond} of ${checked} texels past ${PHASE_TOLERANCE} rad, worst ${worst}`,
      ).toEqual({ sameFootprint: true, magnitude: true, phase: true });
    },
    300_000,
  );
});

/**
 * What the transform paints on the fixture from a second file analysed at
 * another sample rate and band density: each dest frame reads a source frame
 * at a different rate, and each dest band sits between source bands. Checked
 * against a recording, as the moves on the fixture itself are.
 */
const CROSS_SOURCES = ["48k-36bpo", "48k-12bpo"];
const CROSS_SOURCE_PATH = "/cross-source.wav";
const CROSS_MOVES: { name: string; step: Record<string, unknown> }[] = [
  { name: "paste", step: {} },
  { name: "reverse", step: { transformScaleTime: -1 } },
  { name: "pitch +7", step: { transformShiftSemis: 7 } },
  { name: "shift +1 beat, bleed", step: { transformShiftBeats: 1, transformEdgeMode: 1 } },
];
const CROSS_CASES = CROSS_SOURCES.flatMap((source) =>
  [4, 6].flatMap((algorithm) =>
    CROSS_MOVES.map((move) => ({
      label: `from ${source}, algorithm ${algorithm}: ${move.name}`,
      key: `cross-${source}-a${algorithm}-${move.name}`,
      source,
      algorithm,
      move,
    })),
  ),
);

/** A stroke renderer over the whole of `data`, with its textures, for a test to paint on or from. */
function strokeRendererOver(data: ParityData, id: string): { renderer: StrokeRenderer; dispose: () => void } {
  const textures = createHarnessTextures(data);
  const renderer = new StrokeRenderer(sharedRenderer().gl, data, toStrokeTextures(textures), id, effects);
  renderer.initialize();
  return {
    renderer,
    dispose: () => {
      renderer.dispose();
      disposeHarnessTextures(textures);
    },
  };
}

const crossSources: Record<string, TransformFixture> = {};

describe.skipIf(!MODE)("what the transform paints from another file", () => {
  beforeAll(async () => {
    fixture ??= await loadTransformFixture();
    tolerance ??= phaseTolerance(fixture);
    for (const name of CROSS_SOURCES) crossSources[name] = await loadTransformFixture(name);
  });

  it.each(CROSS_CASES)(
    "$label",
    async ({ key, source, algorithm, move }) => {
      const from = crossSources[source];
      const dest = strokeRendererOver(parityDataOf(fixture!), "cross-dest");
      const read = strokeRendererOver(parityDataOf(from), "cross-source");
      try {
        const textures = read.renderer.getTextures();
        const sourceFile: SourceFileInfo = {
          id: "cross-source",
          filePath: CROSS_SOURCE_PATH,
          displayName: "cross-source.wav",
          spectrogramData: parityDataOf(from),
          textures: {
            packed: textures.packed,
            inverse: textures.inverse,
            metadata: textures.metadata,
            original: textures.original,
          },
          onsetTexture: getOnsetTexture(
            "cross-source",
            Float32Array.from(from.onsets),
            from.numFrames / from.sampleRate,
            DEFAULT_ONSET_SENSITIVITY,
          ),
        };
        const brush = transformBrush(algorithm, move.step);
        const state: State = { ...brush, filepathsBpm: { ...brush.filepathsBpm, [CROSS_SOURCE_PATH]: 120 } };
        dest.renderer.renderStroke(
          {
            cursorPos: new Vector2(0.35, 0.4),
            preview: false,
            bpm: 120,
            totalDuration: fixture!.numFrames / fixture!.sampleRate,
            viewZoomPower: 0,
            viewOffset: 0,
            viewZoomPowerY: 0,
            viewOffsetY: 0,
            pressure: 1,
            tiltX: 0,
            tiltY: 0,
          },
          state,
          sourceFile,
        );
        const values = await dest.renderer.getFBOData();
        const name = `${TRANSFORM_FIXTURE_DIR}/${key.replace(/[^a-z0-9.+-]+/gi, "_")}`;
        if (MODE === "record") {
          await commands.writeFile(`${name}.values`, encodeBase64(new Uint8Array(values.buffer)), "base64");
          return;
        }
        const want = new Float32Array(decodeBase64(await commands.readFile(`${name}.values`, "base64")).buffer);
        expect(values.length).toBe(want.length);
        let magnitude = 0;
        let beyond = 0;
        let changed = 0;
        let worst = 0;
        for (let pixel = 0; pixel < fixture!.texels; pixel++) {
          for (let channel = 0; channel < 2; channel++) {
            const at = pixel * 4 + channel * 2;
            const loud = Math.max(want[at], values[at]);
            magnitude = Math.max(magnitude, Math.abs(want[at] - values[at]) / Math.max(loud, 1e-3));
            const turned = values[at + 1] - want[at + 1];
            const off = Math.abs(turned - 2 * Math.PI * Math.round(turned / (2 * Math.PI))) * Math.min(1, loud / 1e-3);
            if (off / tolerance![pixel] > 1) beyond++;
            if (want[at] !== fixture!.packed[at] || want[at + 1] !== fixture!.packed[at + 1]) changed++;
            worst = Math.max(worst, off / tolerance![pixel]);
          }
        }
        expect(changed, "the recorded stroke changed nothing").toBeGreaterThan(0);
        expect(
          { magnitude: magnitude < MAGNITUDE_TOLERANCE, beyond: beyond <= SEAM_SHARE * changed },
          `magnitude ${magnitude}, ${beyond} of ${changed} changed texels past tolerance, worst ${worst}×`,
        ).toEqual({ magnitude: true, beyond: true });
      } finally {
        read.dispose();
        dest.dispose();
      }
    },
    120_000,
  );
});
