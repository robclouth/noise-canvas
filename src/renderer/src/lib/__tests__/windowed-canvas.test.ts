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
import {
  composePixelRangeValues,
  float32BitsEqual,
  gatherPixelRanges,
  gatherTaps,
  intersectPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
  scatterCompactPixelRanges,
  subtractPixelRanges,
} from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";
import { CoarseStripBuilder } from "../coarse-strip";
import { displayPyramidLevels } from "../display-pyramid";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";
import type { SourceNeed } from "../source-window";
import type { DabExtent, FrameSpan } from "../held-dabs";
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

/** A dab that writes [start, end) and reads nothing beyond it. */
function dabExtent(start: number, end: number): DabExtent {
  return { writes: [{ start, end }], before: 0, after: 0, readsLive: false };
}

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
    /**
     * Paints one dab at a file-UV time, through the canvas's own translation,
     * at `strength` percent, writing only the file frames of `clip` when given.
     */
    dab: (fileUvX: number, strength?: number, clip?: FrameSpan | null) => boolean;
    /** Paints one dab `beats` long with a shaped time envelope, as `dab` does. */
    wideDab: (fileUvX: number, beats: number, clip?: FrameSpan | null) => boolean;
    /** True once no read is outstanding. */
    quiet: () => boolean;
    /** Lets the reads waiting now, and any that follow, resolve. */
    open: () => void;
    /** Makes the next read wait for `open`. */
    close: () => void;
    fail: (value: boolean) => void;
  };

  /**
   * A canvas of `windowBlocks` blocks over the mock file, its reads served
   * from the file's own packed data. With `gated`, a read waits for `open`.
   */
  function harness(windowBlocks: number, gated = false): Harness {
    let renderer: StrokeRenderer | null = null;
    let outstanding = 0;
    let failReads = false;
    let letThrough = !gated;
    const waiting: Array<() => void> = [];
    const read = async (ranges: Uint32Array): Promise<Float32Array | null> => {
      outstanding++;
      if (!letThrough) await new Promise<void>((resolve) => waiting.push(resolve));
      const values = gatherPixelRanges(data.packedData, ranges);
      outstanding--;
      return failReads ? null : values;
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

    const stateAt = (strength?: number) =>
      createMockStateWithSteps([
        {
          name: "Dab",
          overrides: {
            ...(strength === undefined ? {} : { brushIntensity: strength }),
            transformShiftSemis: 3,
            effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
          },
        },
      ]);
    const state = stateAt();
    const source = (): SourceFileInfo => ({
      id: "window",
      filePath: "/window.wav",
      displayName: "window.wav",
      spectrogramData: data,
      textures: renderer!.getTextures(),
      view: canvas.span(),
    });

    return {
      fail: (value) => {
        failReads = value;
      },
      canvas,
      renderer: () => renderer!,
      dab: (fileUvX, strength, clip) => {
        renderer!.renderStroke(
          {
            ...strokeParams(canvas.dabCursor(new Vector2(fileUvX, 0.35)), canvas.dabDuration(fileDuration())),
            clip: canvas.clipToCanvas(clip ?? null),
          },
          strength === undefined ? state : stateAt(strength),
          source(),
        );
        return true;
      },
      wideDab: (fileUvX, beats, clip) => {
        const wide = createMockStateWithSteps([
          {
            name: "Wide",
            overrides: {
              brushSizeTime: beats,
              brushCurveTime: 0,
              transformShiftSemis: 3,
              effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
            },
          },
        ]);
        renderer!.renderStroke(
          {
            ...strokeParams(canvas.dabCursor(new Vector2(fileUvX, 0.35)), canvas.dabDuration(fileDuration())),
            clip: canvas.clipToCanvas(clip ?? null),
          },
          wide,
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

  it("distinguishes populated blocks from covered and pending screen ranges", async () => {
    const rig = harness(2);
    await until(() => rig.canvas.isPopulated(), "the initial canvas fill");
    const start = grid.blockFrames * 4;
    const end = grid.blockFrames * 5;
    expect(rig.canvas.holdsFrames(start, end)).toBe(false);
    expect(rig.canvas.isFillingFrames(start, end)).toBe(false);
    rig.close();
    rig.canvas.aim(start, end);
    expect(rig.canvas.isPopulated()).toBe(true);
    expect(rig.canvas.holdsFrames(start, end)).toBe(false);
    expect(rig.canvas.isFillingFrames(start, end)).toBe(true);
    expect(rig.canvas.isFillingFrames(0, data.numFrames)).toBe(false);
    rig.open();
    await until(() => rig.canvas.holdsFrames(start, end), "the disjoint screen fill");
    expect(rig.canvas.isFillingFrames(start, end)).toBe(false);
  });

  it("paints a dab wider than its window a run of blocks at a time", async () => {
    const { canvas } = harness(3);
    await until(() => canvas.holdsFrames(0, 1), "the first window");
    canvas.beginStroke();
    const start = grid.blockFrames - 1;
    const end = grid.blockFrames * 5 + 1;
    expect(canvas.fitsWindow(start, end)).toBe(false);
    const clips: (FrameSpan | null)[] = [];
    expect(
      canvas.paintWhenHeld(dabExtent(start, end), NO_OTHER_FILES, (clip) => {
        clips.push(clip);
        return true;
      }),
    ).toBe(true);
    expect((await canvas.settle()).status).toBe("completed");
    // Every block the dab writes is painted once, in runs no wider than a window.
    const painted: number[] = [];
    for (const clip of clips) {
      expect(clip).not.toBeNull();
      for (let block = blockOfFrame(grid, clip!.start); block <= blockOfFrame(grid, clip!.end - 1); block++) {
        painted.push(block);
      }
      expect(canvas.fitsWindow(clip!.start, clip!.end)).toBe(true);
    }
    expect(painted.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    canvas.endStroke();
  });

  it("paints a dab wider than its window as a canvas over the whole file does", async () => {
    // Twelve beats is six seconds: three blocks, painted through a window of
    // three whose later pieces start past the dab's own origin.
    const beats = 12;
    const at = 0.1;
    const start = at * data.numFrames;
    const end = start + (beats * 60 * SAMPLE_RATE) / 120;
    const paint = async (windowBlocks: number): Promise<Float32Array> => {
      const rig = harness(windowBlocks);
      await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
      rig.canvas.beginStroke();
      expect(
        rig.canvas.paintWhenHeld(dabExtent(start, end), NO_OTHER_FILES, (clip) => rig.wideDab(at, beats, clip)),
      ).toBe(true);
      expect((await rig.canvas.settle()).status).toBe("completed");
      const dirty = rig.canvas.dirtyPixelRanges()!;
      const whole = Float32Array.from(data.packedData);
      scatterCompactPixelRanges(whole, await rig.canvas.readPixelRanges(dirty), dirty);
      rig.canvas.endStroke();
      return whole;
    };
    const expected = await paint(grid.blockCount);
    const windowed = await paint(3);
    let changed = 0;
    let magnitude = 0;
    let phase = 0;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== data.packedData[i]) changed++;
      const diff = Math.abs(expected[i] - windowed[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
      else phase = Math.max(phase, diff);
    }
    expect(changed).toBeGreaterThan(0);
    // Phase runs to several radians and the two canvases address it from
    // different bases, so it keeps a looser bound than magnitude.
    expect(magnitude, `largest magnitude difference ${magnitude}`).toBeLessThan(1e-4);
    expect(phase, `largest phase difference ${phase}`).toBeLessThan(1e-3);
  });

  it("refuses a dab whose reach one window cannot hold around a single block", async () => {
    const { canvas } = harness(2);
    await until(() => canvas.holdsFrames(0, 1), "the first window");
    const paint = vi.fn(() => true);
    const reaching = { ...dabExtent(0, 1), before: grid.blockFrames * 2, after: grid.blockFrames * 2 };
    expect(canvas.paintWhenHeld(reaching, NO_OTHER_FILES, paint)).toBe(false);
    expect(paint).not.toHaveBeenCalled();
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
    rig.canvas.paintWhenHeld(dabExtent(far.start, far.end), NO_OTHER_FILES, () => {
      painted = true;
      return rig.dab(0.9);
    });
    expect(painted).toBe(false);
    expect(rig.canvas.committedFootprintUv()).toBeNull();

    rig.open();
    await until(() => painted, "the held dab");
    expect(rig.canvas.holdsFrames(far.start, far.end)).toBe(true);
  });

  it("runs held paint on a block in the order it was given, and lets paint on another block go ahead", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.close();
    rig.canvas.beginStroke();

    const order: number[] = [];
    const far = dabFrames(0.9);
    rig.canvas.aim(far.start, far.end);
    rig.canvas.paintWhenHeld(dabExtent(far.start, far.end), NO_OTHER_FILES, () => {
      order.push(1);
      return rig.dab(0.9);
    });
    // A dab on a block the canvas holds does not wait for one on another block.
    const near = dabFrames(0.01);
    rig.canvas.paintWhenHeld(dabExtent(near.start, near.end), NO_OTHER_FILES, () => {
      order.push(2);
      return true;
    });
    expect(order).toEqual([2]);
    // A later dab over the waiting one's block waits behind it.
    rig.canvas.paintWhenHeld(dabExtent(far.start, far.end), NO_OTHER_FILES, () => {
      order.push(3);
      return true;
    });
    expect(order).toEqual([2]);

    rig.open();
    await rig.canvas.settle();
    expect(order).toEqual([2, 1, 3]);
  });

  it("brings the window back to a waiting dab when the commit settles", async () => {
    const rig = harness(2);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    const far = dabFrames(0.9);
    let paintedAt: number | null = null;
    rig.canvas.paintWhenHeld(dabExtent(far.start, far.end), NO_OTHER_FILES, () => {
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
      rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, () => {
        landed.push(i);
        return rig.dab(at);
      });
    }
    expect(landed.length).toBeLessThan(dabs);

    await rig.canvas.settle();
    // Every dab lands once, and the dabs on each block land in the order they came.
    expect([...landed].sort((a, b) => a - b)).toEqual([...Array(dabs).keys()]);
    expect(landed.filter((i) => i % 2 === 0)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(landed.filter((i) => i % 2 === 1)).toEqual([1, 3, 5, 7, 9, 11]);
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
      rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, (clip) => {
        if (!landed.includes(i)) landed.push(i);
        return rig.dab(at, undefined, clip);
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

    // The stroke goes on from where it left the block: the same dab again
    // changes nothing, as it would on a canvas holding the whole file, and the
    // commit reads the canvas.
    expect(rig.dab(0.02)).toBe(true);
    const secondPass = await canvasBlock0();
    expect(float32BitsEqual(secondPass, firstPass)).toBe(true);
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
      expect(
        rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, (clip) =>
          rig.dab(at, undefined, clip),
        ),
      ).toBe(true);
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

  it("paints a block the stroke comes back to as a canvas over the whole file does", async () => {
    // A strong dab, a trip to the far end, and a weaker dab over the first:
    // the window has to let the block go and bring it back mid-stroke, and
    // the stronger dab must still win where it painted.
    const positions = [
      { at: 0.02, strength: 100 },
      { at: 0.9, strength: 100 },
      { at: 0.025, strength: 30 },
    ];
    const block0 = blockPixelRanges(grid, 0);
    const block0Ranges = block0.ranges.slice(0, block0.count * 2);
    const strokeOver = async (windowBlocks: number): Promise<Float32Array> => {
      const rig = harness(windowBlocks);
      await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
      rig.canvas.beginStroke();
      for (const { at, strength } of positions) {
        const frames = dabFrames(at);
        expect(
          rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, (clip) =>
            rig.dab(at, strength, clip),
          ),
        ).toBe(true);
        await rig.canvas.settle();
      }
      return await rig.canvas.readPixelRanges(block0Ranges);
    };
    const whole = await strokeOver(grid.blockCount);
    const windowed = await strokeOver(1);
    expect(float32BitsEqual(whole, gatherPixelRanges(data.packedData, block0Ranges))).toBe(false);
    let worst = 0;
    for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(whole[i] - windowed[i]));
    expect(worst).toBeLessThan(1e-4);
  });

  it("reports unavailable held paint and restores every painted pixel before retry", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const dirty = rig.canvas.dirtyPixelRanges()!;
    expect(float32BitsEqual(await rig.canvas.readPixelRanges(dirty), gatherPixelRanges(data.packedData, dirty))).toBe(
      false,
    );
    rig.fail(true);
    const held = vi.fn(() => true);
    const frames = dabFrames(0.9);
    rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, held);
    expect(await rig.canvas.settle()).toEqual({ status: "failed", reason: "unavailable" });
    rig.fail(false);
    expect(await rig.canvas.discardStroke()).toBe(true);
    expect(float32BitsEqual(await rig.canvas.readPixelRanges(dirty), gatherPixelRanges(data.packedData, dirty))).toBe(
      true,
    );
    expect(held).not.toHaveBeenCalled();
    rig.canvas.endStroke();
  });

  it("keeps the paint of a block leaving mid-stroke on the graphics device", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const renderer = rig.renderer();
    const values = vi.spyOn(renderer, "readPixelRanges");
    const away = grid.blockFrames * 4;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    expect(values).not.toHaveBeenCalled();
    expect(rig.canvas.dirtyPixelRanges()).not.toBeNull();
    rig.canvas.endStroke();
  });

  it("abandons held paint when a whole-state replacement arrives during a read", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    rig.canvas.beginStroke();
    rig.close();
    const held = vi.fn(() => true);
    const frames = dabFrames(0.9);
    rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, held);
    const settling = rig.canvas.settle();
    rig.canvas.setFBOData(data.packedData);
    rig.open();
    expect(await settling).toEqual({ status: "cancelled" });
    await until(rig.quiet, "the obsolete read");
    expect(held).not.toHaveBeenCalled();
    expect(rig.canvas.isStroking).toBe(false);
  });

  it("settles cancellation on disposal before a held read finishes", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    rig.canvas.beginStroke();
    rig.close();
    const held = vi.fn(() => true);
    const frames = dabFrames(0.9);
    rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, held);
    const settling = rig.canvas.settle();
    rig.canvas.dispose();
    expect(await settling).toEqual({ status: "cancelled" });
    rig.open();
    await until(rig.quiet, "the disposed read");
    expect(held).not.toHaveBeenCalled();
  });

  it("cancels a blocked read without letting its held dab land later", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    rig.canvas.beginStroke();
    rig.close();
    const held = vi.fn(() => true);
    const frames = dabFrames(0.9);
    rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, held);
    const abort = new AbortController();
    const settling = rig.canvas.settle(abort.signal);
    abort.abort();
    expect(await settling).toEqual({ status: "cancelled" });
    expect(await rig.canvas.discardStroke()).toBe(true);
    rig.open();
    await until(rig.quiet, "the cancelled read");
    expect(held).not.toHaveBeenCalled();
    rig.canvas.endStroke();
  });

  it("puts the store's values back over a discarded stroke that walked the file", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    const touched: number[] = [];
    for (const at of [0.02, 0.27, 0.52, 0.77, 0.9]) {
      const frames = dabFrames(at);
      rig.canvas.aim(frames.start, frames.end);
      await until(() => rig.canvas.holdsFrames(frames.start, frames.end), `the block under ${at}`);
      expect(
        rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, (clip) =>
          rig.dab(at, undefined, clip),
        ),
      ).toBe(true);
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

  it("shows a stored stroke on a block whose slot was filled before it", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const dirty = rig.canvas.dirtyPixelRanges();
    expect(dirty).not.toBeNull();
    const penUp = rig.canvas.readPixelRanges(dirty!);
    const release = rig.canvas.holdPaint(dirty!, penUp);
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

    // The block's slot was filled before the dab. Once the commit has stored
    // the stroke, the slot holds it too, so leaving and coming back shows the
    // dab rather than that older copy.
    await penUp;
    await release(true);
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

    // Once the commit lets the paint go, the store speaks for the block.
    await release(false);
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away again");
    rig.canvas.forgetBlocks(dirty!);
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block a third time");
    expect(float32BitsEqual(await canvasBlock0(), original)).toBe(true);
  });

  it("lands a commit under a later stroke everywhere that stroke has not painted", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const canvasAt = async (fileRanges: Uint32Array): Promise<Float32Array> => {
      const viewRanges = fileRangesToView(rig.renderer().committedSource().view, layout, fileRanges);
      if (!viewRanges) throw new Error("the pixels are not on the canvas");
      return await rig.renderer().readPixelRanges(viewRanges);
    };

    rig.canvas.beginStroke();
    expect(rig.dab(0.05)).toBe(true);
    const later = rig.canvas.dirtyPixelRanges()!;
    const paintedLater = await canvasAt(later);

    // The earlier commit reached past its own stroke: over the later stroke's
    // footprint and over pixels of the block nobody has painted.
    const block0 = blockPixelRanges(grid, 0);
    const blockRanges = block0.ranges.slice(0, block0.count * 2);
    const untouched = subtractPixelRanges(blockRanges, later);
    const landed = mergePixelRanges(intersectPixelRanges(later, blockRanges), untouched);
    const values = gatherPixelRanges(data.packedData, landed).map((v) => v + 1);
    scatterCompactPixelRanges(data.packedData, values, landed);
    rig.canvas.landUnderStroke(landed, values);

    const cut = (ranges: Uint32Array): Float32Array => composePixelRangeValues(ranges, [{ ranges: landed, values }]);
    expect(float32BitsEqual(await canvasAt(untouched), cut(untouched))).toBe(true);
    expect(float32BitsEqual(await canvasAt(later), paintedLater)).toBe(true);

    // The later stroke ends and its commit lets its paint go, and the block
    // comes back as the store holds it.
    const penUp = rig.canvas.readPixelRanges(later);
    const release = rig.canvas.holdPaint(later, penUp);
    rig.canvas.endStroke();
    await penUp;
    await release(false);
    const away = grid.blockFrames * 3;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    expect(float32BitsEqual(await canvasAt(untouched), cut(untouched))).toBe(true);
  });

  it("keeps the values a commit stored of its own when the slots take its paint", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const canvasAt = async (fileRanges: Uint32Array): Promise<Float32Array> => {
      const viewRanges = fileRangesToView(rig.renderer().committedSource().view, layout, fileRanges);
      if (!viewRanges) throw new Error("the pixels are not on the canvas");
      return await rig.renderer().readPixelRanges(viewRanges);
    };

    // Stroke A lifts; stroke B starts before A's commit lands.
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const first = rig.canvas.dirtyPixelRanges()!;
    const firstRead = rig.canvas.readPixelRanges(first);
    const release = rig.canvas.holdPaint(first, firstRead);
    rig.canvas.endStroke();
    const painted = await firstRead;
    rig.canvas.beginStroke();
    expect(rig.dab(0.09)).toBe(true);
    const second = rig.canvas.dirtyPixelRanges()!;

    // A's commit stores values of its own over part of A's footprint that B
    // has not reached, and lets its paint go.
    const own = subtractPixelRanges(first, second).slice(0, 2);
    expect(pixelRangeCount(own)).toBeGreaterThan(0);
    const values = gatherPixelRanges(data.packedData, own).map((v) => v + 2);
    scatterCompactPixelRanges(data.packedData, painted, first);
    scatterCompactPixelRanges(data.packedData, values, own);
    rig.canvas.landUnderStroke(own, values);
    await release(true, own);

    // B lifts without being stored, and the block comes back from its slot.
    const secondRead = rig.canvas.readPixelRanges(second);
    const releaseSecond = rig.canvas.holdPaint(second, secondRead);
    rig.canvas.endStroke();
    await secondRead;
    await releaseSecond(false);
    const away = grid.blockFrames * 3;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    expect(float32BitsEqual(await canvasAt(own), values)).toBe(true);
    const rest = subtractPixelRanges(subtractPixelRanges(first, own), second);
    expect(
      float32BitsEqual(await canvasAt(rest), composePixelRangeValues(rest, [{ ranges: first, values: painted }])),
    ).toBe(true);
  });

  it("writes the slots in the order the store took the values", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    const layout = { numBands: data.numBands, metadata: data.metadata };
    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const first = rig.canvas.dirtyPixelRanges()!;
    const firstRead = rig.canvas.readPixelRanges(first);
    const release = rig.canvas.holdPaint(first, firstRead);
    rig.canvas.endStroke();
    await firstRead;
    rig.canvas.beginStroke();

    // The stroke is stored, and a later commit stores newer values over part
    // of it before the slots have taken the stroke.
    const newer = first.slice(0, 2);
    const values = gatherPixelRanges(data.packedData, newer).map((v) => v + 5);
    scatterCompactPixelRanges(data.packedData, await firstRead, first);
    scatterCompactPixelRanges(data.packedData, values, newer);
    const released = release(true);
    rig.canvas.landUnderStroke(newer, values);
    await released;
    rig.canvas.endStroke();

    const away = grid.blockFrames * 3;
    rig.canvas.aim(away, away + 1);
    await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
    await until(() => rig.quiet(), "the slot writes");
    rig.canvas.aim(0, 1);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    const viewRanges = fileRangesToView(rig.renderer().committedSource().view, layout, newer)!;
    expect(float32BitsEqual(await rig.renderer().readPixelRanges(viewRanges), values)).toBe(true);
  });

  it("takes a stroke into the block slots at its pen-up, and gives them back when it is not stored", async () => {
    const rig = harness(1);
    await until(() => rig.canvas.holdsFrames(0, 1) && rig.quiet(), "the first window");
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const block0 = blockPixelRanges(grid, 0);
    const block0Ranges = block0.ranges.slice(0, block0.count * 2);
    const canvasBlock0 = async (): Promise<Float32Array> =>
      await rig
        .renderer()
        .readPixelRanges(fileRangesToView(rig.renderer().committedSource().view, layout, block0Ranges)!);
    const trip = async (): Promise<void> => {
      const away = grid.blockFrames * 3;
      rig.canvas.aim(away, away + 1);
      await until(() => rig.canvas.holdsFrames(away, away + 1), "a block away");
      rig.canvas.aim(0, 1);
      await until(() => rig.canvas.holdsFrames(0, 1), "the first block again");
    };

    rig.canvas.beginStroke();
    expect(rig.dab(0.02)).toBe(true);
    const dirty = rig.canvas.dirtyPixelRanges()!;
    const penUp = rig.canvas.readPixelRanges(dirty);
    const release = rig.canvas.holdPaint(dirty, penUp);
    rig.canvas.endStroke();
    const painted = await canvasBlock0();
    await penUp;

    // While the commit stores it, the block comes back from its slot with the
    // paint already on it: nothing is laid over it.
    const patch = vi.spyOn(rig.renderer(), "patchFBODataCompact");
    await trip();
    expect(patch).not.toHaveBeenCalled();
    expect(float32BitsEqual(await canvasBlock0(), painted)).toBe(true);

    // The commit never stores it, so the slot reads the store again.
    await release(false);
    await trip();
    expect(float32BitsEqual(await canvasBlock0(), gatherPixelRanges(data.packedData, block0Ranges))).toBe(true);
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

    await release(false);
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
    await release(false);
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
      rig.canvas.paintWhenHeld(dabExtent(frames.start, frames.end), NO_OTHER_FILES, (clip) => {
        if (!landed.includes(i)) landed.push(i);
        return rig.dab(at, undefined, clip);
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
    canvas.paintWhenHeld(dabExtent(far.start, far.end), NO_OTHER_FILES, () => {
      painted = true;
      return true;
    });
    await canvas.settle();
    expect(painted).toBe(false);
  });

  it("paints straight through when the canvas holds the whole file", async () => {
    const rig = harness(grid.blockCount);
    expect(rig.canvas.holdsWholeFile).toBe(true);
    await until(() => rig.canvas.holdsFrames(0, data.numFrames) && rig.quiet(), "the whole file");
    let painted = false;
    const near = dabFrames(0.01);
    expect(
      rig.canvas.paintWhenHeld(dabExtent(near.start, near.end), NO_OTHER_FILES, () => {
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
    canvas.paintWhenHeld(dabExtent(0, 1), { ...NO_OTHER_FILES, original: true }, () => {
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
    await until(() => canvas.isPopulated(), "the initial canvas fill");
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
    const canPaint = canvas.paintWhenHeld(dabExtent(0, 100), { sources: [need], impulses: [], original: false }, () => {
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
    canvas.paintWhenHeld(dabExtent(0, 100), { sources: [need], impulses: [], original: false }, () => {
      paintedAfterBump = true;
      return true;
    });
    expect(paintedAfterBump).toBe(false);

    await canvas.settle();
    expect(paintedAfterBump).toBe(true);
    expect(canvas.aimSource(need)).not.toBeNull();
  });
});
