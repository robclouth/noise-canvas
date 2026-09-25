import { Vector2 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStepStateView } from "../../store";
import type { State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createGL,
  createHarnessTextures,
  createStateForEffects,
  disposeHarnessTextures,
  toStrokeTextures,
} from "../../test/render-harness";
import { blockGrid } from "../block-grid";
import { dabSpan, dispatchStroke, type FileStrokeContext } from "../file-stroke-dispatch";
import { disposeOnsetTexture } from "../onset-map";
import { float32BitsEqual, gatherPixelRanges, subtractPixelRanges } from "../pixel-ranges";
import { StrokeRenderer } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/** A value in [0, 1) that repeats nowhere along the file. */
function hash(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// 300 seconds at 64 frames a second, every texel its own value, smooth over
// a few texels so reads between them interpolate, and repeating nowhere, so a
// read from the wrong place shows.
function fileData() {
  const data = createMockSpectrogramData({ numFrames: 300 * 64, sampleRate: 64, numBands: 4, pattern: "constant" });
  const packed = data.packedData;
  const texels = packed.length / 4;
  const smooth = (i: number, seed: number) => {
    const at = i / 4;
    const k = Math.floor(at);
    const t = at - k;
    return hash(k + seed) * (1 - t) + hash(k + 1 + seed) * t;
  };
  for (let i = 0; i < texels; i++) {
    packed[i * 4] = 0.05 + 0.9 * smooth(i, 0);
    packed[i * 4 + 1] = (smooth(i, 1e6) - 0.5) * 6;
    packed[i * 4 + 2] = 0.05 + 0.9 * smooth(i, 2e6);
    packed[i * 4 + 3] = (smooth(i, 3e6) - 0.5) * 6;
  }
  return data;
}

type Data = ReturnType<typeof fileData>;

/** A file's painting canvas over `data`, holding `windowBlocks` blocks of it. */
async function canvasOver(data: Data, windowBlocks: number) {
  const { passThroughEffect } = await import("../../effects/passthrough-effect");
  const gl = createGL();
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
    sourceBlocks: () => null,
    windowBlocks,
  });
  const view = canvas.firstView(0, 1);
  const renderer = new StrokeRenderer(
    gl,
    data,
    toStrokeTextures(textures),
    "self",
    { passthrough: passThroughEffect },
    view,
  );
  strokeRendererRef.current = renderer;
  canvas.initialize(null);
  const context: FileStrokeContext = {
    fileId: "self",
    spectrogramData: data,
    strokeRendererRef,
    canvasRef: { current: canvas },
    openFiles: {
      self: {
        id: "self",
        filePath: "/self.wav",
        displayName: "self.wav",
        spectrogramData: data,
        rendererRef: {
          current: { getTextures: () => renderer.getTextures(), getCanvasView: () => canvas.span() ?? null },
        },
      },
    },
    getOpenFileByPath: () => undefined,
    createStepStateView,
    getFileOnsets: vi.fn(() => []),
    closeFile: vi.fn(),
    reachByState: new WeakMap(),
  };
  disposers.push(() => {
    canvas.dispose();
    renderer.dispose();
    disposeHarnessTextures(textures);
    disposeOnsetTexture("self");
    gl.dispose();
  });
  return { context, canvas };
}

/** A passthrough brush `beats` long that reads this file `shift` of its length from the dab, locked at the stroke's start. */
function shiftedBy(shift: number, accumulate = false, beats = 1): State {
  const state = readingAt(0, accumulate, beats);
  const step = state.brushes[state.activeBrushIndex].steps[0] as Record<string, unknown>;
  step.sourcePositionMode = "anchored";
  step.sourceTimeOffset = 0;
  step.lockedOffset = { beats: shift, pitch: 0 };
  state.isStroking = true;
  return state;
}

/** A passthrough brush `beats` long that reads this file at `at` of its length. */
function readingAt(at: number, accumulate = false, beats = 1): State {
  return createStateForEffects(["passthrough"], {
    brushSizeTime: beats,
    brushSizePitch: 12,
    stepOverrides: { sourcePositionMode: "fixed", sourceTimeOffset: at * 100, accumulate },
    overrides: {
      activeFileId: "self",
      filepathsBpm: { "/self.wav": 120 },
      filepathsOnsetSensitivity: {},
      filesSelection: {},
      filesZoomY: {},
      filesOffsetY: {},
      filesZoom: {},
      filesOffset: {},
    },
  });
}

/** Paints one stroke of `dabs` and returns the pixels it changed with their values. */
async function paint(
  target: Awaited<ReturnType<typeof canvasOver>>,
  dabs: { x: number; state: State }[],
): Promise<{ ranges: Uint32Array; values: Float32Array; far: boolean[] }> {
  const { context, canvas } = target;
  canvas.beginStroke();
  const far: boolean[] = [];
  for (const { x, state } of dabs) {
    const aim = new Vector2(x, 0.5);
    const span = dabSpan(context, state, aim, canvas);
    far.push(span.needs.sources.some((read) => read.self));
    expect(
      canvas.paintWhenHeld(span.extent, span.needs, (clip) =>
        dispatchStroke(context, state, aim, false, undefined, span, clip),
      ),
    ).toBe(true);
    expect((await canvas.settle()).status).toBe("completed");
  }
  const ranges = canvas.dirtyPixelRanges()!;
  const values = await canvas.readPixelRanges(ranges);
  canvas.endStroke();
  return { ranges, values, far };
}

/**
 * Compares the windowed stroke with the whole-file one over the pixels the
 * windowed one painted, and checks the whole-file one changed nothing else.
 */
async function expectSameStroke(
  data: Data,
  whole: Awaited<ReturnType<typeof canvasOver>>,
  windowed: Awaited<ReturnType<typeof canvasOver>>,
  expected: { ranges: Uint32Array },
  got: { ranges: Uint32Array },
): Promise<number> {
  const wholeState = await whole.canvas.getFBOData();
  if (!wholeState) throw new Error("the whole-file canvas holds no state");
  const want = gatherPixelRanges(wholeState, got.ranges);
  const have = await windowed.canvas.readPixelRanges(got.ranges);
  expectParity(want, have);
  const rest = subtractPixelRanges(expected.ranges, got.ranges);
  expect(float32BitsEqual(gatherPixelRanges(wholeState, rest), gatherPixelRanges(data.packedData, rest))).toBe(true);
  const before = gatherPixelRanges(data.packedData, got.ranges);
  let changed = 0;
  for (let i = 0; i < want.length; i++) if (want[i] !== before[i]) changed++;
  return changed;
}

/**
 * Values match to the rounding of a read at another texture's UV: the
 * whole-file canvas addresses 19,200 frames through one float, a thousandth
 * of a frame out, which this data's slopes turn into a few ten-thousandths of
 * magnitude and a few thousandths of phase.
 */
function expectParity(want: Float32Array, have: Float32Array): void {
  let magnitude = 0;
  let phase = 0;
  for (let i = 0; i < want.length; i++) {
    const diff = Math.abs(want[i] - have[i]);
    if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
    else phase = Math.max(phase, diff);
  }
  expect(magnitude, `largest magnitude difference ${magnitude}`).toBeLessThan(1e-3);
  expect(phase, `largest phase difference ${phase}`).toBeLessThan(1e-2);
}

describe("a brush reading its own file away from the dab", () => {
  it("cuts the file into far more blocks than a small window holds", () => {
    const data = fileData();
    const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate);
    expect(grid.blockCount).toBeGreaterThan(20);
  });

  it.each([
    ["far away, through a window of its own", shiftedBy(0.7), true],
    ["near by, off the canvas", shiftedBy(0.005), false],
    ["at a fixed place far away", readingAt(0.8), true],
  ])("reads what a whole-file canvas reads %s", async (_, state, far) => {
    const data = fileData();
    const whole = await canvasOver(fileData(), Infinity);
    const windowed = await canvasOver(fileData(), 3);
    expect(whole.canvas.holdsWholeFile).toBe(true);
    expect(windowed.canvas.holdsWholeFile).toBe(false);

    const dabs = [{ x: 0.1, state }];
    const expected = await paint(whole, dabs);
    const got = await paint(windowed, dabs);
    expect(got.far).toEqual([far]);
    expect(await expectSameStroke(data, whole, windowed, expected, got)).toBeGreaterThan(0);
  });

  it("reads an earlier stroke's paint far away while its commit has still to store it", async () => {
    const data = fileData();
    const whole = await canvasOver(fileData(), Infinity);
    const windowed = await canvasOver(fileData(), 3);
    // Eight beats from just before 80%, so the second stroke's read lies inside it.
    const first = [{ x: 0.79, state: shiftedBy(-0.29, false, 8) }];
    await paint(whole, first);
    const painted = await paint(windowed, first);
    // The windowed store never takes the first stroke: its paint stays held.
    windowed.canvas.holdPaint(painted.ranges, Promise.resolve(painted.values));
    const second = [{ x: 0.1, state: shiftedBy(0.7) }];
    const expected = await paint(whole, second);
    const got = await paint(windowed, second);
    expect(got.far).toEqual([true]);
    expect(await expectSameStroke(data, whole, windowed, expected, got)).toBeGreaterThan(0);
  });

  it("builds up on its own paint far away, as a whole-file canvas does", async () => {
    const data = fileData();
    const whole = await canvasOver(fileData(), Infinity);
    // An Accumulate dab is painted whole, so the window holds all of it.
    const windowed = await canvasOver(fileData(), 5);
    // The first dab paints eight beats from just before 80% with what it reads
    // at 50%; the second, at 10%, reads the 80% the first one just painted.
    const dabs = [
      { x: 0.79, state: shiftedBy(-0.29, true, 8) },
      { x: 0.1, state: shiftedBy(0.7, true) },
    ];
    const expected = await paint(whole, dabs);
    const got = await paint(windowed, dabs);
    expect(got.far).toEqual([true, true]);

    expect(await expectSameStroke(data, whole, windowed, expected, got)).toBeGreaterThan(0);
  });
});
