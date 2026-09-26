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
import { blockGrid, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "../block-grid";
import { canvasViewOf, composeViewContent, fileRangesToView, viewRangesToFile, type CanvasView } from "../canvas-view";
import {
  AimRest,
  CANVAS_WINDOW_REST_MS,
  canvasWindowView,
  CanvasWindow,
  needsCanvasWindow,
  placeCanvasWindow,
  type BlockValueReader,
} from "../canvas-window";
import { paintOnBlock, StrokeSlots } from "../stroke-slots";
import { CANVAS_WINDOW_SPARE_BLOCKS } from "../gpu-budget";
import { PackedWindow } from "../packed-window";
import { readRenderTargetPixelsAsync } from "../async-readpixels";
import {
  composePixelRangeValues,
  float32BitsEqual,
  gatherPixelRanges,
  intersectPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
} from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";

const SAMPLE_RATE = 8000;
const BLOCK_SECONDS = 0.32;

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

describe("AimRest", () => {
  it("follows an aim only once it has held still", () => {
    const rest = new AimRest();
    expect(rest.wait(0, 100, 1000)).toBe(CANVAS_WINDOW_REST_MS);
    expect(rest.wait(0, 100, 1000 + CANVAS_WINDOW_REST_MS - 10)).toBe(10);
    expect(rest.wait(0, 100, 1000 + CANVAS_WINDOW_REST_MS)).toBe(0);
    expect(rest.wait(0, 100, 9000)).toBe(0);
  });

  it("starts the wait again whenever the aim moves", () => {
    const rest = new AimRest();
    rest.wait(0, 100, 1000);
    expect(rest.wait(0, 100, 1080)).toBe(10);
    // The span moved, so the wait is the whole of it again, not the ten left.
    expect(rest.wait(5, 105, 1080)).toBe(CANVAS_WINDOW_REST_MS);
    expect(rest.wait(5, 105, 1085)).toBe(CANVAS_WINDOW_REST_MS - 5);
    expect(rest.wait(5, 200, 1085)).toBe(CANVAS_WINDOW_REST_MS);
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
      [2, 5],
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
   * kept in stroke slots. Returns everything the commit would read.
   */
  async function walkCarryingPaint(): Promise<{
    slots: StrokeSlots;
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

    const slots = new StrokeSlots(gl, grid, grid.blockCount);
    disposers.push(() => slots.dispose());
    sub.beginStroke();
    for (const x of dabs) {
      const frames = dabFrames(x);
      const next = window.plan(view, frames.start, frames.end);
      if (next !== view) {
        expect(await window.acquire(next)).toBe(true);
        const painted = viewRangesToFile(view, sub.getDirtyPixelRanges()!);
        const entries = window
          .blocksOf(view)
          .filter((block) => block < next.firstBlock || block > next.lastBlock)
          .map((block) => ({ block, ranges: paintOnBlock(grid, block, painted) }))
          .filter((entry) => entry.ranges.length > 0);
        slots.keep(view, entries, sub.committedSource().texture, sub.strokeMaskTextures());
        sub.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: true });
        view = next;
      }
      const viewFrames = view.endFrame - view.startFrame;
      const cursor = new Vector2((x * data.numFrames - view.startFrame) / viewFrames, pitch);
      sub.renderStroke(strokeParams(cursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));
    }
    return { slots, window, sub, view, wholeData };
  }

  it("keeps the paint of blocks leaving mid-stroke for the commit's read", async () => {
    const { slots, sub, view, wholeData } = await walkCarryingPaint();
    expect(slots.size).toBeGreaterThan(0);

    // What the commit reads: the footprint the canvas still holds, plus the
    // pixels kept off it, taken from the canvas and the slots in turn.
    const heldViewRanges = sub.getDirtyPixelRanges()!;
    const heldFileRanges = viewRangesToFile(view, heldViewRanges);
    const kept = slots.ranges();
    const footprint = mergePixelRanges(heldFileRanges, kept);
    expect(pixelRangeCount(footprint)).toBeGreaterThan(pixelRangeCount(heldFileRanges));
    const read = composePixelRangeValues(footprint, [
      { ranges: kept, values: await slots.read(kept) },
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
    const { slots, window, sub, view, wholeData } = await walkCarryingPaint();

    const back = window.viewFor({ firstBlock: 0, lastBlock: 3 });
    expect(back.firstBlock).toBeLessThan(view.firstBlock);
    expect(await window.acquire(back)).toBe(true);
    sub.slideView(back, (target, blocks) => window.compose(back, blocks, target), { midStroke: true });

    // The block slots mirror the store, so block 0 comes back without the
    // paint; the stroke slots give it back, and let the block go.
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const list = blockPixelRanges(grid, 0);
    const fileRanges = list.ranges.slice(0, list.count * 2);
    const viewRanges = fileRangesToView(back, layout, fileRanges)!;
    const original = gatherPixelRanges(data.packedData, fileRanges);
    expect(float32BitsEqual(await sub.readPixelRanges(viewRanges), original)).toBe(true);
    expect(slots.holds(0)).toBe(true);
    const restored = slots.restore(
      back,
      window.blocksOf(back),
      (ranges, draw) => sub.drawCanvas(fileRangesToView(back, layout, ranges)!, draw),
      (step, draw) => sub.drawStrokeMask(step, draw),
    );
    expect(restored).toContain(0);
    expect(slots.holds(0)).toBe(false);
    expect(pixelRangeCount(intersectPixelRanges(slots.ranges(), fileRanges))).toBe(0);

    const read = await sub.readPixelRanges(viewRanges);
    const expected = gatherPixelRanges(wholeData, fileRanges);
    let maxMagnitude = 0;
    for (let i = 0; i < expected.length; i += 2) maxMagnitude = Math.max(maxMagnitude, Math.abs(read[i] - expected[i]));
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-4);
    let changed = 0;
    for (let i = 0; i < expected.length; i++) if (expected[i] !== original[i]) changed++;
    expect(changed, "the whole-file stroke must have painted block 0").toBeGreaterThan(0);
  });

  it("reads a block it lets go as it held it, with the stroke masks", async () => {
    const { slots } = await walkCarryingPaint();
    const [block] = [0, 1, 2, 3].filter((b) => slots.holds(b));
    expect(block).toBeDefined();
    const kept = slots.within(slots.ranges());
    const before = await slots.read(kept);
    const { ranges, read } = slots.letGo(block);
    expect(slots.holds(block)).toBe(false);
    const landed = await read;
    expect(float32BitsEqual(landed.values, composePixelRangeValues(ranges, [{ ranges: kept, values: before }]))).toBe(
      true,
    );
    // The walk's brush does not accumulate, so its step has a mask, and the
    // mask holds weight wherever the brush painted.
    expect(landed.masks.length).toBeGreaterThan(0);
    expect(landed.masks[0]!.some((weight) => weight > 0)).toBe(true);
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

  it("writes a commit's values into the slots that hold them, and reads a block on its way again", async () => {
    const store = Float32Array.from(data.packedData);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 2,
      read: async (ranges) => {
        // A read serves what the store held when it was issued.
        const values = gatherPixelRanges(store, ranges);
        await gate;
        return values;
      },
    });
    disposers.push(() => window.dispose());
    const first = window.viewFor({ firstBlock: 0, lastBlock: 1 });
    const filling = window.acquire(first);

    // A commit changes pixels in both blocks while their reads are on their way.
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const block0 = blockPixelRanges(grid, 0);
    const block1 = blockPixelRanges(grid, 1);
    const changed = mergePixelRanges(Uint32Array.of(block0.ranges[2] + 3, 5), Uint32Array.of(block1.ranges[0] + 1, 2));
    const commit = (values: Float32Array): void => {
      for (let i = 0, at = 0; i + 1 < changed.length; i += 2) {
        store.set(values.subarray(at * 4, (at + changed[i + 1]) * 4), changed[i] * 4);
        at += changed[i + 1];
      }
      window.storeMoved();
      window.patch(changed, values);
    };
    const values = gatherPixelRanges(store, changed).map((v) => v + 7);
    commit(values);
    open();
    expect(await filling).toBe(true);

    const target = new WebGLRenderTarget(first.textureWidth, first.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    disposers.push(() => target.dispose());
    const composed = async (): Promise<Float32Array> => {
      window.compose(first, window.blocksOf(first), target);
      const texels = await readRenderTargetPixelsAsync(gl, target, 0, 0, first.textureWidth, first.textureHeight);
      return gatherPixelRanges(texels, fileRangesToView(first, layout, changed)!);
    };
    expect(float32BitsEqual(await composed(), values)).toBe(true);

    // A slot already holding the block takes a later commit in place.
    const later = values.map((v) => v - 3);
    commit(later);
    expect(float32BitsEqual(await composed(), later)).toBe(true);
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

  it("warms free slots nearest the canvas first and stops before pushing a block out", async () => {
    const order: number[] = [];
    const firstPixels = Array.from({ length: grid.blockCount }, (_, block) => blockPixelRanges(grid, block).ranges[0]);
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 1,
      maxBytes: 6 * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL,
      read: async (ranges) => {
        order.push(firstPixels.indexOf(ranges[0]));
        return gatherPixelRanges(data.packedData, ranges);
      },
    });
    disposers.push(() => window.dispose());
    expect(grid.blockCount).toBeGreaterThan(6);
    expect(window.slotCount).toBe(6);
    const taken: boolean[] = [];
    for (let i = 0; i < 6; i++) taken.push(await window.warmOne(3));
    // Two slots stay free for a slide, so four of the six are warmed.
    expect(taken).toEqual([true, true, true, true, false, false]);
    expect(order).toEqual([3, 2, 4, 1]);
  });

  it("reads a block again when its slots are dropped while the read is on its way", async () => {
    let release: () => void = () => {};
    let reads = 0;
    const stale = new Float32Array(data.packedData.length).fill(7);
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 4,
      read: async (ranges) => {
        reads++;
        if (reads > 1) return gatherPixelRanges(data.packedData, ranges);
        await new Promise<void>((resolve) => (release = resolve));
        return gatherPixelRanges(stale, ranges);
      },
    });
    disposers.push(() => window.dispose());
    const view = window.viewFor({ firstBlock: 0, lastBlock: 0 });
    const filling = window.acquire(view);
    await Promise.resolve();
    window.invalidate();
    release();
    expect(await filling).toBe(true);
    expect(reads).toBe(2);

    const renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer.dispose());
    renderer.initialize((target) => window.compose(view, [0], target));
    const filled = await renderer.getFBOData();
    const expected = composeViewContent(view, data.packedData);
    expect(Array.from(filled.subarray(0, view.texels * 4))).toEqual(Array.from(expected.subarray(0, view.texels * 4)));
  });

  it("gives a window one window of slots and its spares", () => {
    // Finer blocks, so the file has more of them than the budget asks for.
    const fine = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, 0.1);
    const read: BlockValueReader = async (ranges) => gatherPixelRanges(data.packedData, ranges);
    const painted = new CanvasWindow(gl, fine, { windowBlocks: 5, read });
    const original = new PackedWindow(gl, fine, { windowBlocks: 5, read });
    disposers.push(() => painted.dispose());
    disposers.push(() => original.dispose());
    expect(painted.slotCount).toBe(5 + CANVAS_WINDOW_SPARE_BLOCKS);
    expect(original.slotCount).toBe(painted.slotCount);
  });

  it("keeps the newest window blocks when an abandoned read lands", async () => {
    const pending: Array<() => void> = [];
    const window = new CanvasWindow(gl, grid, {
      windowBlocks: 2,
      maxBytes: 4 * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL,
      read: (ranges) =>
        new Promise((resolve) => {
          pending.push(() => resolve(gatherPixelRanges(data.packedData, ranges)));
        }),
    });
    disposers.push(() => window.dispose());
    // Four slots, so four blocks landing at once fill them.
    expect(window.slotCount).toBe(4);

    const abandoned = [
      window.acquire(window.viewFor({ firstBlock: 0, lastBlock: 1 })),
      window.acquire(window.viewFor({ firstBlock: 2, lastBlock: 3 })),
    ];
    const wanted = window.viewFor({ firstBlock: 5, lastBlock: 6 });
    const live = window.acquire(wanted);

    // The newest window lands first; the abandoned reads land after it, and
    // the slots they claim have to come from somewhere.
    for (const settle of pending.slice(4)) settle();
    expect(await live).toBe(true);
    for (const settle of pending.slice(0, 4)) settle();
    await Promise.all(abandoned);

    expect(window.missing(wanted)).toEqual([]);
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
