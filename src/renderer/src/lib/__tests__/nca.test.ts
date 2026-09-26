import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import { beforeAll, describe, expect, it } from "vitest";

import { NcaGpu } from "../nca/nca-gpu";
import { readGrid } from "../nca/nca-grid";
import {
  initialWeights,
  levelOf,
  magnitudeOf,
  NCA_CHANNELS,
  NCA_GRID,
  NCA_VISIBLE,
  NcaWeights,
  parseModel,
  serializeModel,
} from "../nca/nca-model";
import { runNca, soundState, trainNca } from "../nca/nca-train";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createGL } from "../../test/render-harness";

/** Deterministic numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Weights with a live second layer, so a step visibly changes the state. */
function liveWeights(random: () => number): NcaWeights {
  const weights = initialWeights(random);
  for (let i = 0; i < weights.w2.length; i++) weights.w2[i] = (random() * 2 - 1) * 0.1;
  for (let i = 0; i < weights.b1.length; i++) weights.b1[i] = (random() * 2 - 1) * 0.1;
  for (let i = 0; i < weights.b2.length; i++) weights.b2[i] = (random() * 2 - 1) * 0.01;
  return weights;
}

/** A state with sound in a band across the middle and noise in the hidden channels. */
function busyState(random: () => number): Float32Array {
  const state = new Float32Array(NCA_GRID * NCA_GRID * NCA_CHANNELS);
  for (let row = 0; row < NCA_GRID; row++) {
    for (let col = 0; col < NCA_GRID; col++) {
      if (Math.abs(row - NCA_GRID / 2) > 8) continue;
      const i = (row * NCA_GRID + col) * NCA_CHANNELS;
      state[i] = 0.3 + 0.5 * random();
      for (let c = 1; c < NCA_CHANNELS; c++) state[i + c] = random() * 2 - 1;
    }
  }
  return state;
}

beforeAll(async () => {
  await tf.setBackend("cpu");
});

describe("NCA model format", () => {
  it("round-trips a model through its parameter string", () => {
    const weights = liveWeights(lcg(1));
    const parsed = parseModel(serializeModel({ weights, label: "a bell", loss: 0.01, iterations: 5 }));
    expect(parsed?.label).toBe("a bell");
    expect(Array.from(parsed!.weights.w2)).toEqual(Array.from(weights.w2));
  });

  it("reads nothing from an empty or damaged parameter", () => {
    expect(parseModel("")).toBeNull();
    expect(parseModel("{")).toBeNull();
    expect(parseModel(JSON.stringify({ version: 1, weights: "AAAA" }))).toBeNull();
  });

  it("puts levels on a 90 dB scale that inverts", () => {
    expect(levelOf(1)).toBeCloseTo(1, 6);
    expect(levelOf(10 ** (-45 / 20))).toBeCloseTo(0.5, 6);
    expect(magnitudeOf(levelOf(0.02))).toBeCloseTo(0.02, 6);
    expect(magnitudeOf(0)).toBe(0);
  });
});

describe("NCA grid", () => {
  it("reads the file's level into the grid cells it covers", () => {
    const spec = createMockSpectrogramData({
      numFrames: 64,
      numBands: 48,
      pattern: "constant",
      constantMagnitude: 0.1,
    });
    const grid = readGrid(spec, { x0: 0, x1: 1, y0: 0, y1: 1 });
    expect(grid.length).toBe(NCA_GRID * NCA_GRID * NCA_VISIBLE);
    expect(grid[0]).toBeCloseTo(levelOf(0.1), 5);
    // Phase 0 on both channels: all of the level sits on the real axis.
    expect(grid[1]).toBeCloseTo(levelOf(0.1), 5);
    expect(grid[2]).toBeCloseTo(0, 5);
  });

  it("reads silence past the top of the file", () => {
    const spec = createMockSpectrogramData({
      numFrames: 64,
      numBands: 48,
      pattern: "constant",
      constantMagnitude: 0.1,
    });
    const grid = readGrid(spec, { x0: 0, x1: 1, y0: 0.5, y1: 1.5 });
    const topRow = (NCA_GRID - 1) * NCA_GRID * NCA_VISIBLE;
    expect(grid[topRow]).toBe(0);
    expect(grid[0]).toBeGreaterThan(0);
  });
});

describe("NCA step", () => {
  it("steps the same on the GPU as in the trainer", async () => {
    const random = lcg(7);
    const weights = liveWeights(random);
    const state = busyState(random);

    const expected = await runNca(state, weights, 3);

    const gl = createGL(64, 64);
    const gpu = new NcaGpu();
    gpu.setWeights(weights);
    gpu.load(gl, state);
    gpu.step(gl, 3, true);
    const actual = gpu.read(gl);
    gpu.dispose();
    gl.dispose();

    let worst = 0;
    let changed = 0;
    for (let i = 0; i < expected.length; i++) {
      worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
      changed = Math.max(changed, Math.abs(expected[i] - state[i]));
    }
    expect(changed).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(1e-4);
  });

  it("leaves the state alone when the network has nothing to say", async () => {
    const state = busyState(lcg(5));
    const silent = initialWeights(lcg(5));
    const result = await runNca(state, silent, 4);
    expect(Array.from(result)).toEqual(Array.from(state));
  });

  it("starts from the sound with the seed planted in the middle", () => {
    const visible = new Float32Array(NCA_GRID * NCA_GRID * NCA_VISIBLE).fill(0.25);
    const state = soundState(visible);
    const centre = (Math.floor(NCA_GRID / 2) * NCA_GRID + Math.floor(NCA_GRID / 2)) * NCA_CHANNELS;
    expect(state[0]).toBe(0.25);
    expect(state[NCA_VISIBLE]).toBe(0);
    // The seed is silent: the middle cell keeps the sound and turns its hidden channels on.
    expect(state[centre]).toBe(0.25);
    expect(state[centre + NCA_VISIBLE]).toBe(1);
    expect(state[centre + NCA_CHANNELS - 1]).toBe(1);
  });
});

describe("NCA training", () => {
  it("runs, reports progress and stops when asked", async () => {
    const target = new Float32Array(NCA_GRID * NCA_GRID * NCA_VISIBLE);
    for (let i = 0; i < target.length; i += NCA_VISIBLE) target[i] = 0.5;
    const controller = new AbortController();
    const seen: number[] = [];
    const result = await trainNca(
      target,
      [],
      { iterations: 5, batchSize: 1, poolSize: 2, stepsMin: 2, stepsMax: 3, random: lcg(11) },
      (progress) => {
        seen.push(progress.loss);
        if (progress.iteration === 2) controller.abort();
      },
      controller.signal,
    );
    expect(result.iterations).toBe(2);
    expect(seen.every(Number.isFinite)).toBe(true);
    expect(result.weights.w2.some((w) => w !== 0)).toBe(true);
  }, 120_000);
});
