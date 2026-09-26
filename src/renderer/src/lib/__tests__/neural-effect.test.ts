import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The renderer pulls in the store, and the store the effects registry, so it
// is imported ahead of the effects to settle the module graph first.
import { StrokeRenderer } from "../stroke-renderer";
import { neuralEffect, neuralModelOf, neuralStepCount } from "../../effects/neural-effect";
import { passThroughEffect } from "../../effects/passthrough-effect";
import {
  dequantisePhase,
  initialWeights,
  levelOf,
  NCA_CHANNELS,
  NCA_GRID,
  NcaWeights,
  serializeModel,
} from "../nca/nca-model";
import { readAnchors } from "../nca/nca-grid";
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

/** A network that changes nothing: the first layer is live, the second silent. */
function stillWeights(): NcaWeights {
  return initialWeights(() => 0.5);
}

/** A network whose only effect is to raise every cell's level by `rise` each time it fires. */
function risingWeights(rise: number): NcaWeights {
  const weights = stillWeights();
  weights.b2 = new Float32Array(NCA_CHANNELS);
  weights.b2[0] = rise;
  return weights;
}

function modelText(weights: NcaWeights, phase: Uint8Array | null = null, ceiling: Uint8Array | null = null): string {
  return serializeModel({ weights, label: "test", loss: 0, iterations: 1, phase, roughness: null, ceiling });
}

/** A step running one Neural effect with these params over the whole file. */
function neuralState(params: Record<string, unknown>): State {
  const state = createStateForEffects(["neural"], { brushSizeTime: 64, brushSizePitch: 128 });
  const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
  step.effects = [{ id: "neural-under-test", effect: "neural", enabled: true, params }];
  return state;
}

describe("Neural effect settings", () => {
  it("runs no pass without a model", () => {
    expect(neuralEffect.getActivePasses({ ...neuralState({}), neuralModel: "" } as State)).toEqual([]);
    expect(neuralEffect.getActivePasses({ ...neuralState({}), neuralModel: "{" } as State)).toEqual([]);
    const withModel = { ...neuralState({}), neuralModel: modelText(stillWeights()) } as State;
    expect(neuralEffect.getActivePasses(withModel)).toEqual([0]);
    expect(neuralModelOf(withModel)?.label).toBe("test");
  });

  it("keeps the step count inside what one dab can run", () => {
    expect(neuralStepCount({ neuralSteps: 0 })).toBe(1);
    expect(neuralStepCount({ neuralSteps: 24 })).toBe(24);
    expect(neuralStepCount({ neuralSteps: 1000 })).toBe(64);
    expect(neuralStepCount({ neuralSteps: NaN })).toBe(1);
  });
});

describe("Neural effect", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: HarnessTextures;

  beforeEach(() => {
    gl = createGL(64, 64);
    spectrogramData = createMockSpectrogramData({
      numFrames: 96,
      numBands: 96,
      sampleRate: 1000,
      pattern: "constant",
      constantMagnitude: 0.01,
    });
    textures = createHarnessTextures(spectrogramData);
  });

  afterEach(() => {
    gl.dispose();
    disposeHarnessTextures(textures);
  });

  async function paint(params: Record<string, unknown>): Promise<{ before: Float32Array; after: Float32Array }> {
    const renderer = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "neural-test", {
      neural: neuralEffect,
      passthrough: passThroughEffect,
    });
    renderer.initialize();
    const sourceFile = createSourceFile(renderer, spectrogramData);
    const before = (await renderer.getFBOData()).slice();
    renderer.renderStroke(makeStrokeParams(new Vector2(0, 0), spectrogramData), neuralState(params), sourceFile);
    const after = (await renderer.getFBOData()).slice();
    renderer.dispose();
    return { before, after };
  }

  /** Median level change over the file, on the model's level scale. */
  function medianLevelChange(before: Float32Array, after: Float32Array): number {
    const changes: number[] = [];
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] <= 0) continue;
      changes.push(levelOf(after[i]) - levelOf(before[i]));
    }
    changes.sort((a, b) => a - b);
    return changes[Math.floor(changes.length / 2)];
  }

  it("leaves the sound alone without a model", async () => {
    const { before, after } = await paint({});
    let worst = 0;
    for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(after[i] - before[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it("writes back the sound it read when the model changes nothing", async () => {
    const { before, after } = await paint({ neuralModel: modelText(stillWeights()), neuralSteps: 4 });
    expect(Math.abs(medianLevelChange(before, after))).toBeLessThan(1e-3);
  });

  it("grows the level the model asks for, further with more steps", async () => {
    const rise = 0.01;
    const few = await paint({ neuralModel: modelText(risingWeights(rise)), neuralSteps: 4 });
    const many = await paint({ neuralModel: modelText(risingWeights(rise)), neuralSteps: 16 });
    const fewChange = medianLevelChange(few.before, few.after);
    const manyChange = medianLevelChange(many.before, many.after);
    // About half the cells fire each step.
    expect(fewChange).toBeGreaterThan(rise * 4 * 0.25);
    expect(fewChange).toBeLessThan(rise * 4 * 0.75);
    expect(manyChange).toBeGreaterThan(fewChange * 2.5);
    expect(many.after.every(Number.isFinite)).toBe(true);
  });

  /** How far each audible coefficient's phase sits from `phase`, at worst, mod 2π. */
  function worstPhaseError(data: Float32Array, phase: number): number {
    let worst = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] <= 0) continue;
      const d = data[i + 1] - phase;
      worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
    }
    return worst;
  }

  it("gives only the energy it adds the learnt phase", async () => {
    const byte = 64;
    const anchors = new Uint8Array(NCA_GRID).fill(byte);
    // A band whose level holds keeps its own phase.
    const still = await paint({ neuralModel: modelText(stillWeights(), anchors), neuralSteps: 2, neuralPhase: 0 });
    expect(worstPhaseError(still.after, 0)).toBeLessThan(1e-3);
    // Sound grown out of silence takes the learnt phase.
    spectrogramData = createMockSpectrogramData({ numFrames: 96, numBands: 96, sampleRate: 1000, pattern: "silence" });
    disposeHarnessTextures(textures);
    textures = createHarnessTextures(spectrogramData);
    const grown = await paint({ neuralModel: modelText(risingWeights(0.3), anchors), neuralSteps: 4, neuralPhase: 0 });
    expect(grown.after.some((v, i) => i % 4 === 0 && v > 0)).toBe(true);
    expect(worstPhaseError(grown.after, dequantisePhase(byte))).toBeLessThan(1e-3);
  });

  it("keeps the phase there, or makes it noise, when asked", async () => {
    const learnt = modelText(stillWeights(), new Uint8Array(NCA_GRID).fill(64));
    const kept = await paint({ neuralModel: learnt, neuralSteps: 2, neuralPhase: 2 });
    expect(worstPhaseError(kept.after, 0)).toBeLessThan(1e-3);
    const noise = await paint({ neuralModel: learnt, neuralSteps: 2, neuralPhase: 1 });
    expect(worstPhaseError(noise.after, 0)).toBeGreaterThan(1);
  });

  it("follows the phase path it read when the model changes nothing", async () => {
    // A phase that climbs along time: the path the grid reads, from the anchor
    // readAnchors takes, should land back on it.
    spectrogramData = createMockSpectrogramData({ numFrames: 96, numBands: 96, sampleRate: 1000, pattern: "sine" });
    disposeHarnessTextures(textures);
    textures = createHarnessTextures(spectrogramData);
    const anchors = readAnchors(spectrogramData, { x0: 0, y0: 0, x1: 1, y1: 1 });
    const { before, after } = await paint({
      neuralModel: modelText(stillWeights(), anchors),
      neuralSteps: 2,
      neuralPhase: 0,
    });
    let worst = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] < 0.1) continue;
      const d = after[i + 1] - before[i + 1];
      worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
    }
    expect(worst).toBeLessThan(0.1);
  });

  it("never grows a band past the loudest level its row reached in the learnt sound", async () => {
    const ceiling = 0.62;
    const bytes = new Uint8Array(NCA_GRID).fill(Math.round(ceiling * 255));
    const { after } = await paint({ neuralModel: modelText(risingWeights(0.05), null, bytes), neuralSteps: 32 });
    let loudest = 0;
    for (let i = 0; i < after.length; i += 4) loudest = Math.max(loudest, levelOf(after[i]));
    expect(loudest).toBeGreaterThan(levelOf(0.01));
    expect(loudest).toBeLessThan(ceiling + 1 / 255);
  });
});
