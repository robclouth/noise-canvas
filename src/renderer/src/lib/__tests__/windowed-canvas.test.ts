import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  RawShaderMaterial,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { blockGrid, blockOfFrame, blockPixelRanges, type BlockGrid } from "../block-grid";
import { fileRangesToView } from "../canvas-view";
import { float32BitsEqual, gatherPixelRanges, gatherTaps, scatterCompactPixelRanges } from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";
import { CoarseStripBuilder } from "../coarse-strip";
import { displayPyramidLevels } from "../display-pyramid";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";
import type { SourceNeed } from "../source-window";
import { createByteTarget, renderMaterialToBytes } from "../snapshot-capture";
import passThroughVert from "../../glsl/pass-through.vert";

const SAMPLE_RATE = 8000;
// Long enough for the two-second block grid to cut the file into eight blocks.
const DURATION_SECONDS = 16;

function packedTexture(
  data: Float32Array,
  width: number,
  height: number,
  internalFormat: "RGBA32F" | "RG32F",
): DataTexture {
  const texture = new DataTexture(data, width, height, internalFormat === "RGBA32F" ? RGBAFormat : RGFormat, FloatType);
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Resolves once `check` holds, so a test waits on the reads rather than a delay. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 500; tick++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A dab that reads no other file: no source window, no impulse window.
const NO_OTHER_FILES = { sources: [], impulses: [], original: false };

describe("a canvas that holds a window of the file", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let data: SpectrogramData & { packedData: Float32Array };
  let grid: BlockGrid;
  let strokeTextures: StrokeTextures;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
      import("../../effects/transform-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { transform: transformEffect, passthrough: passThroughEffect };
    gl = new WebGLRenderer({ antialias: false });

    const w = window as unknown as Record<string, unknown>;
    const prevNodeOs = w.nodeOs;
    const prevIpcRenderer = w.ipcRenderer;
    const prevNodePath = w.nodePath;
    w.nodeOs = {
      homedir: () => "/home",
      totalmem: () => 16 * 1024 ** 3,
    };
    w.ipcRenderer = {
      invoke: vi.fn(async (channel: string) => (channel === "get-user-data-path" ? "/userdata" : undefined)),
    };
    w.nodePath = { join: (...parts: string[]) => parts.join("/") };
    disposers.push(() => {
      w.nodeOs = prevNodeOs;
      w.ipcRenderer = prevIpcRenderer;
      w.nodePath = prevNodePath;
    });

    data = createConstantQMockSpectrogramData({
      durationSeconds: DURATION_SECONDS,
      sampleRate: SAMPLE_RATE,
      bandsPerOctave: 4,
    });
    const packed = data.packedData;
    for (let i = 0; i < packed.length / 4; i++) {
      packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13));
      packed[i * 4 + 1] = Math.sin(i * 0.7) * 3;
      packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29));
      packed[i * 4 + 3] = Math.cos(i * 0.41) * 3;
    }
    grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE);

    const fold = packedFold(data.texels);
    const originalPackedDataTex = packedTexture(padToFold(packed, data.texels, 4), fold.width, fold.height, "RGBA32F");
    const inverseMapTex = packedTexture(padToFold(data.inverseMap!, data.texels, 2), fold.width, fold.height, "RG32F");
    const metadataTex = packedTexture(metadataTextureRows(data), data.numBands, 1, "RGBA32F");
    const placeholderTexture = packedTexture(new Float32Array(4), 1, 1, "RGBA32F");
    disposers.push(() => {
      originalPackedDataTex.dispose();
      inverseMapTex.dispose();
      metadataTex.dispose();
      placeholderTexture.dispose();
    });
    strokeTextures = {
      originalPackedDataTex,
      inverseMapTex,
      metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    gl.dispose();
  });

  const fileDuration = (): number => data.numFrames / SAMPLE_RATE;

  function strokeParams(cursorPos: Vector2, totalDuration: number): StrokeParams {
    return {
      cursorPos,
      preview: false,
      bpm: 120,
      totalDuration,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 1,
      tiltX: 0,
      tiltY: 0,
    };
  }

  type Harness = {
    canvas: WindowedCanvas;
    /** The renderer behind the canvas. */
    renderer: () => StrokeRenderer;
    /** Paints one dab at a file-UV time, through the canvas's own translation. */
    dab: (fileUvX: number) => boolean;
    /** True once no read is outstanding. */
    quiet: () => boolean;
    /** Lets the reads waiting now, and any that follow, resolve. */
    open: () => void;
    /** Makes the next read wait for `open`. */
    close: () => void;
  };

  /**
   * A canvas of `windowBlocks` blocks over the mock file, its reads served
   * from the file's own packed data. With `gated`, a read waits for `open`.
   */
  function harness(windowBlocks: number, gated = false): Harness {
    let renderer: StrokeRenderer | null = null;
    let outstanding = 0;
    let letThrough = !gated;
    const waiting: Array<() => void> = [];
    const read = async (ranges: Uint32Array): Promise<Float32Array> => {
      outstanding++;
      if (!letThrough) await new Promise<void>((resolve) => waiting.push(resolve));
      const values = gatherPixelRanges(data.packedData, ranges);
      outstanding--;
      return values;
    };

    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: read,
      readRoot: read,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    canvas.initialize(null);

    const state = createMockStateWithSteps([
      {
        name: "Dab",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    const source = (): SourceFileInfo => ({
      id: "window",
      filePath: "/window.wav",
      displayName: "window.wav",
      spectrogramData: data,
      textures: renderer!.getTextures(),
      view: canvas.span(),
    });

    return {
      canvas,
      renderer: () => renderer!,
      dab: (fileUvX) => {
        renderer!.renderStroke(
          strokeParams(canvas.dabCursor(new Vector2(fileUvX, 0.35)), canvas.dabDuration(fileDuration())),
          state,
          source(),
        );
        return true;
      },
      quiet: () => outstanding === 0 && waiting.length === 0,
      open: () => {
        letThrough = true;
        while (waiting.length > 0) waiting.pop()!();
      },
      close: () => {
        letThrough = false;
      },
    };
  }

  /** The frames a dab starting at `fileUvX` covers: a beat at 120 bpm. */
  function dabFrames(fileUvX: number): { start: number; end: number } {
    const start = fileUvX * data.numFrames;
    return { start, end: Math.min(data.numFrames, start + (60 / 120) * SAMPLE_RATE) };
  }

  it("cuts the mock file into more blocks than the window holds", () => {
    expect(grid.blockCount).toBeGreaterThanOrEqual(4);
  });

  it("does not hold frames its window has left behind", async () => {
    const { canvas } = harness(2);
    await until(() => canvas.holdsFrames(0, 1), "the first window");
    const last = dabFrames(0.9);
    expect(canvas.holdsFrames(last.start, last.end)).toBe(false);
  });

  it("holds a dab back while the canvas has no content for its block", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.close();
    rig.canvas.beginStroke();

    const far = dabFrames(0.9);
    rig.canvas.aim(far.start, far.end);
    let painted = false;
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      painted = true;
      return rig.dab(0.9);
    });
    expect(painted).toBe(false);
    expect(rig.canvas.committedFootprintUv()).toBeNull();

    rig.open();
    await until(() => painted, "the held dab");
    expect(rig.canvas.holdsFrames(far.start, far.end)).toBe(true);
  });

  it("runs held paint in the order it was given", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.close();
    rig.canvas.beginStroke();

    const order: number[] = [];
    const far = dabFrames(0.9);
    rig.canvas.aim(far.start, far.end);
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      order.push(1);
      return rig.dab(0.9);
    });
    // The canvas still holds the start of the file, but a dab there must not
    // overtake the one already waiting.
    const near = dabFrames(0.01);
    rig.canvas.paintWhenHeld(near.start, near.end, NO_OTHER_FILES, () => {
      order.push(2);
      return true;
    });
    expect(order).toEqual([]);

    rig.open();
    await rig.canvas.settle();
    expect(order).toEqual([1, 2]);
  });

  it("brings the window back to a waiting dab when the commit settles", async () => {
    const rig = harness(2);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    const far = dabFrames(0.9);
    let paintedAt: number | null = null;
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      paintedAt = 0.9;
      return rig.dab(0.9);
    });
    expect(paintedAt).toBeNull();
    // The brush ran back to the start of the file before the block landed.
    const near = dabFrames(0.01);
    rig.canvas.aim(near.start, near.end);

    await rig.canvas.settle();
    expect(paintedAt).toBe(0.9);
    const box = rig.canvas.committedFootprintUv();
    expect(box).not.toBeNull();
    // The dab landed where it was asked to, not where the brush had moved on to.
    expect(box!.timeMin).toBeGreaterThan(0.85);
  });

  it("lands every held dab of a stroke that swept the file, however many windows it takes", async () => {
    const rig = harness(2);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    // Each dab sits at the opposite end of the file from the one before it, so
    // every one needs a slide of its own: more fills than the stall cap allows.
    const dabs = 12;
    const landed: number[] = [];
    for (let i = 0; i < dabs; i++) {
      const at = i % 2 === 0 ? 0.9 : 0.05;
      const frames = dabFrames(at);
      rig.canvas.paintWhenHeld(frames.start, frames.end, NO_OTHER_FILES, () => {
        landed.push(i);
        return rig.dab(at);
      });
    }
    expect(landed.length).toBeLessThan(dabs);

    await rig.canvas.settle();
    expect(landed).toEqual([...Array(dabs).keys()]);
  });

  it("follows the oldest held dab while the brush runs ahead, not the pointer", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    rig.close();

    const landed: number[] = [];
    const positions = [0.45, 0.6, 0.9];
    for (const [i, at] of positions.entries()) {
      const frames = dabFrames(at);
      rig.canvas.aim(frames.start, frames.end);
      rig.canvas.paintWhenHeld(frames.start, frames.end, NO_OTHER_FILES, () => {
        landed.push(i);
        return rig.dab(at);
      });
    }
    // The pointer keeps moving past the end of the file's last block.
    const pointer = dabFrames(0.95);
    rig.canvas.aim(pointer.start, pointer.end);
    expect(landed).toEqual([]);

    // The reads land: the first one serves the oldest held dab, and the
    // window then works through the rest without a commit.
    rig.open();
    await until(() => landed.length === positions.length, "every held dab to land before the commit");
    expect(landed).toEqual([0, 1, 2]);
  });

  it("shows the paint on a block that comes back after its slot went, and paints over it", async () => {
    // One block to a window: two windows plus the spares hold fewer slots
    // than the file has blocks, so a long stroke evicts the first block's.
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);

    const block0 = blockPixelRanges(grid, 0);
    const block0Ranges = block0.ranges.slice(0, block0.count * 2);
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const original = gatherPixelRanges(data.packedData, block0Ranges);
    const canvasBlock0 = async (): Promise<Float32Array> => {
      const view = rig.renderer().committedSource().view;
      const viewRanges = fileRangesToView(view, layout, block0Ranges);
      if (!viewRanges) throw new Error("block 0 is not on the canvas");
      return await rig.renderer().readPixelRanges(viewRanges);
    };
    const firstPass = await canvasBlock0();
    expect(float32BitsEqual(firstPass, original)).toBe(false);

    // The stroke walks to the far end of the file and back: every block on
    // the way claims a slot, and the first block's goes to one of them.
    const blockAt = (block: number): number => block * grid.blockFrames;
    for (let block = 1; block < grid.blockCount; block++) {
      rig.canvas.aim(blockAt(block), blockAt(block) + 1);
      await until(() => rig.canvas.holdsFrames(blockAt(block), blockAt(block) + 1), `block ${block}`);
    }
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");

    // The canvas shows the paint, not the store's values.
    expect(float32BitsEqual(await canvasBlock0(), firstPass)).toBe(true);

    // A dab over it paints on top of it, and the commit reads that.
    expect(rig.dab(0.02)).toBe(true);
    const secondPass = await canvasBlock0();
    expect(float32BitsEqual(secondPass, firstPass)).toBe(false);
    expect(float32BitsEqual(await rig.canvas.readPixelRanges(block0Ranges), secondPass)).toBe(true);
  });

  it("commits every dab of a stroke that walks the file and back over blocks that lost their slots", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    const layout = { numBands: data.numBands, metadata: data.metadata };

    // The block under a dab, read off the canvas in file pixel order.
    const readBlock = async (block: number): Promise<{ ranges: Uint32Array; values: Float32Array }> => {
      const list = blockPixelRanges(grid, block);
      const ranges = list.ranges.slice(0, list.count * 2);
      const view = rig.renderer().committedSource().view;
      const viewRanges = fileRangesToView(view, layout, ranges);
      if (!viewRanges) throw new Error(`block ${block} is not on the canvas`);
      return { ranges, values: await rig.renderer().readPixelRanges(viewRanges) };
    };

    // What each dab changed, by file pixel: the value the commit must store.
    const expected = new Map<number, Float32Array>();
    const positions = [0.02, 0.15, 0.27, 0.4, 0.52, 0.65, 0.77, 0.9, 0.81, 0.69, 0.56, 0.44, 0.31, 0.19, 0.06];
    for (const at of positions) {
      const frames = dabFrames(at);
      rig.canvas.aim(frames.start, frames.end);
      await until(() => rig.canvas.holdsFrames(frames.start, frames.end), `the block under ${at}`);
      const block = blockOfFrame(grid, frames.start);
      const before = await readBlock(block);
      expect(rig.canvas.paintWhenHeld(frames.start, frames.end, NO_OTHER_FILES, () => rig.dab(at))).toBe(true);
      const after = await readBlock(block);
      let p = 0;
      for (let i = 0; i + 1 < after.ranges.length; i += 2) {
        for (let k = 0; k < after.ranges[i + 1]; k++, p++) {
          const o = p * 4;
          if (float32BitsEqual(before.values.subarray(o, o + 4), after.values.subarray(o, o + 4))) continue;
          expected.set(after.ranges[i] + k, after.values.slice(o, o + 4));
        }
      }
    }
    expect(expected.size).toBeGreaterThan(0);

    // The commit's read: every changed pixel must be in the footprint with
    // the value the dab left.
    await rig.canvas.settle();
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const read = await rig.canvas.readPixelRanges(dirty!);
    const offsetOf = new Map<number, number>();
    let q = 0;
    for (let i = 0; i + 1 < dirty!.length; i += 2) {
      for (let k = 0; k < dirty![i + 1]; k++, q++) offsetOf.set(dirty![i] + k, q * 4);
    }
    let missing = 0;
    let wrong = 0;
    for (const [pixel, value] of expected) {
      const o = offsetOf.get(pixel);
      if (o === undefined) missing++;
      else if (!float32BitsEqual(read.subarray(o, o + 4), value)) wrong++;
    }
    expect({ missing, wrong, painted: expected.size }).toEqual({ missing: 0, wrong: 0, painted: expected.size });
  });

  it("puts the store's values back over a discarded stroke that walked the file", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.renderer().captureRollback();
    rig.canvas.beginStroke();

    const touched: number[] = [];
    for (const at of [0.02, 0.27, 0.52, 0.77, 0.9]) {
      const frames = dabFrames(at);
      rig.canvas.aim(frames.start, frames.end);
      await until(() => rig.canvas.holdsFrames(frames.start, frames.end), `the block under ${at}`);
      expect(rig.canvas.paintWhenHeld(frames.start, frames.end, NO_OTHER_FILES, () => rig.dab(at))).toBe(true);
      touched.push(blockOfFrame(grid, frames.start));
    }
    await rig.canvas.settle();
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const painted = await rig.canvas.readPixelRanges(dirty!);
    expect(float32BitsEqual(painted, gatherPixelRanges(data.packedData, dirty!))).toBe(false);

    expect(await rig.canvas.discardStroke()).toBe(true);
    rig.canvas.endStroke();

    // Every block the stroke touched reads as the store holds it, whether it
    // is on the canvas now or comes back to it.
    for (const block of touched) {
      const start = block * grid.blockFrames;
      rig.canvas.aim(start, start + grid.blockFrames);
      await until(() => rig.canvas.holdsFrames(start, start + 1), `block ${block} back on the canvas`);
      const list = blockPixelRanges(grid, block);
      const ranges = list.ranges.slice(0, list.count * 2);
      const read = await rig.canvas.readPixelRanges(ranges);
      expect(float32BitsEqual(read, gatherPixelRanges(data.packedData, ranges))).toBe(true);
    }
  });

  it("shows what the canvas last held on a block that leaves after the pen lifts", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    rig.canvas.endStroke();

    const block0 = blockPixelRanges(grid, 0);
    const block0Ranges = block0.ranges.slice(0, block0.count * 2);
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const canvasBlock0 = async (): Promise<Float32Array> => {
      const view = rig.renderer().committedSource().view;
      const viewRanges = fileRangesToView(view, layout, block0Ranges);
      if (!viewRanges) throw new Error("block 0 is not on the canvas");
      return await rig.renderer().readPixelRanges(viewRanges);
    };
    const painted = await canvasBlock0();
    expect(float32BitsEqual(painted, gatherPixelRanges(data.packedData, block0Ranges))).toBe(false);

    // The block's slot was filled before the dab. Leaving and coming back
    // must show the dab, not that older copy.
    const away = grid.blockFrames * 2;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    expect(float32BitsEqual(await canvasBlock0(), painted)).toBe(true);
  });

  it("keeps a committing stroke's paint on a block that comes back before the store holds it", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);

    const block0 = blockPixelRanges(grid, 0);
    const block0Ranges = block0.ranges.slice(0, block0.count * 2);
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const original = gatherPixelRanges(data.packedData, block0Ranges);
    const canvasBlock0 = async (): Promise<Float32Array> => {
      const view = rig.renderer().committedSource().view;
      const viewRanges = fileRangesToView(view, layout, block0Ranges);
      if (!viewRanges) throw new Error("block 0 is not on the canvas");
      return await rig.renderer().readPixelRanges(viewRanges);
    };
    const painted = await canvasBlock0();
    expect(float32BitsEqual(painted, original)).toBe(false);

    // The pen lifts: the commit reads the stroke and holds it while it stores.
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const release = rig.canvas.holdPaint(dirty!, rig.canvas.readPixelRanges(dirty!));
    rig.canvas.endStroke();

    // The view leaves, the block's slot goes, and the view comes back while
    // the store still serves the old state.
    const away = grid.blockFrames * 2;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    rig.canvas.forgetBlocks(dirty!);
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    expect(float32BitsEqual(await canvasBlock0(), painted)).toBe(true);

    // Once the commit has stored the stroke, the store speaks for the block.
    release();
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away again");
    rig.canvas.forgetBlocks(dirty!);
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block a third time");
    expect(float32BitsEqual(await canvasBlock0(), original)).toBe(true);
  });

  it("serves a committing stroke's paint to a reader of the committed taps", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const painted = await rig.canvas.readPixelRanges(dirty!);
    expect(float32BitsEqual(painted, gatherPixelRanges(data.packedData, dirty!))).toBe(false);
    const whole = Float32Array.from(data.packedData);
    scatterCompactPixelRanges(whole, painted, dirty!);

    // Every fourth pixel of the first block: taps inside the stroke and around it.
    const block0 = blockPixelRanges(grid, 0);
    const runs: number[] = [];
    for (let i = 0; i < block0.count; i++) {
      const start = block0.ranges[i * 2];
      const count = Math.ceil(block0.ranges[i * 2 + 1] / 4);
      if (count > 0) runs.push(start, count, 4);
    }
    const tapRuns = Uint32Array.from(runs);
    const original = gatherTaps(data.packedData, tapRuns);
    const withPaint = gatherTaps(whole, tapRuns);
    expect(float32BitsEqual(original, withPaint)).toBe(false);

    // Until the pen lifts the store speaks for the file.
    expect(float32BitsEqual((await rig.canvas.readCommittedTaps(tapRuns))!, original)).toBe(true);

    const release = rig.canvas.holdPaint(dirty!, rig.canvas.readPixelRanges(dirty!));
    rig.canvas.endStroke();
    expect(float32BitsEqual((await rig.canvas.readCommittedTaps(tapRuns))!, withPaint)).toBe(true);

    release();
    expect(float32BitsEqual((await rig.canvas.readCommittedTaps(tapRuns))!, original)).toBe(true);
  });

  it("re-encodes the stroke into the display when its paint is held", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const pyramid = rig.renderer().getDisplayPyramid();
    expect(pyramid).not.toBeNull();
    const refresh = vi.spyOn(pyramid!, "refreshFromCanvas");
    const release = rig.canvas.holdPaint(dirty!, rig.canvas.readPixelRanges(dirty!));
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
  });

  it("keeps every dab of a stroke that outran the window, live ones and held ones alike", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    // Two dabs land live on the first window, then the brush runs ahead of the
    // reads: each later dab is held while the aim chases the pointer.
    const positions = [0.02, 0.1, 0.45, 0.6, 0.75, 0.9];
    const landed: number[] = [];
    for (const [i, at] of positions.entries()) {
      if (i === 2) rig.close();
      const frames = dabFrames(at);
      rig.canvas.aim(frames.start, frames.end);
      rig.canvas.paintWhenHeld(frames.start, frames.end, NO_OTHER_FILES, () => {
        landed.push(i);
        return rig.dab(at);
      });
    }
    expect(landed).toEqual([0, 1]);

    rig.open();
    await rig.canvas.settle();
    expect(landed).toEqual([0, 1, 2, 3, 4, 5]);

    // The commit reads the whole footprint: every dab must differ from the
    // original where it painted.
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const painted = await rig.canvas.readPixelRanges(dirty!);
    const original = gatherPixelRanges(data.packedData, dirty!);
    const changedPixels = new Set<number>();
    let at = 0;
    for (let i = 0; i + 1 < dirty!.length; i += 2) {
      for (let p = dirty![i]; p < dirty![i] + dirty![i + 1]; p++, at++) {
        for (let c = 0; c < 4; c++) {
          if (painted[at * 4 + c] !== original[at * 4 + c]) {
            changedPixels.add(p);
            break;
          }
        }
      }
    }
    const missing: number[] = [];
    for (const [i, position] of positions.entries()) {
      const block = blockOfFrame(grid, position * data.numFrames);
      const list = blockPixelRanges(grid, block);
      let changed = 0;
      for (let r = 0; r + 1 < list.count * 2; r += 2) {
        for (let p = list.ranges[r]; p < list.ranges[r] + list.ranges[r + 1]; p++) if (changedPixels.has(p)) changed++;
      }
      if (changed === 0) missing.push(i);
    }
    expect(missing).toEqual([]);
  });

  it("drops paint the canvas can never take rather than stalling the commit", async () => {
    let renderer: StrokeRenderer | null = null;
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: async () => null,
      readRoot: async () => null,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    canvas.initialize(null);
    canvas.beginStroke();

    let painted = false;
    const far = dabFrames(0.9);
    canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      painted = true;
      return true;
    });
    await canvas.settle();
    expect(painted).toBe(false);
  });

  it("paints straight through when the canvas holds the whole file", async () => {
    const rig = harness(grid.blockCount);
    expect(rig.canvas.wholeFile).toBe(true);
    let painted = false;
    const near = dabFrames(0.01);
    expect(
      rig.canvas.paintWhenHeld(near.start, near.end, NO_OTHER_FILES, () => {
        painted = true;
        return true;
      }),
    ).toBe(true);
    expect(painted).toBe(true);
    await rig.canvas.settle();
    expect(rig.quiet()).toBe(true);
  });

  it("reads the original only for a dab that samples it", async () => {
    let renderer: StrokeRenderer | null = null;
    let rootReads = 0;
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: async (ranges) => gatherPixelRanges(data.packedData, ranges),
      readRoot: async (ranges) => {
        rootReads++;
        return gatherPixelRanges(data.packedData, ranges);
      },
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    const setOriginal = vi.spyOn(renderer, "setOriginalTexture");
    canvas.initialize(null);

    await until(() => canvas.holdsFrames(0, 1), "the first window");
    expect(rootReads).toBe(0);
    expect(setOriginal).not.toHaveBeenCalled();
    expect(canvas.holdsFrames(0, 1, true)).toBe(false);

    // A dab that reads the original waits for it, and the fill it asks for
    // brings it in.
    canvas.beginStroke();
    let painted = false;
    canvas.paintWhenHeld(0, 1, { ...NO_OTHER_FILES, original: true }, () => {
      painted = true;
      return true;
    });
    expect(painted).toBe(false);
    await canvas.settle();
    expect(painted).toBe(true);
    expect(rootReads).toBeGreaterThan(0);
    expect(setOriginal).toHaveBeenCalled();
    expect(canvas.holdsFrames(0, 1, true)).toBe(true);
    canvas.endStroke();
  });

  it("draws the display and requests a fill once its store is ready", async () => {
    let storeIsReady = false;
    let renderer: StrokeRenderer | null = null;
    const readCurrent = async (ranges: Uint32Array): Promise<Float32Array | null> => {
      if (!storeIsReady) return null;
      return gatherPixelRanges(data.packedData, ranges);
    };
    const readRoot = async (ranges: Uint32Array): Promise<Float32Array | null> => {
      if (!storeIsReady) return null;
      return gatherPixelRanges(data.packedData, ranges);
    };

    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent,
      readRoot,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());

    let seeded = false;
    const seedSpy = vi.spyOn(renderer, "beginDisplaySeedFromStore").mockImplementation(() => {
      seeded = true;
      renderer?.getDisplayPyramid()?.seedingFromCompact(gl);
    });
    const patchSpy = vi.spyOn(renderer, "patchDisplayFromCompact");
    const fillSpy = vi.spyOn(renderer, "fillCanvas");

    canvas.initialize(null);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(patchSpy).not.toHaveBeenCalled();
    expect(seeded).toBe(false);
    expect(canvas.holdsFrames(view!.startFrame, view!.endFrame)).toBe(false);

    storeIsReady = true;
    await canvas.storeReady();

    expect(seeded).toBe(true);
    expect(seedSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledTimes(grid.blockCount);
    await until(() => fillSpy.mock.calls.length > 0, "a fill request after storeReady");
    expect(fillSpy).toHaveBeenCalled();
    expect(canvas.holdsFrames(view!.startFrame, view!.endFrame)).toBe(true);
  });

  async function delayedSeed() {
    let renderer: StrokeRenderer | null = null;
    let delay = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readBlock = vi.fn(async (index: number): Promise<Float32Array | null> => {
      const list = blockPixelRanges(grid, index);
      const values = gatherPixelRanges(data.packedData, list.ranges.subarray(0, list.count * 2));
      if (delay) await gate;
      return values;
    });
    const readRoot = vi.fn<(ranges: Uint32Array) => Promise<Float32Array | null>>().mockResolvedValue(null);
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      windowBlocks: 2,
      renderer: () => renderer,
      readCurrent: async (ranges) => gatherPixelRanges(data.packedData, ranges),
      readRoot,
      readCurrentBlock: readBlock,
      onChanged: () => {},
      sourceBlocks: () => null,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    const replace = (): StrokeRenderer => {
      const next = new StrokeRenderer(gl, data, strokeTextures, "seed", effects, view);
      next.initialize();
      disposers.push(() => next.dispose());
      renderer = next;
      return next;
    };
    const initial = replace();
    disposers.push(() => canvas.dispose());
    canvas.initialize(data.packedData);
    await until(() => canvas.holdsView(), "the initial canvas fill");
    readBlock.mockClear();
    delay = true;
    return { canvas, initial, replace, release, readBlock, readRoot };
  }

  it.each([true, false])("keeps a pending seed out of a replacement renderer (disposed: %s)", async (dispose) => {
    const rig = await delayedSeed();
    const pending = rig.canvas.storeReady();
    expect(rig.readBlock).toHaveBeenCalledTimes(4);
    if (dispose) rig.canvas.dispose();
    const replacement = rig.replace();
    const begin = vi.spyOn(replacement, "beginDisplaySeedFromStore");
    const patch = vi.spyOn(replacement, "patchDisplayFromCompact");
    const finish = vi.spyOn(replacement, "finishDisplaySeed");
    const source = vi.spyOn(replacement, "committedSource");
    rig.release();
    await pending;
    expect(patch).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(rig.readBlock).toHaveBeenCalledTimes(4);
  });

  it("abandons a seed after reinitialising the same renderer", async () => {
    const rig = await delayedSeed();
    const pending = rig.canvas.storeReady();
    rig.canvas.initialize(data.packedData);
    const patch = vi.spyOn(rig.initial, "patchDisplayFromCompact");
    const aim = vi.spyOn(rig.canvas, "aim");
    rig.release();
    await pending;
    expect(patch).not.toHaveBeenCalled();
    expect(aim).not.toHaveBeenCalled();
  });

  it("abandons a seed while its root fallback is pending", async () => {
    const rig = await delayedSeed();
    let releaseRoot = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    rig.readBlock.mockResolvedValue(null);
    rig.readRoot.mockImplementation(async (ranges) => {
      await gate;
      return gatherPixelRanges(data.packedData, ranges);
    });
    const pending = rig.canvas.storeReady();
    await until(() => rig.readRoot.mock.calls.length === 4, "the seed's root reads");
    rig.canvas.dispose();
    const replacement = rig.replace();
    const patch = vi.spyOn(replacement, "patchDisplayFromCompact");
    releaseRoot();
    await pending;
    expect(patch).not.toHaveBeenCalled();
    expect(rig.readRoot).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])("drains rejected seed read-ahead (rejected before the first read: %s)", async (early) => {
    const rig = await delayedSeed();
    let rejectRead: (error: Error) => void = () => {};
    const abandoned = new Promise<Float32Array | null>((_resolve, reject) => {
      rejectRead = reject;
    });
    rig.readBlock
      .mockImplementationOnce(rig.readBlock.getMockImplementation()!)
      .mockImplementationOnce(() => abandoned);
    let settled = false;
    const pending = rig.canvas.storeReady().then(() => {
      settled = true;
    });
    rig.canvas.dispose();
    if (early) rejectRead(new Error("abandoned read"));
    else rig.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    if (early) rig.release();
    else rejectRead(new Error("abandoned read"));
    await pending;
    expect(settled).toBe(true);
    expect(rig.readRoot).not.toHaveBeenCalled();
  });

  it("checks the seed owner again before storeReady aims the canvas", async () => {
    const rig = await delayedSeed();
    vi.spyOn(rig.initial, "finishDisplaySeed").mockImplementationOnce(() => {
      rig.canvas.dispose();
      rig.replace();
    });
    const pending = rig.canvas.storeReady();
    const aim = vi.spyOn(rig.canvas, "aim");
    rig.release();
    await pending;
    expect(aim).not.toHaveBeenCalled();
  });

  it("keeps a later compact edit when a still-current initial seed resolves", async () => {
    const rig = await delayedSeed();
    const pending = rig.canvas.storeReady();
    const list = blockPixelRanges(grid, 0);
    const ranges = Uint32Array.of(list.ranges[0], 8);
    const values = new Float32Array(8 * 4).fill(0.001);
    expect(rig.canvas.patchFBODataCompact(values, ranges)).toBe(true);
    rig.release();
    await pending;

    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: passThroughVert,
      fragmentShader: `precision highp float;
        uniform sampler2D levelTex;
        out vec4 outColor;
        void main() {
          outColor = vec4((texelFetch(levelTex, ivec2(gl_FragCoord.xy), 0).rg + 100.0) / 100.0, 0.0, 1.0);
        }`,
      uniforms: { levelTex: { value: rig.initial.getDisplayPyramid()!.texture(0) } },
    });
    const target = createByteTarget(32, 1);
    try {
      const actual = await renderMaterialToBytes(gl, material, target);
      rig.initial.seedDisplayFromPacked(data.packedData);
      rig.canvas.patchFBODataCompact(values, ranges);
      const expected = await renderMaterialToBytes(gl, material, target);
      expect(actual).toEqual(expected);
      expect(actual[0]).toBeLessThan(actual[8 * 4]);
      expect(rig.initial.getDisplayPyramid()!.readyLevel).toBe(0);
    } finally {
      material.dispose();
      target.dispose();
    }
  });

  it("shows a strip of the whole file at a coarser level until the store draw finishes", async () => {
    let storeIsReady = false;
    let renderer: StrokeRenderer | null = null;
    const read = async (ranges: Uint32Array): Promise<Float32Array | null> =>
      storeIsReady ? gatherPixelRanges(data.packedData, ranges) : null;
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: read,
      readRoot: read,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const levels = displayPyramidLevels(layout);
    const stripLevel = levels[Math.min(2, levels.length - 1)];
    const builder = new CoarseStripBuilder(layout, stripLevel);
    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      const ranges = list.ranges.slice(0, list.count * 2);
      builder.add(ranges, gatherPixelRanges(data.packedData, ranges));
    }
    const finishSpy = vi.spyOn(renderer, "finishDisplaySeed");

    canvas.initialize(null, builder.strip());
    const pyramid = renderer.getDisplayPyramid()!;
    const stripIndex = pyramid.levels.findIndex((level) => level.stepLog2 === stripLevel.stepLog2);
    expect(stripIndex).toBeGreaterThan(0);
    expect(pyramid.texture(0)).not.toBeNull();
    expect(pyramid.readyLevel).toBe(stripIndex);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finishSpy).not.toHaveBeenCalled();
    expect(pyramid.readyLevel).toBe(stripIndex);

    storeIsReady = true;
    await canvas.storeReady();
    expect(finishSpy).toHaveBeenCalledTimes(1);
    expect(pyramid.readyLevel).toBe(0);
  });

  it("a source with no renderer serves a stroke's source window and re-reads when its revision moves", async () => {
    const sourceFileId = "source-file";
    let sourceRevision = 0;

    const sourceData = createConstantQMockSpectrogramData({
      durationSeconds: DURATION_SECONDS,
      sampleRate: SAMPLE_RATE,
      bandsPerOctave: 4,
    });
    const sourcePacked = sourceData.packedData;
    for (let i = 0; i < sourcePacked.length / 4; i++) {
      sourcePacked[i * 4] = 0.2 + 0.3 * (1 + Math.sin(i * 0.2 + 1));
      sourcePacked[i * 4 + 1] = Math.sin(i * 0.5) * 2;
      sourcePacked[i * 4 + 2] = 0.2 + 0.3 * (1 + Math.cos(i * 0.3 + 1));
      sourcePacked[i * 4 + 3] = Math.cos(i * 0.4) * 2;
    }
    const sourceGrid = blockGrid(
      { numBands: sourceData.numBands, metadata: sourceData.metadata },
      sourceData.numFrames,
      SAMPLE_RATE,
    );

    let renderer: StrokeRenderer | null = null;
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: async (ranges) => gatherPixelRanges(data.packedData, ranges),
      readRoot: async (ranges) => gatherPixelRanges(data.packedData, ranges),
      onChanged: () => {},
      sourceBlocks: (fileId) => {
        if (fileId !== sourceFileId) return null;
        return {
          spectrogram: sourceData,
          readCurrent: async (ranges) => gatherPixelRanges(sourceData.packedData, ranges),
          readRoot: async (ranges) => gatherPixelRanges(sourceData.packedData, ranges),
          revision: () => sourceRevision,
        };
      },
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "dest", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    canvas.initialize(null);

    const need: SourceNeed = {
      fileId: sourceFileId,
      startFrame: 0,
      endFrame: sourceGrid.blockFrames,
      wantOriginal: false,
    };

    expect(canvas.aimSource(need)).toBeNull();

    const state = createMockStateWithSteps([
      {
        name: "Cross",
        overrides: {
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);

    let painted = false;
    canvas.beginStroke();
    const canPaint = canvas.paintWhenHeld(0, 100, { sources: [need], impulses: [], original: false }, () => {
      const windowTextures = canvas.aimSource(need);
      expect(windowTextures).not.toBeNull();
      const sourceInfo: SourceFileInfo = {
        id: sourceFileId,
        filePath: "/source.wav",
        displayName: "source.wav",
        spectrogramData: sourceData,
        textures: windowTextures!,
        view: windowTextures!.view,
      };
      renderer!.renderStroke(
        strokeParams(canvas.dabCursor(new Vector2(0.01, 0.35)), canvas.dabDuration(fileDuration())),
        state,
        sourceInfo,
      );
      painted = true;
      return true;
    });
    expect(canPaint).toBe(true);
    expect(painted).toBe(false);

    await canvas.settle();
    expect(painted).toBe(true);

    const windowTextures = canvas.aimSource(need);
    expect(windowTextures).not.toBeNull();

    sourceRevision++;

    expect(canvas.aimSource(need)).toBeNull();

    let paintedAfterBump = false;
    canvas.paintWhenHeld(0, 100, { sources: [need], impulses: [], original: false }, () => {
      paintedAfterBump = true;
      return true;
    });
    expect(paintedAfterBump).toBe(false);

    await canvas.settle();
    expect(paintedAfterBump).toBe(true);
    expect(canvas.aimSource(need)).not.toBeNull();
  });
});
