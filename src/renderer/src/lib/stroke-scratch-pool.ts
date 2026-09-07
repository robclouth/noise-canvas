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
 *
 * The pass buffers and the modulator MRT are allocated on first use: a brush of
 * one step, one effect and one iteration reaches the destination in a single
 * pass and touches neither, which is the default brush and every brush Reduced
 * Mode allows.
 */
export interface StrokeScratch {
  passFbo1: WebGLRenderTarget | null;
  passFbo2: WebGLRenderTarget | null;
  // One mask target per brush step, created when that step first needs one. A
  // step's mask holds the strongest weight the step reached at each pixel, so
  // steps with different envelopes cannot raise each other's weight.
  strokeMaskFbos: (WebGLRenderTarget | null)[];
  strokeStartFbo: WebGLRenderTarget;
  // Two half-float targets (MRT) holding the precomputed per-pixel modulator
  // outputs for the current step. tex[0] = (mod0.xy, mod1.xy); tex[1] = mod2.xy.
  modulatorFbo: WebGLRenderTarget | null;
}

// A packed magnitude/phase target is RGBA32F: (magL, phaseL, magR, phaseR).
// It must stay float32, because the phase channel carries large accumulated
// values. A mono file leaves the second pair unused and still pays for it,
// matching the canonical FBOs it is copied from.
const PACKED_BYTES_PER_TEXEL = 16;
// The masks hold weights in [0, 1] and the modulator targets bounded modulator
// outputs, so half precision is enough for both.
const MASK_BYTES_PER_TEXEL = 2;
const MODULATOR_BYTES_PER_TEXEL = 2 * 8;

function createTarget(
  width: number,
  height: number,
  format: typeof RGBAFormat | typeof RedFormat,
  type: typeof FloatType | typeof HalfFloatType,
): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    format,
    type,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function createTargets(width: number, height: number): StrokeScratch {
  return {
    passFbo1: null,
    passFbo2: null,
    strokeMaskFbos: [],
    strokeStartFbo: createTarget(width, height, RGBAFormat, FloatType),
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
  const targets = [t.strokeStartFbo];
  for (const mask of t.strokeMaskFbos) {
    if (mask) targets.push(mask);
  }
  if (t.passFbo1) targets.push(t.passFbo1);
  if (t.passFbo2) targets.push(t.passFbo2);
  if (t.modulatorFbo) targets.push(t.modulatorFbo);
  return targets;
}

/**
 * Shared pool of stroke scratch targets, one set per WebGL renderer. A
 * StrokeRenderer acquires the set before painting; when a different renderer
 * painted last (or the texture size changed), `refreshed` tells the caller to
 * rebuild ownership-dependent content — the stroke-start snapshot and the mask
 * clears — before using it.
 */
export class StrokeScratchPool {
  private targets: StrokeScratch | null = null;
  private owner: unknown = null;
  private width = 0;
  private height = 0;

  acquire(
    owner: unknown,
    width: number,
    height: number,
  ): { scratch: StrokeScratch; refreshed: boolean; allocated: boolean } {
    const sizeChanged = width !== this.width || height !== this.height;
    const allocated = !this.targets || sizeChanged;
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
    return { scratch: this.targets, refreshed, allocated };
  }

  /**
   * The first `count` pass buffers at the pool's current size, created on first
   * call. A stroke that reaches its destination in one pass asks for none.
   */
  passFbos(count: number): WebGLRenderTarget[] {
    if (!this.targets) throw new Error("Scratch targets are acquired before the pass buffers are used.");
    const targets = this.targets;
    const make = (): WebGLRenderTarget => createTarget(this.width, this.height, RGBAFormat, FloatType);
    if (count >= 1) targets.passFbo1 ??= make();
    if (count >= 2) targets.passFbo2 ??= make();
    return [targets.passFbo1, targets.passFbo2].filter((t): t is WebGLRenderTarget => t !== null).slice(0, count);
  }

  /**
   * A step's mask target at the pool's current size, created on first call.
   * `created` is true on that first call, when the target still holds whatever
   * the driver left behind and the caller has to clear it.
   */
  maskFbo(stepIndex: number): { fbo: WebGLRenderTarget; created: boolean } {
    if (!this.targets) throw new Error("Scratch targets are acquired before the stroke masks are used.");
    const masks = this.targets.strokeMaskFbos;
    const existing = masks[stepIndex];
    if (existing) return { fbo: existing, created: false };
    const fbo = createTarget(this.width, this.height, RedFormat, HalfFloatType);
    while (masks.length < stepIndex) masks.push(null);
    masks[stepIndex] = fbo;
    return { fbo, created: true };
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
    let perTexel = PACKED_BYTES_PER_TEXEL;
    for (const mask of this.targets.strokeMaskFbos) {
      if (mask) perTexel += MASK_BYTES_PER_TEXEL;
    }
    if (this.targets.passFbo1) perTexel += PACKED_BYTES_PER_TEXEL;
    if (this.targets.passFbo2) perTexel += PACKED_BYTES_PER_TEXEL;
    if (this.targets.modulatorFbo) perTexel += MODULATOR_BYTES_PER_TEXEL;
    return texels * perTexel;
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
