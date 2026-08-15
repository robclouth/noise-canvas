import { FloatType, NearestFilter, RedFormat, RGBAFormat, WebGLRenderer, WebGLRenderTarget } from "three";

/**
 * Scratch render targets used only while painting: effect pass ping-pong,
 * stroke masks, the stroke-start snapshot, and the modulator precompute MRT.
 * One set is shared by every open file's StrokeRenderer, which holds because
 * only one file is painted at a time.
 */
export interface StrokeScratch {
  passFbo1: WebGLRenderTarget;
  passFbo2: WebGLRenderTarget;
  strokeMaskFbo: WebGLRenderTarget;
  strokeMaskFbo2: WebGLRenderTarget;
  strokeStartFbo: WebGLRenderTarget;
  // Two float targets (MRT) holding the precomputed per-pixel modulator
  // outputs for the current step. tex[0] = (mod0.xy, mod1.xy); tex[1] = mod2.xy.
  modulatorFbo: WebGLRenderTarget;
}

function createTargets(width: number, height: number): StrokeScratch {
  const fbo = (format: typeof RGBAFormat | typeof RedFormat) =>
    new WebGLRenderTarget(width, height, {
      format,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
  return {
    passFbo1: fbo(RGBAFormat),
    passFbo2: fbo(RGBAFormat),
    strokeMaskFbo: fbo(RedFormat),
    strokeMaskFbo2: fbo(RedFormat),
    strokeStartFbo: fbo(RGBAFormat),
    modulatorFbo: new WebGLRenderTarget(width, height, {
      count: 2,
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    }),
  };
}

/**
 * Shared pool of stroke scratch targets, one set per WebGL renderer. A
 * StrokeRenderer acquires the set before painting; when a different renderer
 * painted last (or the texture size changed), `refreshed` tells the caller to
 * rebuild ownership-dependent content — the stroke-start snapshot and the
 * mask clears — before using it.
 */
export class StrokeScratchPool {
  private targets: StrokeScratch | null = null;
  private owner: unknown = null;
  private width = 0;
  private height = 0;

  acquire(owner: unknown, width: number, height: number): { scratch: StrokeScratch; refreshed: boolean } {
    const sizeChanged = width !== this.width || height !== this.height;
    if (!this.targets) {
      this.targets = createTargets(width, height);
    } else if (sizeChanged) {
      const t = this.targets;
      for (const target of [
        t.passFbo1,
        t.passFbo2,
        t.strokeMaskFbo,
        t.strokeMaskFbo2,
        t.strokeStartFbo,
        t.modulatorFbo,
      ]) {
        target.setSize(width, height);
      }
    }
    const refreshed = sizeChanged || owner !== this.owner;
    this.owner = owner;
    this.width = width;
    this.height = height;
    return { scratch: this.targets, refreshed };
  }

  /** True while `owner` was the last acquirer and the targets are still allocated. */
  ownedBy(owner: unknown): boolean {
    return this.owner === owner && this.targets !== null;
  }

  /** Drops ownership without freeing, so the next acquire refreshes the content. */
  disown(owner: unknown): void {
    if (this.owner === owner) this.owner = null;
  }

  /** Frees the GPU allocations when the owning renderer is disposed. */
  release(owner: unknown): void {
    if (this.owner !== owner) return;
    this.owner = null;
    if (this.targets) {
      const t = this.targets;
      for (const target of [
        t.passFbo1,
        t.passFbo2,
        t.strokeMaskFbo,
        t.strokeMaskFbo2,
        t.strokeStartFbo,
        t.modulatorFbo,
      ]) {
        target.dispose();
      }
      this.targets = null;
      this.width = 0;
      this.height = 0;
    }
  }
}

const pools = new WeakMap<WebGLRenderer, StrokeScratchPool>();

/** The scratch pool for a WebGL renderer, created on first use. */
export function getStrokeScratchPool(gl: WebGLRenderer): StrokeScratchPool {
  let pool = pools.get(gl);
  if (!pool) {
    pool = new StrokeScratchPool();
    pools.set(gl, pool);
  }
  return pool;
}
