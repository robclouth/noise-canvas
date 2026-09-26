import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The renderer pulls in the store, and the store the effects registry, so it
// is imported ahead of the effects to settle the module graph first.
import { StrokeRenderer } from "../stroke-renderer";
import { neuralEffect, neuralGenerationCount } from "../../effects/neural-effect";
import { NEURAL_MAX_GENERATIONS, neuralWeights } from "../../effects/neural-weights";
import { passThroughEffect } from "../../effects/passthrough-effect";
import { SpectrogramData, State } from "../../store/types";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createGL,
  createHarnessTextures,
  createSourceFile,
  createStateForEffects,
  disposeHarnessTextures,
  HarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
} from "../../test/render-harness";

/** A step running one Neural effect with these params over the whole file. */
function neuralState(params: Record<string, number>): State {
  const state = createStateForEffects(["neural"], { brushSizeTime: 64, brushSizePitch: 96 });
  const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
  step.effects = [{ id: "neural-under-test", effect: "neural", enabled: true, params }];
  return state;
}

describe("Neural weights", () => {
  it("grows the same network from the same seed", () => {
    const a = neuralWeights(42);
    const b = neuralWeights(42);
    expect(Array.from(a.w1)).toEqual(Array.from(b.w1));
    expect(Array.from(a.w2)).toEqual(Array.from(b.w2));
  });

  it("grows a different network from each seed", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 50; seed++) seen.add(Array.from(neuralWeights(seed).w1.slice(0, 4)).join(","));
    expect(seen.size).toBe(50);
  });

  it("keeps every weight finite", () => {
    for (let seed = 0; seed < 200; seed++) {
      const { w1, b1, w2 } = neuralWeights(seed);
      for (const w of [...w1, ...b1, ...w2]) expect(Number.isFinite(w)).toBe(true);
    }
  });
});

describe("Neural generations", () => {
  it("renders one pass per generation, inside the compiled passes", () => {
    for (const generations of [1, 4, 16, 40, 0]) {
      const state = { ...neuralState({}), neuralGenerations: generations } as State;
      const passes = neuralEffect.getActivePasses(state);
      expect(passes.length).toBe(neuralGenerationCount(state));
      expect(passes.length).toBeGreaterThanOrEqual(1);
      expect(passes.length).toBeLessThanOrEqual(NEURAL_MAX_GENERATIONS);
      expect(Math.max(...passes)).toBeLessThan(neuralEffect.materials.length);
    }
  });
});

describe("Neural effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: HarnessTextures;

  beforeEach(() => {
    gl = createGL(64, 64);
    spectrogramData = createMockSpectrogramData({ numFrames: 64, numBands: 32, sampleRate: 1000, pattern: "sine" });
    textures = createHarnessTextures(spectrogramData);
  });

  afterEach(() => {
    gl.dispose();
    disposeHarnessTextures(textures);
  });

  async function paint(params: Record<string, number>): Promise<{ before: Float32Array; after: Float32Array }> {
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "neural-test", {
      neural: neuralEffect,
      passthrough: passThroughEffect,
    });
    renderer.initialize();
    const sourceFile = createSourceFile(renderer, spectrogramData);
    const before = (await renderer.getFBOData()).slice();
    renderer.renderStroke(makeStrokeParams(new Vector2(0.5, 0.5), spectrogramData), neuralState(params), sourceFile);
    const after = (await renderer.getFBOData()).slice();
    renderer.dispose();
    return { before, after };
  }

  /** Mean absolute change in level, in dB, over bands that are audible either side. */
  function meanLevelChangeDb(before: Float32Array, after: Float32Array): number {
    let total = 0;
    let count = 0;
    for (let i = 0; i < before.length; i += 4) {
      for (const c of [0, 2]) {
        const a = Math.max(before[i + c], 1e-6);
        const b = Math.max(after[i + c], 1e-6);
        if (a <= 1e-5 && b <= 1e-5) continue;
        total += Math.abs(20 * Math.log10(b / a));
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  }

  function allFinite(data: Float32Array): boolean {
    return data.every((v) => Number.isFinite(v));
  }

  it("leaves the sound alone at zero Rate and zero Twist", async () => {
    const { before, after } = await paint({ neuralRate: 0, neuralTwist: 0, neuralGenerations: 4 });
    expect(meanLevelChangeDb(before, after)).toBeLessThan(0.01);
  });

  it("changes the sound once Rate is up", async () => {
    const { before, after } = await paint({ neuralRate: 60, neuralSeed: 7, neuralGenerations: 4 });
    expect(allFinite(after)).toBe(true);
    expect(meanLevelChangeDb(before, after)).toBeGreaterThan(0.1);
  });

  it("sounds the same every time for one seed, and different across seeds", async () => {
    const first = await paint({ neuralRate: 60, neuralSeed: 3, neuralGenerations: 2 });
    const again = await paint({ neuralRate: 60, neuralSeed: 3, neuralGenerations: 2 });
    const other = await paint({ neuralRate: 60, neuralSeed: 4, neuralGenerations: 2 });
    expect(meanLevelChangeDb(first.after, again.after)).toBeLessThan(1e-3);
    expect(meanLevelChangeDb(first.after, other.after)).toBeGreaterThan(0.05);
  });

  it("stays finite at the extremes", async () => {
    const { after } = await paint({
      neuralRate: 100,
      neuralChaos: 100,
      neuralTwist: 100,
      neuralGenerations: NEURAL_MAX_GENERATIONS,
    });
    expect(allFinite(after)).toBe(true);
  });
});
