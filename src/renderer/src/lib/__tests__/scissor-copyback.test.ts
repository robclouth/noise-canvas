import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createHarnessTextures,
  createSourceFile,
  createStateForEffects,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
  type HarnessTextures,
} from "../../test/render-harness";
import type { SpectrogramData } from "../../store/types";
import { StrokeRenderer, type EffectsRegistry } from "../stroke-renderer";

/**
 * Equivalence guard for the committed-stroke scissor copy-back optimization.
 *
 * The optimization renders only the brush's rows into destinationFbo and folds
 * them back into the canonical buffer, instead of full-texture-blitting then
 * ping-pong-swapping. It must be behaviour-preserving: for any committed stroke
 * the resulting spectrogram must be byte-identical to the legacy path. We assert
 * that by running the same stroke through both paths (the legacy one forced via
 * `disableScissorCopyBack`) and comparing the full FBO read-back.
 */

let effects: EffectsRegistry;

beforeAll(async () => {
  effects = (await import("../../effects")).effects as EffectsRegistry;
});

describe("scissor copy-back equivalence", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: HarnessTextures;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(256, 256);
    // Large enough (256 bands) that a localized brush scissors to a small row
    // band rather than tripping the ">=80% of bands" full-texture fallback.
    spectrogramData = createMockSpectrogramData({ numFrames: 1024, numBands: 256, pattern: "gradient" });
    textures = createHarnessTextures(spectrogramData);
  });

  afterEach(() => {
    disposeHarnessTextures(textures);
    gl.dispose();
  });

  function makeRenderer(legacy: boolean): StrokeRenderer {
    const r = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "copyback", effects);
    r.disableScissorCopyBack = legacy;
    r.initialize();
    return r;
  }

  // A small brush at a few positions, forcing the scissored committed path.
  async function paintAndRead(legacy: boolean): Promise<Float32Array> {
    const r = makeRenderer(legacy);
    try {
      const sourceFile = createSourceFile(r, spectrogramData);
      const state = createStateForEffects(["blur"], { brushSizeTime: 0.5, brushSizePitch: 12 });
      const positions = [new Vector2(0.45, 0.5), new Vector2(0.5, 0.55), new Vector2(0.55, 0.5)];
      for (const p of positions) {
        r.renderStroke(makeStrokeParams(p, spectrogramData, { totalDuration: 4 }), state, sourceFile);
      }
      return await r.getFBOData();
    } finally {
      r.dispose();
    }
  }

  it("scissors a localized brush (precondition: not the full-texture fallback)", () => {
    const r = makeRenderer(false);
    try {
      // brushBottomLeftUv / sizeUv around the painted band; non-null means the
      // small-brush scissor path is actually exercised by this fixture.
      const rows = r.calculateScissorRows(new Vector2(0.45, 0.46), new Vector2(0.1, 0.08));
      expect(rows).not.toBeNull();
    } finally {
      r.dispose();
    }
  });

  it("copy-back output is byte-identical to the legacy full-blit path", async () => {
    const optimized = await paintAndRead(false);
    const legacy = await paintAndRead(true);

    expect(optimized.length).toBe(legacy.length);
    let maxDiff = 0;
    let firstDiffIndex = -1;
    for (let i = 0; i < optimized.length; i++) {
      const d = Math.abs(optimized[i] - legacy[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0 && firstDiffIndex === -1) firstDiffIndex = i;
    }
    // Same shader math on both paths → expect exact equality.
    expect(maxDiff, `first diff at index ${firstDiffIndex}`).toBe(0);
  });
});
