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
 * getFBOData() caches the packed state it reads back and serves the cache until
 * something repaints. The readback resolves a turn later, so a stroke can land
 * between the read being issued and it returning — and that stroke is not in
 * the array the read produces. Caching it anyway would hand the next caller
 * (the commit, synthesis, a duplicate) a canvas missing the newest paint.
 */

let effects: EffectsRegistry;

beforeAll(async () => {
  effects = (await import("../../effects")).effects as EffectsRegistry;
});

describe("FBO readback racing a stroke", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: HarnessTextures;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(256, 256);
    spectrogramData = createMockSpectrogramData({ numFrames: 1024, numBands: 256, pattern: "gradient" });
    textures = createHarnessTextures(spectrogramData);
  });

  afterEach(() => {
    disposeHarnessTextures(textures);
    gl.dispose();
  });

  it("re-reads rather than serving a snapshot taken before a stroke that landed mid-read", async () => {
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "race", effects);
    renderer.calculateScissorRows = () => null;
    renderer.initialize();

    try {
      const sourceFile = createSourceFile(renderer, spectrogramData);
      const state = createStateForEffects(["blur"], { brushSizeTime: 0.5, brushSizePitch: 12 });
      const paint = (x: number) =>
        renderer.renderStroke(
          makeStrokeParams(new Vector2(x, 0.5), spectrogramData, { totalDuration: 4 }),
          state,
          sourceFile,
        );

      const pristine = await renderer.getFBOData();
      const pristineCopy = Float32Array.from(pristine);

      paint(0.3);
      // Issued now, so it snapshots the canvas as it stands with only this
      // stroke on it; the second stroke below runs before it resolves.
      const pendingRead = renderer.getFBOData();
      paint(0.7);
      const duringRead = await pendingRead;

      expect(Array.from(duringRead)).not.toEqual(Array.from(pristineCopy));

      const afterRead = await renderer.getFBOData();
      expect(afterRead).not.toBe(duringRead);
      expect(Array.from(afterRead)).not.toEqual(Array.from(duringRead));
    } finally {
      renderer.dispose();
    }
  });

  it("still serves the cache when nothing repainted during the read", async () => {
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "cache", effects);
    renderer.calculateScissorRows = () => null;
    renderer.initialize();

    try {
      const sourceFile = createSourceFile(renderer, spectrogramData);
      const state = createStateForEffects(["blur"], { brushSizeTime: 0.5, brushSizePitch: 12 });
      renderer.renderStroke(
        makeStrokeParams(new Vector2(0.4, 0.5), spectrogramData, { totalDuration: 4 }),
        state,
        sourceFile,
      );

      const first = await renderer.getFBOData();
      const second = await renderer.getFBOData();
      expect(second).toBe(first);
    } finally {
      renderer.dispose();
    }
  });
});
