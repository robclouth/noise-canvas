import { beforeAll, describe, expect, it } from "vitest";

import type { BaseEffect } from "../../effects/base-effect";
import type { EffectType } from "../../effects/types";
import type { ParameterKey } from "../../store/types";
import { createMockStateWithSteps } from "../../test/mock-state";
import { resolveStrokeReach, strokeReadSpan, type StepReach, type TimeReachContext } from "../stroke-reach";

// Loaded at run time: importing an effect module at module scope trips the
// effects registry's circular imports.
let effects: Record<EffectType, BaseEffect>;
beforeAll(async () => {
  effects = (await import("../../effects")).effects;
});

const NUM_FRAMES = 100_000;
const VIEW = { startFrame: 40_000, endFrame: 60_000 };

function step(overrides: Partial<StepReach> = {}): StepReach {
  return {
    wrap: false,
    selfSource: true,
    sourceTimeScale: 1,
    sourceOffsetUvLow: 0,
    sourceOffsetUvHigh: 0,
    iterations: 1,
    effectReaches: [],
    ...overrides,
  };
}

function ctx(values: Partial<Record<ParameterKey, number | [number, number]>> = {}): TimeReachContext {
  const bounds = (key: ParameterKey): [number, number] => {
    const v = values[key] ?? 0;
    return Array.isArray(v) ? v : [v, v];
  };
  return {
    maxAbs: (key) => Math.max(...bounds(key).map(Math.abs)),
    minAbs: (key) => {
      const [low, high] = bounds(key);
      return low <= 0 && high >= 0 ? 0 : Math.min(Math.abs(low), Math.abs(high));
    },
    brushSpanFrames: 2_000,
    brushPitchUvSpan: 0.25,
    framesPerBeat: 1_000,
    numFrames: NUM_FRAMES,
  };
}

describe("strokeReadSpan", () => {
  it("is the view when every read is pointwise", () => {
    expect(strokeReadSpan(VIEW, [step()], NUM_FRAMES)).toEqual({
      startFrame: VIEW.startFrame,
      endFrame: VIEW.endFrame,
      wholeFile: false,
    });
  });

  it("carries the source offset extremes through the transform", () => {
    const span = strokeReadSpan(VIEW, [step({ sourceOffsetUvLow: -0.1, sourceOffsetUvHigh: 0.2 })], NUM_FRAMES);
    expect(span.startFrame).toBe(VIEW.startFrame - 10_000);
    expect(span.endFrame).toBe(VIEW.endFrame + 20_000);
    expect(span.wholeFile).toBe(false);
  });

  it("scales the view span into source frames", () => {
    const span = strokeReadSpan(VIEW, [step({ sourceTimeScale: 1.5 })], NUM_FRAMES);
    expect(span.endFrame).toBe(90_000);
    expect(span.startFrame).toBe(VIEW.startFrame);
  });

  it("widens by each finite stencil, once per iteration", () => {
    const once = strokeReadSpan(VIEW, [step({ effectReaches: [{ kind: "frames", frames: 500 }] })], NUM_FRAMES);
    expect(once.startFrame).toBe(VIEW.startFrame - 500);
    expect(once.endFrame).toBe(VIEW.endFrame + 500);
    const four = strokeReadSpan(
      VIEW,
      [step({ iterations: 4, effectReaches: [{ kind: "frames", frames: 500 }] })],
      NUM_FRAMES,
    );
    expect(four.startFrame).toBe(VIEW.startFrame - 2_000);
    expect(four.endFrame).toBe(VIEW.endFrame + 2_000);
  });

  it("a cross-file step widens nothing here", () => {
    const span = strokeReadSpan(
      VIEW,
      [step({ selfSource: false, sourceOffsetUvHigh: 0.5, effectReaches: [{ kind: "frames", frames: 9_000 }] })],
      NUM_FRAMES,
    );
    expect(span).toEqual({ startFrame: VIEW.startFrame, endFrame: VIEW.endFrame, wholeFile: false });
  });

  it("wrap and whole-file stencils take the whole file, even cross-file", () => {
    for (const s of [
      step({ wrap: true }),
      step({ effectReaches: [{ kind: "wholeFile" }] }),
      step({ selfSource: false, effectReaches: [{ kind: "wholeFile" }] }),
    ]) {
      expect(strokeReadSpan(VIEW, [s], NUM_FRAMES)).toEqual({
        startFrame: 0,
        endFrame: NUM_FRAMES,
        wholeFile: true,
      });
    }
  });

  it("clamps to the file without claiming the whole-file class", () => {
    const span = strokeReadSpan(VIEW, [step({ sourceOffsetUvLow: -0.9, sourceOffsetUvHigh: 0.9 })], NUM_FRAMES);
    expect(span).toEqual({ startFrame: 0, endFrame: NUM_FRAMES, wholeFile: false });
  });

  it("unions the steps", () => {
    const span = strokeReadSpan(
      VIEW,
      [
        step({ sourceOffsetUvLow: -0.2, sourceOffsetUvHigh: -0.2 }),
        step({ effectReaches: [{ kind: "frames", frames: 5_000 }] }),
      ],
      NUM_FRAMES,
    );
    expect(span.startFrame).toBe(VIEW.startFrame - 20_000);
    expect(span.endFrame).toBe(VIEW.endFrame + 5_000);
  });
});

describe("effect reach declarations", () => {
  it("pointwise effects declare none", () => {
    for (const effect of [
      effects.passthrough,
      effects.dynamics,
      effects.waveshape,
      effects.binaural,
      effects.synthesize,
      effects.align,
    ]) {
      expect(effect.timeReach(ctx())).toEqual({ kind: "none" });
    }
  });

  it("the whole-file class declares itself", () => {
    for (const effect of [effects.evolve, effects.sort, effects.convolve, effects.transmute, effects.attract]) {
      expect(effect.timeReach(ctx())).toEqual({ kind: "wholeFile" });
    }
  });

  it("blur reaches its box, grown by the noise jitter", () => {
    // 50% of the 4-beat range = 2 beats = 2000 frames.
    expect(effects.blur.timeReach(ctx({ blurAmountTime: 50 }))).toEqual({ kind: "frames", frames: 2_000 });
    expect(effects.blur.timeReach(ctx({ blurAmountTime: 50, blurNoiseTime: 100 }))).toEqual({
      kind: "frames",
      frames: 4_000,
    });
  });

  it("clone reaches the farthest copy", () => {
    expect(effects.clone.timeReach(ctx({ cloneSpaceBeats: 4, cloneCountX: 3 }))).toEqual({
      kind: "frames",
      frames: 12_000,
    });
  });

  it("transform reaches the shifted, inverse-scaled box", () => {
    // 8 beats of shift plus the 2000-frame box at half time scale.
    expect(effects.transform.timeReach(ctx({ transformShiftBeats: 8, transformScaleTime: 50 }))).toEqual({
      kind: "frames",
      frames: 8_000 + 4_000,
    });
  });

  it("transform folds pitch into time under rotation", () => {
    const reach = effects.transform.timeReach(ctx({ transformScaleTime: 100, transformRotation: 90 }));
    // The box itself plus a quarter of the file's frames from the pitch extent.
    expect(reach).toEqual({ kind: "frames", frames: 2_000 + 25_000 });
  });

  it("a time scale that modulation can push through zero caps at the file", () => {
    const reach = effects.transform.timeReach(ctx({ transformScaleTime: [-256, 256] }));
    expect(reach).toEqual({ kind: "frames", frames: NUM_FRAMES });
  });
});

describe("resolveStrokeReach", () => {
  const OPTS = {
    bpm: 120,
    numFrames: NUM_FRAMES,
    sampleRate: 8_000,
    bandsPerOctave: 12,
    numBands: 96,
    destFilePath: "/test/self.wav",
  };
  const FRAMES_PER_BEAT = (OPTS.sampleRate * 60) / OPTS.bpm;

  type StepSpec = Parameters<typeof createMockStateWithSteps>[0][number];

  function resolve(specs: StepSpec[], opts: Partial<typeof OPTS> = {}) {
    const state = createMockStateWithSteps(specs);
    return resolveStrokeReach(state, effects, { ...OPTS, ...opts });
  }

  it("resolves a plain step as pointwise self-source reads", () => {
    const [reach] = resolve([
      { name: "Plain", overrides: { effects: [{ id: "d", effect: "dynamics", enabled: true, params: {} }] } },
    ]);
    expect(reach).toEqual({
      wrap: false,
      selfSource: true,
      sourceTimeScale: 1,
      sourceOffsetUvLow: 0,
      sourceOffsetUvHigh: 0,
      iterations: 1,
      effectReaches: [{ kind: "none" }],
    });
  });

  it("reads effect parameters from the effect item, not the step", () => {
    const [reach] = resolve([
      {
        name: "Blur",
        overrides: { effects: [{ id: "b", effect: "blur", enabled: true, params: { blurAmountTime: 50 } }] },
      },
    ]);
    // 50% of the 4-beat range = 2 beats.
    expect(reach.effectReaches).toEqual([{ kind: "frames", frames: 2 * FRAMES_PER_BEAT }]);
  });

  it("takes a modulated effect parameter at its range", () => {
    // The noise jitter rests at 0; a routed modulator can push it to 100,
    // which doubles the default 4-beat box.
    const [reach] = resolve([
      {
        name: "Blur",
        overrides: {
          effects: [{ id: "b", effect: "blur", enabled: true, params: { blurNoiseTimeMod1Amount: 40 } }],
        },
      },
    ]);
    expect(reach.effectReaches).toEqual([{ kind: "frames", frames: 8 * FRAMES_PER_BEAT }]);
  });

  it("skips a disabled effect", () => {
    const [reach] = resolve([
      { name: "Off", overrides: { effects: [{ id: "e", effect: "evolve", enabled: false, params: {} }] } },
    ]);
    expect(reach.effectReaches).toEqual([]);
  });

  it("takes a modulated source offset across the whole file", () => {
    const [reach] = resolve([{ name: "Mod", overrides: { sourceTimeOffsetMod1Amount: 50, effects: [] } }]);
    expect(reach.sourceOffsetUvLow).toBe(0);
    expect(reach.sourceOffsetUvHigh).toBe(1);
  });

  it("maps wrap modes to time wrapping alone", () => {
    const reaches = resolve([
      { name: "Time", overrides: { brushWrapMode: 1, effects: [] } },
      { name: "Pitch", overrides: { brushWrapMode: 2, effects: [] } },
      { name: "Both", overrides: { brushWrapMode: 3, effects: [] } },
    ]);
    expect(reaches.map((reach) => reach.wrap)).toEqual([true, false, true]);
  });

  it("marks a cross-file step and carries iterations", () => {
    const [cross] = resolve([
      { name: "Cross", overrides: { sourceFile: { path: "/test/other.wav" }, brushIterations: 4, effects: [] } },
    ]);
    expect(cross.selfSource).toBe(false);
    expect(cross.iterations).toBe(4);
  });
});
