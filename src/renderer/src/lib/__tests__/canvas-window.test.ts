import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { blockGrid, blockPixelRanges, type BlockGrid } from "../block-grid";
import { canvasViewOf, composeViewContent, fileRangesToView, viewRangesToFile, type CanvasView } from "../canvas-view";
import {
  canvasWindowView,
  CanvasWindow,
  needsCanvasWindow,
  placeCanvasWindow,
  type BlockValueReader,
} from "../canvas-window";
import { CarriedPaint, carryPaintOut, dropReturningPaint } from "../carried-paint";
import { PackedWindow } from "../packed-window";
import {
  composePixelRangeValues,
  gatherPixelRanges,
  intersectPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
} from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";

const SAMPLE_RATE = 8000;
const BLOCK_SECONDS = 0.3;

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

function mockGrid(): BlockGrid {
  const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
  return blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, BLOCK_SECONDS);
}

describe("placeCanvasWindow", () => {
  const blockCount = 8;

  it("centres the window on the blocks the brush needs", () => {
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 2, lastNeeded: 4 })).toEqual({
      firstBlock: 2,
      lastBlock: 5,
    });
  });

  it("keeps the window while the brush stays a margin inside it", () => {
    const current = { firstBlock: 2, lastBlock: 5 };
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 3, lastNeeded: 4, current })).toBe(current);
  });

  it("moves the window when the brush reaches its margin", () => {
    const current = { firstBlock: 2, lastBlock: 5 };
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 4, lastNeeded: 5, current })).toEqual({
      firstBlock: 3,
      lastBlock: 6,
    });
  });

  it("needs no margin on a side the file does not continue past", () => {
    const atStart = { firstBlock: 0, lastBlock: 3 };
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 0, lastNeeded: 1, current: atStart })).toBe(
      atStart,
    );
    const atEnd = { firstBlock: 4, lastBlock: 7 };
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 6, lastNeeded: 7, current: atEnd })).toBe(
      atEnd,
    );
  });

  it("clamps the window to the file and keeps its size", () => {
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 0, lastNeeded: 0 })).toEqual({
      firstBlock: 0,
      lastBlock: 3,
    });
    expect(placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 7, lastNeeded: 7 })).toEqual({
      firstBlock: 4,
      lastBlock: 7,
    });
    expect(placeCanvasWindow({ blockCount: 3, windowBlocks: 8, firstNeeded: 1, lastNeeded: 2 })).toEqual({
      firstBlock: 0,
      lastBlock: 2,
    });
  });

  it("re-places a current window of another size", () => {
    const wholeFile = { firstBlock: 0, lastBlock: 7 };
    expect(
      placeCanvasWindow({ blockCount, windowBlocks: 4, firstNeeded: 1, lastNeeded: 2, current: wholeFile }),
    ).toEqual({ firstBlock: 0, lastBlock: 3 });
  });
});

describe("canvasWindowView", () => {
  it("gives every window of a file the same texture fold", () => {
    const grid = mockGrid();
    expect(grid.blockCount).toBe(7);
    const tailSpan = { firstBlock: grid.blockCount - 4, lastBlock: grid.blockCount - 1 };
    const interior = canvasWindowView(grid, { firstBlock: 0, lastBlock: 3 }, 4);
    const tail = canvasWindowView(grid, tailSpan, 4);
    // The window at the end of the file holds fewer texels, so it would lay
    // itself out in a shorter texture than the windows before it.
    const ownFold = canvasViewOf(grid, tailSpan.firstBlock, tailSpan.lastBlock);
    expect(tail.texels).toBeLessThan(interior.texels);
    expect(ownFold.textureHeight).not.toBe(interior.textureHeight);
    expect(tail.textureWidth).toBe(interior.textureWidth);
    expect(tail.textureHeight).toBe(interior.textureHeight);
    expect(tail.textureWidth * tail.textureHeight).toBeGreaterThanOrEqual(tail.texels);
    expect(needsCanvasWindow(grid, 4)).toBe(true);
    expect(needsCanvasWindow(grid, 7)).toBe(false);
  });
});

describe("a canvas window that follows the brush", () => {
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

    data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
    const packed = data.packedData;
    for (let i = 0; i < packed.length / 4; i++) {
      packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13));
      packed[i * 4 + 1] = Math.sin(i * 0.7) * 3;
      packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29));
      packed[i * 4 + 3] = Math.cos(i * 0.41) * 3;
    }
    grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, BLOCK_SECONDS);

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

  /**
   * The renderer as its own paint source. The file's own spectrogram travels
   * with the canvas, so `span` is what tells the shaders which part of it the
   * canvas holds.
   */
  function sourceFor(renderer: StrokeRenderer, span?: CanvasView): SourceFileInfo {
    return {
      id: "window",
      filePath: "/window.wav",
      displayName: "window.wav",
      spectrogramData: data,
      textures: renderer.getTextures(),
      view: span,
    };
  }

  it("walks the window along a stroke and paints what the whole-file canvas paints", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Walk",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    // The brush spans a beat (0.5 s here), so each dab needs three blocks and
    // the four-block window has to move to keep up with the walk.
    const dabs = [0.15, 0.35, 0.55, 0.75];
    const pitch = 0.35;
    const fileDuration = data.numFrames / SAMPLE_RATE;

    const whole = new StrokeRenderer(gl, data, strokeTextures, "window", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    whole.beginStroke();
    for (const x of dabs) {
      whole.renderStroke(strokeParams(new Vector2(x, pitch), fileDuration), state, sourceFor(whole));
    }
    const wholeData = await whole.getFBOData();

    const reads: number[][] = [];
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      maxBytes: 0,
      read: async (ranges) => {
        reads.push(Array.from(ranges));
        return gatherPixelRanges(data.packedData, ranges);
      },
    });
    disposers.push(() => window.dispose());

    // A dab paints from the cursor to a beat later, so that is the span the
    // window must hold before it runs.
    const beatFrames = (60 / 120) * SAMPLE_RATE;
    const dabFrames = (x: number): { start: number; end: number } => {
      const start = x * data.numFrames;
      return { start, end: Math.min(data.numFrames, start + beatFrames) };
    };

    let view = window.plan(null, dabFrames(dabs[0]).start, dabFrames(dabs[0]).end);
    expect(await window.acquire(view)).toBe(true);
    const sub = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    sub.initialize();
    disposers.push(() => sub.dispose());
    window.compose(view, window.blocksOf(view), sub.getTextures().packed);

    const spans: Array<[number, number]> = [[view.firstBlock, view.lastBlock]];
    sub.beginStroke();
    for (const x of dabs) {
      const frames = dabFrames(x);
      const next = window.plan(view, frames.start, frames.end);
      if (next !== view) {
        expect(await window.acquire(next)).toBe(true);
        sub.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: true });
        view = next;
        spans.push([view.firstBlock, view.lastBlock]);
      }
      const viewFrames = view.endFrame - view.startFrame;
      const cursor = new Vector2((x * data.numFrames - view.startFrame) / viewFrames, pitch);
      sub.renderStroke(strokeParams(cursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));
    }
    const subData = await sub.getFBOData();

    expect(spans).toEqual([
      [0, 3],
      [1, 4],
      [3, 6],
    ]);
    // Only the blocks the windows held were read, each exactly once.
    expect(reads.length).toBe(7);
    const blockRanges = (block: number): number[] => {
      const list = blockPixelRanges(grid, block);
      return Array.from(list.ranges.subarray(0, list.count * 2));
    };
    expect(reads).toEqual([0, 1, 2, 3, 4, 5, 6].map(blockRanges));

    const inView = composeViewContent(view, wholeData);
    let maxMagnitude = 0;
    let maxPhase = 0;
    for (let i = 0; i < view.texels * 4; i++) {
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) maxMagnitude = Math.max(maxMagnitude, diff);
      else maxPhase = Math.max(maxPhase, diff);
    }
    // The two paths compute the same positions from different texture bases,
    // so a dab differs by float rounding and the walk compounds it over four.
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-4);
    expect(maxPhase, `largest phase difference ${maxPhase}`).toBeLessThan(1e-2);
  });

  /**
   * The four-dab walk of the test above, with the paint of leaving blocks
   * carried off the canvas. Returns everything the commit would read.
   */
  async function walkCarryingPaint(): Promise<{
    carried: CarriedPaint;
    window: CanvasWindow;
    sub: StrokeRenderer;
    view: CanvasView;
    wholeData: Float32Array;
  }> {
    const state = createMockStateWithSteps([
      {
        name: "Walk",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    const dabs = [0.15, 0.35, 0.55, 0.75];
    const pitch = 0.35;
    const fileDuration = data.numFrames / SAMPLE_RATE;

    const whole = new StrokeRenderer(gl, data, strokeTextures, "window", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    whole.beginStroke();
    for (const x of dabs) {
      whole.renderStroke(strokeParams(new Vector2(x, pitch), fileDuration), state, sourceFor(whole));
    }
    const wholeData = await whole.getFBOData();

    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());

    const beatFrames = (60 / 120) * SAMPLE_RATE;
    const dabFrames = (x: number): { start: number; end: number } => {
      const start = x * data.numFrames;
      return { start, end: Math.min(data.numFrames, start + beatFrames) };
    };

    let view = window.plan(null, dabFrames(dabs[0]).start, dabFrames(dabs[0]).end);
    expect(await window.acquire(view)).toBe(true);
    const sub = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    sub.initialize();
    disposers.push(() => sub.dispose());
    window.compose(view, window.blocksOf(view), sub.getTextures().packed);

    const carried = new CarriedPaint();
    sub.beginStroke();
    for (const x of dabs) {
      const frames = dabFrames(x);
      const next = window.plan(view, frames.start, frames.end);
      if (next !== view) {
        expect(await window.acquire(next)).toBe(true);
        carryPaintOut(sub, window, carried, next, data.numFrames);
        sub.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: true });
        view = next;
      }
      const viewFrames = view.endFrame - view.startFrame;
      const cursor = new Vector2((x * data.numFrames - view.startFrame) / viewFrames, pitch);
      sub.renderStroke(strokeParams(cursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));
    }
    await carried.settled();
    return { carried, window, sub, view, wholeData };
  }

  it("carries the paint of blocks leaving mid-stroke into the commit's read", async () => {
    const { carried, sub, view, wholeData } = await walkCarryingPaint();
    expect(carried.size).toBeGreaterThan(0);

    // What the commit reads: the footprint the canvas still holds, plus the
    // pixels carried off it, taken from the canvas and the carry in turn.
    const heldViewRanges = sub.getDirtyPixelRanges()!;
    const heldFileRanges = viewRangesToFile(view, heldViewRanges);
    const footprint = mergePixelRanges(heldFileRanges, carried.ranges());
    expect(pixelRangeCount(footprint)).toBeGreaterThan(pixelRangeCount(heldFileRanges));
    const read = composePixelRangeValues(footprint, [
      carried.snapshot(),
      { ranges: heldFileRanges, values: await sub.readPixelRanges(heldViewRanges) },
    ]);

    // The whole-file stroke painted the same coefficients over that footprint.
    const expected = gatherPixelRanges(wholeData, footprint);
    let maxMagnitude = 0;
    let maxPhase = 0;
    for (let i = 0; i < expected.length; i++) {
      const diff = Math.abs(read[i] - expected[i]);
      if (i % 2 === 0) maxMagnitude = Math.max(maxMagnitude, diff);
      else maxPhase = Math.max(maxPhase, diff);
    }
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-4);
    expect(maxPhase, `largest phase difference ${maxPhase}`).toBeLessThan(1e-2);
  });

  it("brings the paint back when the window returns to a block it left", async () => {
    const { carried, window, sub, view, wholeData } = await walkCarryingPaint();

    const back = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    expect(window.ready(back)).toBe(true);
    sub.slideView(back, (target, blocks) => window.compose(back, blocks, target), { midStroke: true });
    expect(back.firstBlock).toBeLessThan(view.firstBlock);
    const returned = await sub.getFBOData();

    // The canvas speaks for those pixels again, so the carry lets them go.
    const carriedBefore = carried.size;
    dropReturningPaint(carried, window, back, view);
    expect(carried.size).toBeLessThan(carriedBefore);
    const stillCarried = carried.ranges();
    for (let i = 0; i + 1 < stillCarried.length; i += 2) {
      expect(
        fileRangesToView(back, { numBands: data.numBands, metadata: data.metadata }, stillCarried.slice(i, i + 2)),
      ).toBeNull();
    }

    // Block 0 left the window with paint on it, so the slots had to keep it.
    const list = blockPixelRanges(grid, 0);
    const fileRanges = list.ranges.slice(0, list.count * 2);
    const viewRanges = fileRangesToView(back, { numBands: data.numBands, metadata: data.metadata }, fileRanges)!;
    const read = gatherPixelRanges(returned, viewRanges);
    const expected = gatherPixelRanges(wholeData, fileRanges);
    let maxMagnitude = 0;
    for (let i = 0; i < expected.length; i += 2) maxMagnitude = Math.max(maxMagnitude, Math.abs(read[i] - expected[i]));
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-4);
    let changed = 0;
    const original = gatherPixelRanges(data.packedData, fileRanges);
    for (let i = 0; i < expected.length; i++) if (expected[i] !== original[i]) changed++;
    expect(changed, "the whole-file stroke must have painted block 0").toBeGreaterThan(0);
  });

  it("keeps carrying a block whose slot lost its paint to the store", async () => {
    const { carried, window, view } = await walkCarryingPaint();
    const back = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    // The slots forget block 0, so it comes back from the store without the
    // paint and the carry has to keep speaking for it.
    window.invalidate([0]);
    expect(await window.acquire(back)).toBe(true);

    const before = carried.ranges();
    dropReturningPaint(carried, window, back, view);
    const after = carried.ranges();
    const list = blockPixelRanges(grid, 0);
    const blockZero = list.ranges.slice(0, list.count * 2);
    expect(pixelRangeCount(intersectPixelRanges(after, blockZero))).toBe(
      pixelRangeCount(intersectPixelRanges(before, blockZero)),
    );
    // Blocks 1 and 2 kept theirs, so those pixels left the carry.
    expect(pixelRangeCount(after)).toBeLessThan(pixelRangeCount(before));
  });

  it("fills a window whose blocks take every slot", async () => {
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      maxBytes: 0,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());
    const first = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    expect(await window.acquire(first)).toBe(true);

    // Composing the other three leaves block 3 the least recently used of the
    // four slots, and it is the one block the next window keeps — so its slot
    // is what a careless read for that window would take.
    const target = new WebGLRenderTarget(first.textureWidth, first.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    disposers.push(() => target.dispose());
    window.compose(first, [0, 1, 2], target);
    expect(await window.acquire(window.viewFor({ firstBlock: 3, lastBlock: 6 }))).toBe(true);
  });

  it("stops calling a block painted once the store fills its slot again", async () => {
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 2,
      maxBytes: 0,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());
    const first = window.viewFor({ firstBlock: 0, lastBlock: 1 });
    expect(await window.acquire(first)).toBe(true);
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, first);
    renderer.initialize();
    disposers.push(() => renderer.dispose());
    window.compose(first, window.blocksOf(first), renderer.getTextures().packed);

    window.copyBack(first, [0], renderer.committedSource().texture);
    expect(window.holdsPaint(0)).toBe(true);

    // The smallest cache holds two windows, here four slots. Four more blocks
    // enter, so block 0 is the oldest, loses its slot, and comes back from the
    // store without what the canvas gave it.
    expect(await window.acquire(window.viewFor({ firstBlock: 2, lastBlock: 3 }))).toBe(true);
    expect(await window.acquire(window.viewFor({ firstBlock: 4, lastBlock: 5 }))).toBe(true);
    expect(await window.acquire(first)).toBe(true);
    expect(window.holdsPaint(0)).toBe(false);
  });

  it("keeps naming the blocks an abandoned fill left off the canvas", async () => {
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      maxBytes: 0,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());
    const first = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    expect(window.canvasLacks(first)).toEqual([0, 1, 2, 3]);

    // The canvas takes the first view, then a request for it is dropped before
    // its blocks are composed — the canvas is still empty.
    window.markOnCanvas(window.blocksOf(first));
    expect(window.canvasLacks(first)).toEqual([]);
    window.clearCanvas();

    // Sliding two blocks along keeps the overlap, which holds nothing, and
    // composes what enters. The canvas still lacks the overlap.
    const next = window.viewFor({ firstBlock: 2, lastBlock: 5 });
    window.markSlid(next, first);
    expect(window.canvasLacks(next)).toEqual([2, 3]);

    window.markOnCanvas(window.canvasLacks(next));
    const back = window.viewFor({ firstBlock: 1, lastBlock: 4 });
    window.markSlid(back, next);
    expect(window.canvasLacks(back)).toEqual([]);
  });

  it("starts the canvas empty and takes each block as it lands", async () => {
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());
    const view = window.viewFor({ firstBlock: 1, lastBlock: 4 });
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer.dispose());

    const cold: number[] = [];
    renderer.initialize((target) => cold.push(...window.composeResident(view, target)));
    expect(cold).toEqual([1, 2, 3, 4]);
    const empty = await renderer.getFBOData();
    let painted = 0;
    for (let i = 0; i < view.texels * 4; i++) if (empty[i] !== 0) painted++;
    expect(painted).toBe(0);

    expect(await window.acquire(view)).toBe(true);
    renderer.fillCanvas((target) => window.compose(view, cold, target));
    const filled = await renderer.getFBOData();
    const expected = composeViewContent(view, data.packedData);
    let firstDifference = -1;
    for (let i = 0; i < view.texels * 4; i++) {
      if (filled[i] !== expected[i]) {
        firstDifference = i;
        break;
      }
    }
    expect(firstDifference, `first differing texel value at ${firstDifference}`).toBe(-1);
  });

  it("reads a block once however many windows ask for it", async () => {
    let reads = 0;
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      maxBytes: Infinity,
      read: async (ranges) => {
        reads++;
        return gatherPixelRanges(data.packedData, ranges);
      },
    });
    disposers.push(() => window.dispose());
    const first = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    const second = window.viewFor({ firstBlock: 2, lastBlock: 5 });
    expect(window.ready(first)).toBe(false);
    const [a, b] = await Promise.all([window.acquire(first), window.acquire(second)]);
    expect(a && b).toBe(true);
    expect(reads).toBe(6);
    expect(window.ready(first)).toBe(true);
    expect(window.ready(second)).toBe(true);
    expect(await window.acquire(second)).toBe(true);
    expect(reads).toBe(6);
  });

  it("keeps the slots of both windows when the brush jumps a whole window", async () => {
    // Finer blocks, so two windows of five sit side by side with no overlap.
    const fine = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, 0.1);
    const window = new CanvasWindow(gl, fine, {
      windowBlocks: 5,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());

    const first = window.viewFor({ firstBlock: 0, lastBlock: 4 });
    expect(await window.acquire(first)).toBe(true);
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, first);
    renderer.initialize();
    disposers.push(() => renderer.dispose());
    window.compose(first, window.blocksOf(first), renderer.getTextures().packed);

    const state = createMockStateWithSteps([
      {
        name: "Jump",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    renderer.beginStroke();
    const firstFrames = first.endFrame - first.startFrame;
    renderer.renderStroke(
      strokeParams(new Vector2(0.2, 0.35), firstFrames / SAMPLE_RATE),
      state,
      sourceFor(renderer, first),
    );

    // The whole window leaves at once: its paint folds back into its own slots
    // while the entering blocks hold theirs, so the cache carries both sets.
    const next = window.viewFor({ firstBlock: 10, lastBlock: 14 });
    expect(await window.acquire(next)).toBe(true);
    carryPaintOut(renderer, window, new CarriedPaint(), next, data.numFrames);
    renderer.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: true });
    expect(window.missing(next)).toEqual([]);
    expect(window.holdsPaint(0)).toBe(true);
  });

  it("gives a window nothing folds paint back into one window of slots", () => {
    // Finer blocks, so the file has more of them than either budget asks for.
    const fine = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, 0.1);
    const read: BlockValueReader = async (ranges) => gatherPixelRanges(data.packedData, ranges);
    const painted = new CanvasWindow(gl, fine, { windowBlocks: 5, read });
    const readOnly = new CanvasWindow(gl, fine, { windowBlocks: 5, readOnly: true, read });
    const original = new PackedWindow(gl, fine, { windowBlocks: 5, read });
    disposers.push(() => painted.dispose());
    disposers.push(() => readOnly.dispose());
    disposers.push(() => original.dispose());
    expect(painted.slotCount).toBe(readOnly.slotCount + 5);
    expect(original.slotCount).toBe(readOnly.slotCount);
  });

  it("reports a view it could not fill", async () => {
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      maxBytes: 0,
      read: async () => null,
    });
    disposers.push(() => window.dispose());
    const view = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    expect(await window.acquire(view)).toBe(false);
    expect(window.ready(view)).toBe(false);
    expect(window.missing(view)).toEqual([0, 1, 2, 3]);
  });
});
