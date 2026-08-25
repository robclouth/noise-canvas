import { FloatType, HalfFloatType, RedFormat, RGFormat, RGBAFormat, UnsignedByteType } from "three";
import type { WebGLRenderTarget } from "three";
import { describe, expect, it } from "vitest";
import { GPU_BYTES_PER_TEXEL_FILE, GPU_BYTES_PER_TEXEL_SCRATCH, spectrogramBytes } from "../gpu-budget";
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
    expect(one).toBe((GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH) * texels);
    expect(two - one).toBe(GPU_BYTES_PER_TEXEL_FILE * texels);
  });
});
