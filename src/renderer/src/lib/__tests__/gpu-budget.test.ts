import { FloatType, HalfFloatType, RedFormat, RGFormat, RGBAFormat, UnsignedByteType } from "three";
import type { WebGLRenderTarget } from "three";
import { describe, expect, it } from "vitest";
import { GPU_BYTES_PER_TEXEL_FILE, GPU_BYTES_PER_TEXEL_SCRATCH, spectrogramBytes } from "../gpu-budget";
import { StrokeScratchPool } from "../stroke-scratch-pool";

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

function bytesPerTexel(target: WebGLRenderTarget): number {
  return target.textures.reduce((sum, texture) => {
    const channels = CHANNELS[texture.format];
    const bytes = BYTES[texture.type];
    expect(channels, `unhandled texture format ${texture.format}`).toBeDefined();
    expect(bytes, `unhandled texture type ${texture.type}`).toBeDefined();
    return sum + channels * bytes;
  }, 0);
}

describe("GPU budget rates", () => {
  it("charges scratch at what the pool really allocates", () => {
    const pool = new StrokeScratchPool();
    const owner = {};
    try {
      const { scratch } = pool.acquire(owner, 32, 16);
      const allocated = Object.values(scratch).reduce((sum, target) => sum + bytesPerTexel(target), 0);
      expect(GPU_BYTES_PER_TEXEL_SCRATCH).toBe(allocated);
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
