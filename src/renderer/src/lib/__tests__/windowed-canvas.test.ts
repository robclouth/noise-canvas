import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { blockGrid, blockOfFrame, blockPixelRanges, type BlockGrid } from "../block-grid";
import { fileRangesToView } from "../canvas-view";
import { float32BitsEqual, gatherPixelRanges } from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";
import type { SourceNeed } from "../source-window";

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
const NO_OTHER_FILES = { sources: [], impulses: [] };

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
      renderer?.getDisplayPyramid()?.seedingFromCompact();
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
    const canPaint = canvas.paintWhenHeld(0, 100, { sources: [need], impulses: [] }, () => {
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
    canvas.paintWhenHeld(0, 100, { sources: [need], impulses: [] }, () => {
      paintedAfterBump = true;
      return true;
    });
    expect(paintedAfterBump).toBe(false);

    await canvas.settle();
    expect(paintedAfterBump).toBe(true);
    expect(canvas.aimSource(need)).not.toBeNull();
  });
});
