import { Vector2 } from "three";
import { expect } from "vitest";
import { effects } from "../effects";
import { dabSpan, paintDab, strokeRefusal, type FileStrokeContext } from "../lib/file-stroke-dispatch";
import { disposeOnsetTexture } from "../lib/onset-map";
import { float32BitsEqual, gatherPixelRanges, subtractPixelRanges } from "../lib/pixel-ranges";
import { StrokeRenderer, type EffectsRegistry } from "../lib/stroke-renderer";
import { WindowedCanvas } from "../lib/windowed-canvas";
import { createStepStateView } from "../store";
import type { SpectrogramData, State } from "../store/types";
import { createConstantQMockSpectrogramData } from "./mock-spectrogram";
import { createGL, createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "./render-harness";
import type { WebGLRenderer } from "three";

/**
 * The one renderer every canvas of a parity case draws with, as the app's
 * canvases share one: the effects are shared too, and keep targets of the
 * renderer that first drew them.
 */
export function parityRenderer(): { gl: WebGLRenderer; dispose: () => void } {
  const gl = createGL();
  return {
    gl,
    dispose: () => {
      gl.forceContextLoss();
      gl.dispose();
    },
  };
}

/** A value in [0, 1) that repeats nowhere along the file. */
function hash(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Spectrogram data every canvas of a parity test paints on, its own copy each time. */
export type ParityData = SpectrogramData & { packedData: Float32Array };

/** Texels the parity values change smoothly over. */
const SMOOTH_TEXELS = 16;

/**
 * A file with every texel its own value, smooth over a few texels so reads
 * between them interpolate, and repeating nowhere, so a read from the wrong
 * place shows. Each call returns a fresh copy of the same values.
 */
export function parityData(
  options: { durationSeconds?: number; sampleRate?: number; bandsPerOctave?: number; minFreq?: number } = {},
): ParityData {
  const data = createConstantQMockSpectrogramData({
    durationSeconds: options.durationSeconds ?? 60,
    sampleRate: options.sampleRate ?? 256,
    bandsPerOctave: options.bandsPerOctave ?? 24,
    minFreq: options.minFreq ?? 4,
  });
  const packed = data.packedData;
  const smooth = (i: number, seed: number) => {
    const at = i / SMOOTH_TEXELS;
    const k = Math.floor(at);
    const t = at - k;
    return hash(k + seed) * (1 - t) + hash(k + 1 + seed) * t;
  };
  for (let i = 0; i < packed.length / 4; i++) {
    packed[i * 4] = 0.05 + 0.9 * smooth(i, 0);
    packed[i * 4 + 1] = (smooth(i, 1e6) - 0.5) * 6;
    packed[i * 4 + 2] = 0.05 + 0.9 * smooth(i, 2e6);
    packed[i * 4 + 3] = (smooth(i, 3e6) - 0.5) * 6;
  }
  return data;
}

/** One file's painting canvas in a parity test. */
export type ParityCanvas = {
  data: ParityData;
  context: FileStrokeContext;
  canvas: WindowedCanvas;
  dispose: () => void;
};

export const PARITY_FILE_PATH = "/parity.wav";

/**
 * A painting canvas over `data`, holding `windowBlocks` blocks of it, or all
 * of it for `Infinity`, wired to the real stroke dispatch with every effect.
 */
export function parityCanvas(
  data: ParityData,
  windowBlocks: number,
  gl: WebGLRenderer,
  registry: EffectsRegistry = effects,
  onsets?: Float32Array,
): ParityCanvas {
  const textures = createHarnessTextures(data);
  const strokeRendererRef: FileStrokeContext["strokeRendererRef"] = { current: null };
  const read = async (ranges: Uint32Array) => gatherPixelRanges(data.packedData, ranges);
  const canvas = new WindowedCanvas({
    gl,
    spectrogram: data,
    renderer: () => strokeRendererRef.current,
    readCurrent: read,
    readRoot: read,
    onChanged: () => {},
    // The file's own blocks, for a convolve step that filters through it.
    sourceBlocks: (fileId) =>
      fileId === "parity" ? { spectrogram: data, readCurrent: read, readRoot: read, revision: () => 0 } : null,
    windowBlocks,
  });
  const view = canvas.firstView(0, 1);
  const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "parity", registry, view);
  strokeRendererRef.current = renderer;
  canvas.initialize(null);
  const file = {
    id: "parity",
    filePath: PARITY_FILE_PATH,
    displayName: "parity.wav",
    spectrogramData: data,
    onsets,
    rendererRef: {
      current: { getTextures: () => renderer.getTextures(), getCanvasView: () => renderer.committedSource().view },
    },
  };
  const context: FileStrokeContext = {
    fileId: "parity",
    spectrogramData: data,
    strokeRendererRef,
    canvasRef: { current: canvas },
    openFiles: { parity: file },
    getOpenFileByPath: (path) => (path === PARITY_FILE_PATH ? file : undefined),
    createStepStateView,
    getFileOnsets: () => [],
    closeFile: () => {},
    reachByState: new WeakMap(),
  };
  return {
    data,
    context,
    canvas,
    dispose: () => {
      canvas.dispose();
      renderer.dispose();
      disposeHarnessTextures(textures);
      disposeOnsetTexture("parity");
    },
  };
}

/** One dab: where it aims, in file UV, and the state it paints with. */
export type ParityDab = { x: number; y: number; state: State };

/** What a stroke of dabs did: the pixels it changed, their values, and why it could not paint, if it could not. */
export type ParityStroke = { ranges: Uint32Array | null; values: Float32Array | null; refused: string | null };

/** Paints `dabs` as one stroke through the real dispatch and reads back what it changed. */
export async function paintStroke(target: ParityCanvas, dabs: readonly ParityDab[]): Promise<ParityStroke> {
  const { context, canvas } = target;
  canvas.beginStroke();
  try {
    for (const { x, y, state } of dabs) {
      const aim = new Vector2(x, y);
      const refusal = strokeRefusal(context, state, aim);
      if (refusal) return { ranges: null, values: null, refused: refusal };
      const span = dabSpan(context, state, aim, canvas);
      const taken = paintDab(context, canvas, state, aim, span);
      if (!taken) return { ranges: null, values: null, refused: "the canvas cannot serve the dab" };
      const settled = await canvas.settle();
      if (settled.status !== "completed") return { ranges: null, values: null, refused: `settle ${settled.status}` };
    }
    const ranges = canvas.dirtyPixelRanges();
    if (!ranges) return { ranges: null, values: null, refused: null };
    return { ranges, values: await canvas.readPixelRanges(ranges), refused: null };
  } finally {
    canvas.endStroke();
  }
}

/**
 * The largest magnitude and phase differences between two packed runs. Phases
 * are compared round the circle: rounding can put one either side of ±π.
 */
export function worstDifference(want: Float32Array, have: Float32Array): { magnitude: number; phase: number } {
  let magnitude = 0;
  let phase = 0;
  for (let i = 0; i < want.length; i++) {
    const diff = want[i] - have[i];
    if (Number.isNaN(diff)) return { magnitude: Infinity, phase: Infinity };
    if (i % 2 === 0) magnitude = Math.max(magnitude, Math.abs(diff));
    else {
      const turned = diff - 2 * Math.PI * Math.round(diff / (2 * Math.PI));
      phase = Math.max(phase, Math.abs(turned));
    }
  }
  return { magnitude, phase };
}

/**
 * The pixels of `ranges` where two packed runs differ by more than rounding,
 * gathered per band: how many there are, the longest run of neighbours, and
 * the largest differences. A whole-file canvas reaches each frame through
 * one float, a few hundred-millionths of the file out, so values differ by an
 * amount growing with the file's length; and a read that lands exactly on a
 * brush or bin edge can fall either side of it, which puts an isolated pixel
 * out by any amount.
 */
export function outliersByBand(
  data: ParityData,
  ranges: Uint32Array,
  want: Float32Array,
  have: Float32Array,
): Map<number, { bins: number; outliers: number; longestRun: number; magnitude: number; phase: number }> {
  const frames = data.numFrames;
  const magnitudeTolerance = Math.max(1e-3, 3e-8 * frames);
  const phaseTolerance = Math.max(1e-2, 3e-7 * frames);
  const bands = new Map<
    number,
    { bins: number; outliers: number; longestRun: number; magnitude: number; phase: number }
  >();
  const bandOf = (pixel: number): number => {
    let lo = 0;
    let hi = data.numBands - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (data.metadata[mid * 4] <= pixel) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let at = 0;
  let run = 0;
  let last = -2;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    for (let pixel = ranges[i]; pixel < ranges[i] + ranges[i + 1]; pixel++, at++) {
      const band = bandOf(pixel);
      const entry = bands.get(band) ?? { bins: 0, outliers: 0, longestRun: 0, magnitude: 0, phase: 0 };
      entry.bins++;
      const worst = worstDifference(want.subarray(at * 4, at * 4 + 4), have.subarray(at * 4, at * 4 + 4));
      if (worst.magnitude > magnitudeTolerance || worst.phase > phaseTolerance) {
        entry.outliers++;
        run = last === pixel - 1 ? run + 1 : 1;
        last = pixel;
        entry.longestRun = Math.max(entry.longestRun, run);
        entry.magnitude = Math.max(entry.magnitude, worst.magnitude);
        entry.phase = Math.max(entry.phase, worst.phase);
      }
      bands.set(band, entry);
    }
  }
  return bands;
}

/**
 * Checks a windowed canvas painted what the whole-file one did: it painted
 * at all, the same values over the pixels it changed but for a few isolated
 * pixels in each band (`outliersByBand`), and the whole-file one changed
 * nothing else. Returns how many values the stroke changed.
 */
export async function expectSameStroke(
  whole: ParityCanvas,
  expected: ParityStroke,
  got: ParityStroke,
): Promise<number> {
  expect(expected.refused, "the whole-file canvas refused the stroke").toBeNull();
  expect(got.refused, "the windowed canvas refused a stroke the whole-file one painted").toBeNull();
  if (!got.ranges || !expected.ranges) {
    expect(got.ranges).toEqual(expected.ranges);
    return 0;
  }
  const wholeState = await whole.canvas.getFBOData();
  if (!wholeState) throw new Error("the whole-file canvas holds no state");
  const pristine = parityDataLike(whole.data);
  const want = gatherPixelRanges(wholeState, got.ranges);
  const have = got.values ?? new Float32Array(0);
  for (const [band, entry] of outliersByBand(whole.data, got.ranges, want, have)) {
    const allowed = Math.max(4, Math.floor(entry.bins * 0.005));
    const detail = `band ${band}: ${entry.outliers} of ${entry.bins} bins out, ${entry.longestRun} in a row, magnitude ${entry.magnitude.toFixed(4)}, phase ${entry.phase.toFixed(4)}`;
    expect(entry.outliers <= allowed && entry.longestRun <= 2, detail).toBe(true);
  }
  const rest = subtractPixelRanges(expected.ranges, got.ranges);
  expect(
    float32BitsEqual(gatherPixelRanges(wholeState, rest), gatherPixelRanges(pristine, rest)),
    "the whole-file canvas changed pixels the windowed one did not",
  ).toBe(true);
  const before = gatherPixelRanges(pristine, got.ranges);
  let changed = 0;
  for (let i = 0; i < want.length; i++) if (want[i] !== before[i]) changed++;
  return changed;
}

/** The untouched values of a parity file with the same layout as `data`. */
function parityDataLike(data: ParityData): Float32Array {
  const cached = pristineByLength.get(data.packedData.length);
  if (cached) return cached;
  const fresh = parityData({
    durationSeconds: data.numFrames / data.sampleRate,
    sampleRate: data.sampleRate,
    bandsPerOctave: data.bandsPerOctave,
    minFreq: data.minFreq,
  }).packedData;
  pristineByLength.set(data.packedData.length, fresh);
  return fresh;
}

const pristineByLength = new Map<number, Float32Array>();
