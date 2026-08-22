import {
  FloatType,
  HalfFloatType,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";

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
  // Two half-float targets (MRT) holding the precomputed per-pixel modulator
  // outputs for the current step. tex[0] = (mod0.xy, mod1.xy); tex[1] = mod2.xy.
  // Allocated by the pool's `modulatorFbo()` the first time a step routes a
  // modulator, since most brushes never do.
  modulatorFbo: WebGLRenderTarget | null;
}

// The pass and stroke-start targets carry phase, which must stay float32. The
// masks hold weights in [0, 1] and the modulator targets bounded modulator
// outputs, so half precision is enough for both.
const PASS_BYTES_PER_TEXEL = 16;
const MASK_BYTES_PER_TEXEL = 2;
const MODULATOR_BYTES_PER_TEXEL = 2 * 8;

function createTargets(width: number, height: number): StrokeScratch {
  const fbo = (format: typeof RGBAFormat | typeof RedFormat, type: typeof FloatType | typeof HalfFloatType) =>
    new WebGLRenderTarget(width, height, {
      format,
      type,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  return {
    passFbo1: fbo(RGBAFormat, FloatType),
    passFbo2: fbo(RGBAFormat, FloatType),
    strokeMaskFbo: fbo(RedFormat, HalfFloatType),
    strokeMaskFbo2: fbo(RedFormat, HalfFloatType),
    strokeStartFbo: fbo(RGBAFormat, FloatType),
    modulatorFbo: null,
  };
}

function createModulatorTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    count: 2,
    format: RGBAFormat,
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function allocatedTargets(t: StrokeScratch): WebGLRenderTarget[] {
  const targets = [t.passFbo1, t.passFbo2, t.strokeMaskFbo, t.strokeMaskFbo2, t.strokeStartFbo];
  if (t.modulatorFbo) targets.push(t.modulatorFbo);
  return targets;
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
      for (const target of allocatedTargets(this.targets)) {
        target.setSize(width, height);
      }
    }
    const refreshed = sizeChanged || owner !== this.owner;
    this.owner = owner;
    this.width = width;
    this.height = height;
    return { scratch: this.targets, refreshed };
  }

  /** The modulator MRT at the pool's current size, created on first call. */
  modulatorFbo(): WebGLRenderTarget {
    if (!this.targets) throw new Error("Scratch targets are acquired before the modulator target is used.");
    if (!this.targets.modulatorFbo) {
      this.targets.modulatorFbo = createModulatorTarget(this.width, this.height);
    }
    return this.targets.modulatorFbo;
  }

  /** True while `owner` was the last acquirer and the targets are still allocated. */
  ownedBy(owner: unknown): boolean {
    return this.owner === owner && this.targets !== null;
  }

  /** Texels each allocated target spans; 0 before the first acquire. */
  get allocatedTexels(): number {
    return this.targets ? this.width * this.height : 0;
  }

  /** GPU bytes the allocated targets hold. */
  get allocatedBytes(): number {
    if (!this.targets) return 0;
    const texels = this.width * this.height;
    const fixed = 3 * PASS_BYTES_PER_TEXEL + 2 * MASK_BYTES_PER_TEXEL;
    const modulator = this.targets.modulatorFbo ? MODULATOR_BYTES_PER_TEXEL : 0;
    return texels * (fixed + modulator);
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
      for (const target of allocatedTargets(this.targets)) {
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
