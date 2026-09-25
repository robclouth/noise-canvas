import { FloatType, NearestFilter, RGBAFormat, WebGLRenderer, WebGLRenderTarget } from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import type { BandLayout } from "../band-layout";
import { blockGrid, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL } from "../block-grid";
import { BlockSlotCache } from "../block-slot-cache";
import { canvasViewOf, type CanvasView } from "../canvas-view";
import { gatherPixelRanges } from "../pixel-ranges";

const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 4 });
const layout: BandLayout = { numBands: data.numBands, metadata: data.metadata };
const grid = blockGrid(layout, data.numFrames, 8000, 0.25);
const slotBytes = blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL;

// Every texel gets its own value, so a read from the wrong place shows.
const packed = Float32Array.from(data.packedData);
for (let i = 0; i < packed.length / 4; i++) {
  packed[i * 4] = Math.fround(Math.sin(i * 0.13));
  packed[i * 4 + 1] = i % 7;
  packed[i * 4 + 2] = Math.fround(Math.cos(i * 0.29));
  packed[i * 4 + 3] = (i * 3) % 11;
}
const painted = Float32Array.from(packed, (value) => value + 1);

function blockValues(source: Float32Array, index: number): Float32Array {
  const list = blockPixelRanges(grid, index);
  return gatherPixelRanges(source, list.ranges.subarray(0, list.count * 2));
}

/** The view's packed content drawn from a whole-file array, padding zeroed. */
function viewContent(view: CanvasView, source: Float32Array): Float32Array {
  const out = new Float32Array(view.textureWidth * view.textureHeight * 4);
  for (let band = 0; band < view.layout.numBands; band++) {
    const fileStart = view.ranges[band * 2];
    const count = view.ranges[band * 2 + 1];
    const viewStart = view.layout.metadata[band * 4];
    out.set(source.subarray(fileStart * 4, (fileStart + count) * 4), viewStart * 4);
  }
  return out;
}

function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : shared;
}

describe("block slot cache", () => {
  let gl: WebGLRenderer;

  beforeAll(() => {
    expect(grid.blockCount).toBeGreaterThanOrEqual(6);
    gl = new WebGLRenderer({ antialias: false });
  });

  afterAll(() => {
    gl.dispose();
  });

  function viewTarget(view: CanvasView): WebGLRenderTarget {
    return new WebGLRenderTarget(view.textureWidth, view.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  function readTarget(target: WebGLRenderTarget): Float32Array {
    const out = new Float32Array(target.width * target.height * 4);
    gl.readRenderTargetPixels(target, 0, 0, target.width, target.height, out);
    return out;
  }

  function expectComposed(view: CanvasView, target: WebGLRenderTarget, source: Float32Array): void {
    const got = readTarget(target).subarray(0, view.texels * 4);
    const expected = viewContent(view, source).subarray(0, view.texels * 4);
    expect(firstDifference(got, expected)).toBe(-1);
  }

  it("uploads every block and composes the whole-file view byte-identically", () => {
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * slotBytes);
    const view = canvasViewOf(grid, 0, grid.blockCount - 1);
    const blocks = Array.from({ length: grid.blockCount }, (_, i) => i);
    expect(cache.missing(blocks)).toEqual(blocks);
    for (const block of blocks) cache.upload(block, blockValues(packed, block));
    expect(cache.missing(blocks)).toEqual([]);
    const target = viewTarget(view);
    cache.compose(view, blocks, target);
    expectComposed(view, target, packed);
    target.dispose();
    cache.dispose();
  });

  it("composes a sub-view at the view's own offsets", () => {
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * slotBytes);
    const view = canvasViewOf(grid, 2, 4);
    const blocks = [2, 3, 4];
    for (const block of blocks) cache.upload(block, blockValues(packed, block));
    const target = viewTarget(view);
    cache.compose(view, blocks, target);
    expectComposed(view, target, packed);
    target.dispose();
    cache.dispose();
  });

  it("spreads slots over single-slot pages without changing the result", () => {
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * slotBytes, slotBytes);
    expect(cache.allocatedBytes).toBe(0);
    const view = canvasViewOf(grid, 2, 4);
    const blocks = [2, 3, 4];
    for (const block of blocks) cache.upload(block, blockValues(packed, block));
    expect(cache.allocatedBytes).toBeGreaterThanOrEqual(3 * slotBytes);
    const target = viewTarget(view);
    cache.compose(view, blocks, target);
    expectComposed(view, target, packed);
    target.dispose();
    cache.dispose();
  });

  it("patches the named pixels of the blocks that hold slots and leaves the rest", () => {
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * slotBytes);
    const view = canvasViewOf(grid, 2, 4);
    const blocks = [2, 3, 4];
    for (const block of blocks) cache.upload(block, blockValues(packed, block));

    // Part of every band of block 3, and all of block 5, which has no slot.
    const three = blockPixelRanges(grid, 3);
    const parts: number[] = [];
    for (let i = 0; i < three.count; i++) {
      const count = three.ranges[i * 2 + 1];
      if (count > 1) parts.push(three.ranges[i * 2] + 1, count - 1);
    }
    const five = blockPixelRanges(grid, 5);
    for (let i = 0; i < five.count; i++) parts.push(five.ranges[i * 2], five.ranges[i * 2 + 1]);
    const ranges = Uint32Array.from(parts);
    cache.patch(ranges, gatherPixelRanges(painted, ranges));
    expect(cache.missing([5])).toEqual([5]);

    const target = viewTarget(view);
    cache.compose(view, blocks, target);
    const merged = Float32Array.from(packed);
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      const start = ranges[i];
      merged.set(painted.subarray(start * 4, (start + ranges[i + 1]) * 4), start * 4);
    }
    expectComposed(view, target, merged);
    target.dispose();
    cache.dispose();
  });

  it("evicts the least recently used block when every slot is taken", () => {
    const cache = new BlockSlotCache(gl, grid, 2 * slotBytes);
    expect(cache.slotCount).toBe(2);
    cache.upload(0, blockValues(packed, 0));
    cache.upload(1, blockValues(packed, 1));
    const view = canvasViewOf(grid, 0, 0);
    const target = viewTarget(view);
    cache.compose(view, [0], target);
    cache.upload(2, blockValues(packed, 2));
    expect(cache.missing([0, 1, 2])).toEqual([1]);
    cache.compose(view, [0], target);
    expectComposed(view, target, packed);
    target.dispose();
    cache.dispose();
  });

  it("refuses mismatched values, absent blocks and blocks outside the view", () => {
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * slotBytes);
    expect(() => cache.upload(0, new Float32Array(4))).toThrow();
    const view = canvasViewOf(grid, 0, 0);
    const target = viewTarget(view);
    expect(() => cache.compose(view, [0], target)).toThrow();
    cache.upload(grid.blockCount - 1, blockValues(packed, grid.blockCount - 1));
    expect(() => cache.compose(view, [grid.blockCount - 1], target)).toThrow();
    target.dispose();
    cache.dispose();
  });
});
