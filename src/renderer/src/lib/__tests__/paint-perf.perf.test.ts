import { Vector2, WebGLRenderer } from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createGL,
  createHarnessTextures,
  createSourceFile,
  createStateForEffects,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
  type HarnessTextures,
} from "../../test/render-harness";
import type { EffectType } from "../../effects/types";
import type { SpectrogramData, State } from "../../store/types";
import { StrokeRenderer, type EffectsRegistry, type SourceFileInfo, type StrokeParams } from "../stroke-renderer";

// Loaded dynamically in beforeAll to avoid the store<->effects circular import
// that the other WebGL suites also work around.
let effects: EffectsRegistry;

/**
 * Painting performance suite. Drives the real production effect shaders through
 * a real WebGL StrokeRenderer (headless Chromium + ANGLE) and reports the
 * per-stroke cost that the user feels while dragging a brush.
 *
 * Timing method: each measured stroke is one full `renderStroke` (the entire
 * FBO ping-pong effect chain, committed). Because GL command submission is
 * async, we issue N strokes and then force a synchronous GPU stall via a 1px
 * readback of the committed FBO; wall-clock across (N strokes + 1 stall),
 * divided by N, gives true GPU+CPU ms/stroke with the readback overhead diluted
 * across N. We report the median across several trials.
 *
 * These are measurements, not pass/fail gates — absolute ms varies by machine.
 * The only assertions encode machine-independent invariants (finite/positive,
 * and that cost scales with texture size — the GPU-fill-bound hypothesis).
 *
 * Opt-in: `npm run test:perf` (excluded from the default `test:run`).
 */

interface SizeSpec {
  label: string;
  numFrames: number;
  numBands: number;
}

// numFrames/numBands chosen so the packed texture (≈sqrt(frames*bands)) lands
// near the labelled square FBO size. The approximate file length assumes a
// constant-Q analysis at ~24 bands/oct; real 1-2 minute files (which users do
// load) land at the top of this range, where the per-stroke full-texture pass
// dominates. Every FBO is RGBA32F (16 bytes/px), and the renderer allocates ~5
// of them, so memory ≈ 80·(Mpx) MB — keep the ceiling sane for headless.
const SCALING_SIZES: SizeSpec[] = [
  { label: "1024² (~15s)", numFrames: 2048, numBands: 512 },
  { label: "2048² (~45s)", numFrames: 8192, numBands: 512 },
  { label: "2896² (~90s)", numFrames: 16384, numBands: 512 },
];

// Per-effect kernel comparison runs at a mid size for speed; the relative cost
// between kernels is size-independent.
const EFFECT_SIZE: SizeSpec = { label: "1024²", numFrames: 2048, numBands: 512 };

const WARMUP = 5;
const ITERS = 20;
const TRIALS = 3;

// Brush coverage controls how many fragments run the heavy effect kernel (the
// in-shader early-out skips kernel work outside the brush envelope). "small" is
// a realistic localized brush; "full" forces the kernel across the whole
// texture to expose true per-kernel cost. Coverage is set via totalDuration
// (time/width footprint) and brushSizePitch (pitch/height footprint).
type Coverage = "small" | "full";
// Brush footprint stamped onto the step. totalDuration is fixed at 4s so 1 beat
// @120bpm = 0.5s; brushSizeTime in beats then sets the width fraction directly
// (small: 0.5 beat ≈ 12% width; full: 100 beats clamps past full width).
const COVERAGE_DURATION = 4;
function coverageBrush(c: Coverage): { brushSizeTime: number; brushSizePitch: number } {
  return c === "small" ? { brushSizeTime: 0.5, brushSizePitch: 12 } : { brushSizeTime: 100, brushSizePitch: 100000 };
}

// A small moving path so each measured stroke is at a distinct in-bounds
// position, like a real drag rather than a repeated stamp.
function strokePath(n: number): Vector2[] {
  const path: Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    path.push(new Vector2(0.4 + 0.2 * t, 0.5));
  }
  return path;
}
const PATH = strokePath(ITERS);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Synchronous GPU stall: reading the committed FBO blocks until the GPU drains. */
function syncGpu(gl: WebGLRenderer, renderer: StrokeRenderer, scratch: Float32Array): void {
  const target = renderer.getTextures().packed;
  gl.readRenderTargetPixels(target, 0, 0, 1, 1, scratch);
}

interface Harness {
  gl: WebGLRenderer;
  spectrogramData: SpectrogramData;
  textures: HarnessTextures;
  scratch: Float32Array;
}

function makeHarness(size: SizeSpec): Harness {
  const spectrogramData = createMockSpectrogramData({
    numFrames: size.numFrames,
    numBands: size.numBands,
    pattern: "gradient",
  });
  const textures = createHarnessTextures(spectrogramData);
  const gl = createGL(256, 256);
  return { gl, spectrogramData, textures, scratch: new Float32Array(4) };
}

function disposeHarness(h: Harness): void {
  disposeHarnessTextures(h.textures);
  h.gl.dispose();
}

/** Median ms per stroke for a configured renderer + state, over a moving path. */
function measure(h: Harness, state: State, paramOverrides: Partial<StrokeParams> = {}): number {
  const renderer = new StrokeRenderer(h.gl, h.spectrogramData, toStrokeTextures(h.textures), "perf", effects);
  renderer.initialize();
  const sourceFile: SourceFileInfo = createSourceFile(renderer, h.spectrogramData);
  const params = PATH.map((p) => makeStrokeParams(p, h.spectrogramData, paramOverrides));

  try {
    for (let i = 0; i < WARMUP; i++) renderer.renderStroke(params[i % params.length], state, sourceFile);
    syncGpu(h.gl, renderer, h.scratch);

    const perTrial: number[] = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) renderer.renderStroke(params[i], state, sourceFile);
      syncGpu(h.gl, renderer, h.scratch);
      const t1 = performance.now();
      perTrial.push((t1 - t0) / ITERS);
    }
    return median(perTrial);
  } finally {
    renderer.dispose();
  }
}

interface Row {
  scenario: string;
  size: string;
  msPerStroke: number;
}

function formatTable(title: string, rows: Row[]): string {
  const scenW = Math.max(8, ...rows.map((r) => r.scenario.length));
  const sizeW = Math.max(6, ...rows.map((r) => r.size.length));
  const head = `${"scenario".padEnd(scenW)}  ${"size".padEnd(sizeW)}  ms/stroke`;
  const body = rows
    .map((r) => `${r.scenario.padEnd(scenW)}  ${r.size.padEnd(sizeW)}  ${r.msPerStroke.toFixed(3)}`)
    .join("\n");
  return `\n=== ${title} ===\n${head}\n${"-".repeat(head.length)}\n${body}\n`;
}

describe("painting performance", () => {
  const collected: Row[] = [];

  beforeAll(async () => {
    effects = (await import("../../effects")).effects as EffectsRegistry;
  });

  afterAll(() => {
    // Single consolidated dump so results are easy to read/copy from CI output.
    // Grouped by leading scenario token for skimmability.
    console.log(formatTable("paint perf — ms per committed stroke", collected));
  });

  // The effects most likely to dominate per the GPU-fill analysis, plus a
  // passthrough baseline (one full ping-pong pass with no kernel work).
  const EFFECTS: { label: string; keys: EffectType[] }[] = [
    { label: "passthrough", keys: ["passthrough"] },
    { label: "dynamics", keys: ["dynamics"] },
    { label: "transform", keys: ["transform"] },
    { label: "blur", keys: ["blur"] },
    { label: "overtones", keys: ["overtones"] },
    { label: "waveshape", keys: ["waveshape"] },
    { label: "transmute", keys: ["transmute"] },
    { label: "evolve", keys: ["evolve"] },
    { label: "sort", keys: ["sort"] },
    { label: "convolve", keys: ["convolve"] },
    { label: "chain:transform+dynamics+blur", keys: ["transform", "dynamics", "blur"] },
  ];

  // 1) Per-effect cost at a single representative size, at both a realistic
  // localized brush and full-texture coverage. The gap between the two columns
  // is the true per-kernel cost; at "small" coverage the early-out makes most
  // effects collapse toward the passthrough baseline.
  describe("per-effect cost @ 1024²", () => {
    const size = EFFECT_SIZE;
    for (const { label, keys } of EFFECTS) {
      for (const coverage of ["small", "full"] as Coverage[]) {
        it(`${label} [${coverage}]`, () => {
          const h = makeHarness(size);
          try {
            const cov = coverageBrush(coverage);
            const state = createStateForEffects(keys, {
              brushSizeTime: cov.brushSizeTime,
              brushSizePitch: cov.brushSizePitch,
            });
            const ms = measure(h, state, { totalDuration: COVERAGE_DURATION });
            collected.push({ scenario: `${label} [${coverage}]`, size: size.label, msPerStroke: ms });
            expect(Number.isFinite(ms)).toBe(true);
            expect(ms).toBeGreaterThan(0);
          } finally {
            disposeHarness(h);
          }
        });
      }
    }
  });

  // 2) Texture-size scaling across realistic file lengths (up to ~90s), for a
  // small localized brush AND a full-texture brush. This is the key result for
  // long files: if a small brush's cost still rises steeply with file size,
  // the per-stroke work is dominated by the full-texture pass rather than the
  // brush region — i.e. dirty-region culling is the lever. If painting is
  // GPU-fill-bound, cost rises with pixel count; the assertion guards that
  // hypothesis (if it ever fails, painting became CPU/dispatch-bound).
  describe("file-size scaling (blur)", () => {
    const perSize: Record<string, number> = {};
    for (const coverage of ["small", "full"] as Coverage[]) {
      for (const size of SCALING_SIZES) {
        it(`blur [${coverage}] @ ${size.label}`, () => {
          const h = makeHarness(size);
          try {
            const cov = coverageBrush(coverage);
            const state = createStateForEffects(["blur"], {
              brushSizeTime: cov.brushSizeTime,
              brushSizePitch: cov.brushSizePitch,
            });
            const ms = measure(h, state, { totalDuration: COVERAGE_DURATION });
            perSize[`${coverage}:${size.label}`] = ms;
            collected.push({ scenario: `scaling:blur [${coverage}]`, size: size.label, msPerStroke: ms });
            expect(ms).toBeGreaterThan(0);
          } finally {
            disposeHarness(h);
          }
        });
      }
    }
    it("cost grows with file size (GPU-fill-bound)", () => {
      const small = perSize[`full:${SCALING_SIZES[0].label}`];
      const large = perSize[`full:${SCALING_SIZES[SCALING_SIZES.length - 1].label}`];
      expect(large).toBeGreaterThan(small * 1.2);
    });
  });
});
