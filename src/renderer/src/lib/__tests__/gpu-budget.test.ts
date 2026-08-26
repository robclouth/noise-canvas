import { FloatType, HalfFloatType, RedFormat, RGFormat, RGBAFormat, UnsignedByteType } from "three";
import type { WebGLRenderTarget } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CPU_BYTES_PER_TEXEL_FILE,
  GPU_BYTES_PER_TEXEL_FILE,
  GPU_BYTES_PER_TEXEL_SCRATCH,
  historyCacheBytes,
  remainingCoefficientBudget,
  spectrogramBytes,
  usedBudgetFraction,
} from "../gpu-budget";
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
    const one = spectrogramBytes([texels], false);
    const two = spectrogramBytes([texels, texels], false);
    expect(one).toBe((GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels + displayBytes(texels));
    expect(two - one).toBe(GPU_BYTES_PER_TEXEL_FILE * texels + displayBytes(texels));
  });
});

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
    return budgets.deltas + budgets.audioHops;
  };

  it("sums the three history cache budgets", () => {
    expect(historyCacheBytes()).toBe(overhead());
  });

  it("charges the caches once, however many files are open", () => {
    const texels = 1000;
    const one = spectrogramBytes([texels], true);
    const two = spectrogramBytes([texels, texels], true);
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
    expect(spectrogramBytes([texels], false)).toBe(
      (GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels + displayBytes(texels),
    );
  });

  it("takes the caches out of the budget a new file is measured against", () => {
    const budget =
      GPU_MEMORY * GPU_BUDGET_SHARE -
      overhead() -
      DISPLAY_PYRAMID_MAX_TEXELS * DISPLAY_PYRAMID_BYTES_PER_TEXEL -
      displayTilesBytes();
    const perTexel = GPU_BYTES_PER_TEXEL_FILE + CPU_BYTES_PER_TEXEL_FILE;
    // With nothing open the new file grows the scratch pool with it.
    expect(remainingCoefficientBudget([])).toBe(Math.floor(budget / (perTexel + GPU_BYTES_PER_TEXEL_SCRATCH)));
  });

  it("charges each open file's display pyramid", () => {
    const texels = 1000;
    const withDisplay = spectrogramBytes([texels], true);
    const withoutDisplay = withDisplay - displayBytes(texels);
    expect(pyramidBytes(texels)).toBeGreaterThan(0);
    expect(spectrogramBytes([texels, texels], true) - withDisplay).toBe(
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
    expect(usedBudgetFraction([texels])).toBe(spectrogramBytes([texels], true) / (GPU_MEMORY * GPU_BUDGET_SHARE));
  });
});
