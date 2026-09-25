import { FloatType, HalfFloatType, RedFormat, RGFormat, RGBAFormat, UnsignedByteType, WebGLRenderer } from "three";
import type { WebGLRenderTarget } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analysisPeakTexels,
  CANVAS_WINDOW_SPARE_BLOCKS,
  canvasExtraSlotBlocks,
  canvasWindowBlocks,
  canvasWindowBudgetBytes,
  canvasWindowBytes,
  CPU_BYTES_PER_TEXEL_FILE,
  GPU_BYTES_PER_TEXEL_FILE,
  GPU_BYTES_PER_TEXEL_SCRATCH,
  historyCacheBytes,
  remainingCoefficientBudget,
  type OpenFileTexels,
  spectrogramBytes,
  usedBudgetFraction,
} from "../gpu-budget";
import { blockGrid, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "../block-grid";
import { CanvasWindow } from "../canvas-window";
import { PackedWindow } from "../packed-window";
import {
  DISPLAY_PYRAMID_BYTES_PER_TEXEL,
  DISPLAY_PYRAMID_MAX_TEXELS,
  displayPyramidBudgetTexels,
} from "../display-pyramid";
import { displayTilesBytes } from "../display-tiles";
import { historyCacheBudgets } from "../history-cache-budgets";
import { MAX_STEPS } from "../constants";
import { StrokeScratch, StrokeScratchPool } from "../stroke-scratch-pool";

/**
 * The budget caps how large a file may be analysed against the GPU memory the
 * open files already hold. Its per-texel rates are constants, so they hold only
 * while they match what the renderer really allocates. Under-count and an
 * analysis is admitted that does not fit, which surfaces as a failed GPU
 * allocation rather than the graceful "not enough graphics memory" path.
 */

const CHANNELS: Record<number, number> = {
  [RGBAFormat]: 4,
  [RGFormat]: 2,
  [RedFormat]: 1,
};

const BYTES: Record<number, number> = {
  [FloatType]: 4,
  [HalfFloatType]: 2,
  [UnsignedByteType]: 1,
};

// A target with depthBuffer set gets a DEPTH_COMPONENT24 renderbuffer (four
// bytes a texel) from three whether or not anything writes depth.
const DEPTH_BYTES_PER_TEXEL = 4;

function bytesPerTexel(target: WebGLRenderTarget): number {
  const colour = target.textures.reduce((sum, texture) => {
    const channels = CHANNELS[texture.format];
    const bytes = BYTES[texture.type];
    expect(channels, `unhandled texture format ${texture.format}`).toBeDefined();
    expect(bytes, `unhandled texture type ${texture.type}`).toBeDefined();
    return sum + channels * bytes;
  }, 0);
  return colour + (target.depthBuffer ? DEPTH_BYTES_PER_TEXEL : 0);
}

function allocatedBytesPerTexel(scratch: StrokeScratch): number {
  const { strokeMaskFbos, ...single } = scratch;
  const masks = strokeMaskFbos.filter((mask) => mask !== null);
  return [...Object.values(single), ...masks].reduce(
    (sum: number, target) => sum + (target ? bytesPerTexel(target) : 0),
    0,
  );
}

describe("GPU budget rates", () => {
  // The budget is charged for the pool at its fullest: both pass buffers and the
  // modulator target a brush can ask for at any time, even though each is only
  // allocated on first use.
  it("charges scratch at what the pool really allocates when full", () => {
    const pool = new StrokeScratchPool();
    const owner = {};
    try {
      const { scratch } = pool.acquire(owner, 32, 16);
      pool.passFbos(2);
      pool.modulatorFbo();
      for (let step = 0; step < MAX_STEPS; step++) pool.maskFbo(step);
      expect(GPU_BYTES_PER_TEXEL_SCRATCH).toBe(allocatedBytesPerTexel(scratch));
      expect(pool.allocatedBytes).toBe(GPU_BYTES_PER_TEXEL_SCRATCH * 32 * 16);
    } finally {
      pool.release(owner);
    }
  });

  it("allocates the pass buffers and the modulator target only when asked for them", () => {
    const pool = new StrokeScratchPool();
    const owner = {};
    try {
      const { scratch } = pool.acquire(owner, 32, 16);
      expect(scratch.passFbo1).toBeNull();
      expect(scratch.modulatorFbo).toBeNull();
      expect(scratch.strokeMaskFbos).toEqual([]);
      const bare = pool.allocatedBytes;

      expect(pool.passFbos(1)).toHaveLength(1);
      expect(scratch.passFbo2).toBeNull();
      const withOnePass = pool.allocatedBytes;
      expect(withOnePass - bare).toBe(bytesPerTexel(scratch.passFbo1!) * 32 * 16);

      const target = pool.modulatorFbo();
      expect(target.width).toBe(32);
      expect(target.height).toBe(16);
      expect(pool.allocatedBytes - withOnePass).toBe(bytesPerTexel(target) * 32 * 16);
    } finally {
      pool.release(owner);
    }
  });

  it("counts scratch once, against the largest open file", () => {
    // The pool is shared, so a second open file of the same size adds its own
    // resident textures but no second scratch set.
    const texels = 1000;
    const one = spectrogramBytes([whole(texels)], false);
    const two = spectrogramBytes([whole(texels), whole(texels)], false);
    expect(one).toBe((GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels + displayBytes(texels));
    expect(two - one).toBe(GPU_BYTES_PER_TEXEL_FILE * texels + displayBytes(texels));
  });
});

/** An open file whose canvas holds all of it. */
const whole = (texels: number): OpenFileTexels => ({ file: texels, canvas: texels, block: 0 });

/** What one open file's display pyramid takes out of the budget. */
const pyramidBytes = (texels: number): number => displayPyramidBudgetTexels(texels) * DISPLAY_PYRAMID_BYTES_PER_TEXEL;

/** What one open file's display textures together take out of the budget. */
const displayBytes = (texels: number): number => pyramidBytes(texels) + displayTilesBytes();

describe("history cache overhead", () => {
  const TOTAL_MEMORY = 8 * 1024 ** 3;
  const GPU_MEMORY = 4 * 1024 ** 3;
  const GPU_BUDGET_SHARE = 0.5;

  beforeAll(() => {
    // Both figures are read once and cached, so stub them before the first
    // call rather than per test.
    const w = window as unknown as Record<string, unknown>;
    w.nodeOs = { homedir: () => "/home", totalmem: () => TOTAL_MEMORY };
    w.audioAnalysis = { getGpuMemoryInfo: () => ({ bytes: GPU_MEMORY, unified: true }) };
  });

  const overhead = (): number => {
    const budgets = historyCacheBudgets(TOTAL_MEMORY);
    return budgets.deltas + budgets.audioHops + budgets.blockResident;
  };

  it("sums the three history cache budgets", () => {
    expect(historyCacheBytes()).toBe(overhead());
  });

  it("charges the caches once, however many files are open", () => {
    const texels = 1000;
    const one = spectrogramBytes([whole(texels)], true);
    const two = spectrogramBytes([whole(texels), whole(texels)], true);
    expect(one).toBe(
      (GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels +
        displayBytes(texels) +
        overhead(),
    );
    expect(two - one).toBe((GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE) * texels + displayBytes(texels));
  });

  it("charges nothing before a file is open", () => {
    expect(spectrogramBytes([], true)).toBe(0);
  });

  it("leaves the caches uncharged when the GPU has its own memory", () => {
    const texels = 1000;
    expect(spectrogramBytes([whole(texels)], false)).toBe(
      (GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels + displayBytes(texels),
    );
  });

  it("measures a file a window will serve against the RAM the analysis holds, not the graphics budget", () => {
    // Far past what the graphics budget would allow the whole file.
    const gpuLimit = (GPU_MEMORY * GPU_BUDGET_SHARE) / (GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE);
    expect(remainingCoefficientBudget([])).toBe(analysisPeakTexels());
    expect(analysisPeakTexels()).toBeGreaterThan(gpuLimit);
  });

  it("takes the flat cost of the chunked passes off before it counts coefficients", () => {
    const w = window as unknown as Record<string, unknown>;
    const at = (gib: number): number => {
      w.nodeOs = { homedir: () => "/home", totalmem: () => gib * 1024 ** 3 };
      return analysisPeakTexels();
    };
    // Twice the memory allows more than twice the coefficients, because the
    // passes hold the same chunk however long the file is.
    const small = at(8);
    expect(at(16)).toBeGreaterThan(2 * small);
    // A machine whose share does not cover that chunk allows nothing.
    expect(at(1)).toBe(0);
    at(TOTAL_MEMORY / 1024 ** 3);
  });

  it("takes the caches out of the budget a new file too big for a window is measured against", () => {
    // Enough open that what is left cannot hold a window.
    const open = 5_600_000;
    const files = [whole(open), whole(open), whole(open)];
    const perTexel = GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE;
    const budget =
      GPU_MEMORY * GPU_BUDGET_SHARE -
      overhead() -
      files.length * (perTexel * open + displayBytes(open)) -
      DISPLAY_PYRAMID_MAX_TEXELS * DISPLAY_PYRAMID_BYTES_PER_TEXEL -
      displayTilesBytes();
    expect(budget).toBeLessThan(canvasWindowBudgetBytes());
    // The open files already pay for a scratch pool this large.
    expect(remainingCoefficientBudget(files)).toBe(
      Math.floor((budget - GPU_BYTES_PER_TEXEL_SCRATCH * open) / perTexel),
    );
  });

  it("charges a windowed file its window, not its length", () => {
    const block = 100_000;
    const canvas = 8 * block;
    const capped = DISPLAY_PYRAMID_MAX_TEXELS * 2;
    expect(spectrogramBytes([{ file: capped * 100, canvas, block }], true)).toBe(
      spectrogramBytes([{ file: capped, canvas, block }], true),
    );
  });

  it("charges a windowed file for its block slots instead of the CPU copies", () => {
    const block = 100_000;
    const canvas = 8 * block;
    const windowed = spectrogramBytes([{ file: canvas, canvas, block }], true);
    // Three windows of slots plus the spare each window keeps, at 16 bytes a
    // texel, in place of the packed and inverse-map arrays.
    const slots = 16 * (3 * canvas + 8 * block);
    expect(windowed - spectrogramBytes([whole(canvas)], true)).toBe(slots - CPU_BYTES_PER_TEXEL_FILE * canvas);
  });

  it("charges each open file's display pyramid", () => {
    const texels = 1000;
    const withDisplay = spectrogramBytes([whole(texels)], true);
    const withoutDisplay = withDisplay - displayBytes(texels);
    expect(pyramidBytes(texels)).toBeGreaterThan(0);
    expect(spectrogramBytes([whole(texels), whole(texels)], true) - withDisplay).toBe(
      (GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE) * texels + displayBytes(texels),
    );
    expect(withoutDisplay).toBeLessThan(withDisplay);
  });

  it("charges each open file the same for its tile ring, whatever its length", () => {
    const short = 1000;
    const long = short * 10_000;
    expect(displayTilesBytes()).toBeGreaterThan(0);
    expect(displayBytes(long) - pyramidBytes(long)).toBe(displayBytes(short) - pyramidBytes(short));
  });

  it("stops charging a longer file more once its pyramid hits the cap", () => {
    const capped = DISPLAY_PYRAMID_MAX_TEXELS;
    expect(pyramidBytes(capped)).toBe(capped * DISPLAY_PYRAMID_BYTES_PER_TEXEL);
    expect(pyramidBytes(capped * 100)).toBe(pyramidBytes(capped));
  });

  it("reports the open files' share of the budget, caches included", () => {
    const texels = 1000;
    expect(usedBudgetFraction([whole(texels)])).toBe(
      spectrogramBytes([whole(texels)], true) / (GPU_MEMORY * GPU_BUDGET_SHARE),
    );
  });
});

describe("the window the budget sets", () => {
  const GPU_MEMORY = 4 * 1024 ** 3;
  const SAMPLE_RATE = 48000;

  beforeAll(() => {
    const w = window as unknown as Record<string, unknown>;
    w.nodeOs = { homedir: () => "/home", totalmem: () => 8 * 1024 ** 3 };
    w.audioAnalysis = { getGpuMemoryInfo: () => ({ bytes: GPU_MEMORY, unified: true }) };
  });

  /**
   * A dyadic band layout of the density a real analysis produces: about four
   * packed texels for every input sample.
   */
  function gridOf(seconds: number, blockSeconds = 2): BlockGrid {
    const numBands = 20;
    const numFrames = Math.round(seconds * SAMPLE_RATE);
    const metadata = new Float64Array(numBands * 4);
    let offset = 0;
    for (let band = 0; band < numBands; band++) {
      const step = Math.min(9, Math.floor(band / 2));
      const length = Math.ceil(numFrames / 2 ** step);
      metadata[band * 4] = offset;
      metadata[band * 4 + 1] = length;
      metadata[band * 4 + 2] = step;
      metadata[band * 4 + 3] = 20 * 2 ** (band / 4);
      offset += length;
    }
    return blockGrid({ numBands, metadata }, numFrames, SAMPLE_RATE, blockSeconds);
  }

  it("keeps the whole file on the canvas while it fits the budget", () => {
    // Longer than the smallest window, so only the budget can decide it.
    const grid = gridOf(22);
    expect(grid.blockCount).toBeGreaterThan(4);
    expect(canvasWindowBlocks(grid)).toBe(Infinity);
  });

  it.each([2, 3])("gives a file too long for the budget the widest window that fits (%s s blocks)", (blockSeconds) => {
    const grid = gridOf(600, blockSeconds);
    const blocks = canvasWindowBlocks(grid);
    const texels = blockTexels(grid, 0);
    expect(blocks).toBeLessThan(grid.blockCount);
    expect(canvasWindowBytes(blocks, texels)).toBeLessThanOrEqual(canvasWindowBudgetBytes());
    expect(canvasWindowBytes(blocks + 1, texels)).toBeGreaterThan(canvasWindowBudgetBytes());
  });

  it("keeps extra block slots out of what the window's share has left", () => {
    const grid = gridOf(600);
    const blocks = canvasWindowBlocks(grid);
    const texels = blockTexels(grid, 0);
    const extra = canvasExtraSlotBlocks(grid, blocks);
    const slotBytes = PACKED_BYTES_PER_TEXEL * texels;
    expect(extra).toBeGreaterThan(0);
    expect(canvasWindowBytes(blocks, texels) + extra * slotBytes).toBeLessThanOrEqual(canvasWindowBudgetBytes());
    expect(canvasWindowBytes(blocks, texels) + (extra + 1) * slotBytes).toBeGreaterThan(canvasWindowBudgetBytes());
  });

  it("keeps no more extra slots than the file has blocks for", () => {
    // A window pinned small leaves most of the share to slots, more than the file needs.
    const grid = gridOf(60);
    const extra = canvasExtraSlotBlocks(grid, 4);
    expect(extra).toBe(grid.blockCount - 2 * 4 - CANVAS_WINDOW_SPARE_BLOCKS);
    expect(canvasExtraSlotBlocks(grid, Infinity)).toBe(0);
  });

  it("gives a longer file the same window", () => {
    expect(canvasWindowBlocks(gridOf(1200))).toBe(canvasWindowBlocks(gridOf(600)));
  });

  it("charges a window for the slots the two block windows really claim", () => {
    const gl = new WebGLRenderer();
    // Many more blocks than the two windows claim slots for, so nothing clamps.
    const grid = gridOf(20, 0.25);
    const blocks = 3;
    const texels = blockTexels(grid, 0);
    const read = async (): Promise<Float32Array | null> => null;
    const canvas = new CanvasWindow(gl, grid, { windowBlocks: blocks, read });
    const original = new PackedWindow(gl, grid, { windowBlocks: blocks, read });
    try {
      // Everything the charge holds that is not a slot: the canvas pair, the
      // view's inverse map, the original's composed texture and the scratch.
      const perTexel = 2 * 16 + 8 + 16 + GPU_BYTES_PER_TEXEL_SCRATCH;
      const slotBytes = canvasWindowBytes(blocks, texels) - perTexel * blocks * texels;
      expect(slotBytes / (PACKED_BYTES_PER_TEXEL * texels)).toBe(canvas.slotCount + original.slotCount);
    } finally {
      canvas.dispose();
      original.dispose();
      gl.dispose();
    }
  });
});
