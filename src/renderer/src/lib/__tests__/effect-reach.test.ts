import { describe, expect, it } from "vitest";

import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import { brushReaches, strokeReach, type ReachContext, type TimeReach } from "../effect-reach";

// A 60-second file at 120 bpm, on a canvas holding 16 seconds of it. The mock
// brush is one beat wide, so its own span is half a second.
const CTX: ReachContext = { bpm: 120, fileSeconds: 60, canvasSeconds: 16, bandsPerOctave: 24, numBands: 240 };
const BRUSH_SECONDS = 0.5;

function withEffect(effect: string, overrides: Partial<TestBrushStep> = {}): Partial<TestBrushStep> {
  return { ...overrides, effects: [{ id: `mock-${effect}`, effect, enabled: true, params: {} }] };
}

function reachOf(...steps: Array<Partial<TestBrushStep>>): TimeReach {
  return strokeReach(createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides }))), CTX);
}

describe("blur reach", () => {
  it("smears a quarter of the four-beat range a beat either side", () => {
    // Bleed reads past the brush; Middle spreads the smear both ways.
    expect(reachOf(withEffect("blur", { blurAmountTime: 25, blurEdgeMode: 1, blurOrigin: 1 }))).toEqual({
      before: 0.5,
      after: 0.5,
    });
  });

  it.each([
    { origin: 0, before: 0.5, after: 0 },
    { origin: 1, before: 0.5, after: 0.5 },
    { origin: 2, before: 0, after: 0.5 },
  ])("reads one way at origin $origin", ({ origin, before, after }) => {
    expect(reachOf(withEffect("blur", { blurAmountTime: 25, blurEdgeMode: 1, blurOrigin: origin }))).toEqual({
      before,
      after,
    });
  });

  it("adds the tap noise to the smear", () => {
    const reach = reachOf(
      withEffect("blur", { blurAmountTime: 25, blurNoiseTime: 25, blurEdgeMode: 1, blurOrigin: 1 }),
    );
    expect(reach.before).toBeCloseTo(0.6, 10);
  });

  it.each([0, 2, 3, 4])("reads nothing past the brush at edge mode %i", (blurEdgeMode) => {
    expect(reachOf(withEffect("blur", { blurAmountTime: 100, blurEdgeMode, blurOrigin: 1 }))).toEqual({
      before: 0,
      after: 0,
    });
  });
});

describe("repeat reach", () => {
  it("reaches the furthest copy", () => {
    const reach = reachOf(
      withEffect("clone", { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneDirectionX: 0, cloneEdgeMode: 1 }),
    );
    expect(reach.before).toBeCloseTo(0.375, 10);
    expect(reach.after).toBeCloseTo(0.375, 10);
  });

  it("halves the reach when the copies spread both ways", () => {
    const reach = reachOf(
      withEffect("clone", { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneDirectionX: 1, cloneEdgeMode: 1 }),
    );
    expect(reach.before).toBeCloseTo(0.1875, 10);
  });

  it("follows the shape table, so accelerating copies reach further", () => {
    const even = reachOf(
      withEffect("clone", { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneShapeX: "even", cloneEdgeMode: 1 }),
    );
    const accelerating = reachOf(
      withEffect("clone", { cloneCountX: 3, cloneSpaceBeats: 0.25, cloneShapeX: "geometric", cloneEdgeMode: 1 }),
    );
    // The geometric table's last entry is 2^3 - 1 against the even table's 3.
    expect(accelerating.after).toBeCloseTo((even.after * 7) / 3, 10);
  });

  it("reads nothing past the brush with no copies", () => {
    expect(reachOf(withEffect("clone", { cloneCountX: 0, cloneEdgeMode: 1 }))).toEqual({ before: 0, after: 0 });
  });

  it("reads nothing past the brush when the edge cuts", () => {
    expect(reachOf(withEffect("clone", { cloneCountX: 8, cloneSpaceBeats: 1, cloneEdgeMode: 0 }))).toEqual({
      before: 0,
      after: 0,
    });
  });
});

describe("warp reach", () => {
  it("reads a shift either side of the brush", () => {
    expect(reachOf(withEffect("transform", { transformShiftBeats: 2, transformEdgeMode: 1 }))).toEqual({
      before: 1,
      after: 1,
    });
  });

  it("reads the extra span a stretch pulls in", () => {
    // A pivot at the brush's start, so the whole stretch runs forwards.
    const reach = reachOf(
      withEffect("transform", { transformScaleTime: 0.5, transformOriginTime: 0, transformEdgeMode: 1 }),
    );
    expect(reach.before).toBe(0);
    expect(reach.after).toBeCloseTo(BRUSH_SECONDS, 10);
  });

  it("takes a turn's pitch arm against the whole file", () => {
    // The brush spans a twelfth of the bands, and a quarter turn reads that
    // span of the file's own time axis.
    const reach = reachOf(
      withEffect("transform", { transformRotation: 90, transformOriginPitch: 0, transformEdgeMode: 1 }),
    );
    expect(reach.before).toBeCloseTo(0.1 * CTX.fileSeconds, 8);
  });

  it("reads nothing past the brush when the edge cuts", () => {
    expect(reachOf(withEffect("transform", { transformShiftBeats: 8, transformEdgeMode: 0 }))).toEqual({
      before: 0,
      after: 0,
    });
  });

  it("reads without bound when a modulated scale can pass through zero", () => {
    const reach = reachOf(
      withEffect("transform", {
        transformScaleTime: 1,
        transformScaleTimeMod1Amount: 100,
        transformEdgeMode: 1,
      }),
    );
    expect(reach.before).toBe(Infinity);
    expect(reach.after).toBe(Infinity);
  });

  it("widens a shift by as much as its modulation can move it", () => {
    const plain = reachOf(withEffect("transform", { transformShiftBeats: 1, transformEdgeMode: 1 }));
    const modulated = reachOf(
      withEffect("transform", { transformShiftBeats: 1, transformShiftBeatsMod1Amount: 10, transformEdgeMode: 1 }),
    );
    expect(modulated.before).toBeGreaterThan(plain.before);
    // Ten per cent of the way to the far end, which is 33 beats from a shift of one.
    expect(modulated.before).toBeCloseTo(plain.before + 0.1 * 33 * 0.5, 8);
  });
});

describe("transmute reach", () => {
  it("moves a band the amount it is given, in beats, both ways", () => {
    expect(reachOf(withEffect("transmute", { transmuteTo: 2, transmuteAmount: 3 }))).toEqual({
      before: 1.5,
      after: 1.5,
    });
  });

  it("reads the bin it writes on every other route", () => {
    for (const transmuteTo of [0, 1, 3, 4]) {
      expect(reachOf(withEffect("transmute", { transmuteTo, transmuteAmount: 8 }))).toEqual({ before: 0, after: 0 });
    }
  });

  it("takes the amount's sign off, since the drive pushes both ways", () => {
    expect(reachOf(withEffect("transmute", { transmuteTo: 2, transmuteAmount: -3 }))).toEqual({
      before: 1.5,
      after: 1.5,
    });
  });
});

describe("attract reach", () => {
  it("reads the field a couple of smoothings past the brush", () => {
    expect(reachOf(withEffect("attract", { attractMap: 0, attractAmountX: 50, attractSmoothX: 2 }))).toEqual({
      before: 2,
      after: 2,
    });
  });

  it("reads nothing with no time pull", () => {
    expect(reachOf(withEffect("attract", { attractMap: 0, attractAmountX: 0, attractSmoothX: 4 }))).toEqual({
      before: 0,
      after: 0,
    });
  });

  it.each([1, 2])("reads no field on map %i, which pulls toward a lattice", (attractMap) => {
    expect(reachOf(withEffect("attract", { attractMap, attractAmountX: 100, attractSmoothX: 4 }))).toEqual({
      before: 0,
      after: 0,
    });
  });

  it("reads a modulator's field like the source's", () => {
    expect(reachOf(withEffect("attract", { attractMap: 3, attractAmountX: 100, attractSmoothX: 1 }))).toEqual({
      before: 1,
      after: 1,
    });
  });
});

describe("evolve reach", () => {
  it("reads nine neighbourhoods, and the neighbourhood is beats", () => {
    // Full Scale is a beat, so half of it is a quarter of a second here, and
    // the gradient taps plus the flow step cover nine of those.
    expect(reachOf(withEffect("evolve", { evolveScaleX: 50 }))).toEqual({ before: 2.25, after: 2.25 });
  });

  it("reads nothing along time with no neighbourhood to flow through", () => {
    expect(reachOf(withEffect("evolve", { evolveScaleX: 0, evolveFlow: 100 }))).toEqual({ before: 0, after: 0 });
  });

  it("takes the scale's sign off, since the neighbourhood is a width", () => {
    expect(reachOf(withEffect("evolve", { evolveScaleX: -50 }))).toEqual({ before: 2.25, after: 2.25 });
  });
});

describe("convolve reach", () => {
  const RESPONSE = { path: "/response.wav", name: "response.wav" };
  const withResponse = (params: Record<string, unknown>): Partial<TestBrushStep> => ({
    effects: [{ id: "mock-convolve", effect: "convolve", enabled: true, params }],
  });
  const CTX_WITH_RESPONSE: ReachContext = { ...CTX, otherFileSeconds: () => 3 };

  it("reads the response's own length back, scaled by the rate", () => {
    const state = createMockStateWithSteps([
      { name: "Step", overrides: withResponse({ convolveIrFile: RESPONSE, convolveIrRate: 2 }) },
    ]);
    expect(strokeReach(state, CTX_WITH_RESPONSE)).toEqual({ before: 6, after: 6 });
  });

  it("reads nothing when no response file is named", () => {
    const state = createMockStateWithSteps([{ name: "Step", overrides: withResponse({ convolveIrRate: 2 }) }]);
    expect(strokeReach(state, CTX_WITH_RESPONSE)).toEqual({ before: 0, after: 0 });
  });

  it("reads nothing when the response file cannot be found", () => {
    const state = createMockStateWithSteps([
      { name: "Step", overrides: withResponse({ convolveIrFile: RESPONSE, convolveIrRate: 2 }) },
    ]);
    expect(strokeReach(state, { ...CTX, otherFileSeconds: () => null })).toEqual({ before: 0, after: 0 });
  });

  it("takes the rate's sign off, since the taps run either way", () => {
    const state = createMockStateWithSteps([
      { name: "Step", overrides: withResponse({ convolveIrFile: RESPONSE, convolveIrRate: -2 }) },
    ]);
    expect(strokeReach(state, CTX_WITH_RESPONSE)).toEqual({ before: 6, after: 6 });
  });
});

describe("the brush's reach as a whole", () => {
  it("finds nothing in effects that read only the texel they write", () => {
    expect(reachOf(withEffect("dynamics"), withEffect("synthesize"))).toEqual({ before: 0, after: 0 });
  });

  it("ignores an effect that is switched off", () => {
    const step: Partial<TestBrushStep> = {
      transformShiftBeats: 4,
      transformEdgeMode: 1,
      effects: [{ id: "mock-transform", effect: "transform", enabled: false, params: {} }],
    };
    expect(reachOf(step)).toEqual({ before: 0, after: 0 });
  });

  it("takes the furthest reach of any step", () => {
    const near = withEffect("transform", { transformShiftBeats: 1, transformEdgeMode: 1 });
    const far = withEffect("transform", { transformShiftBeats: 4, transformEdgeMode: 1 });
    expect(reachOf(near, far).before).toBeCloseTo(2, 10);
  });

  it("reports each reach with the step and the brush span it belongs to", () => {
    const entries = brushReaches(
      createMockStateWithSteps([
        { name: "Plain", overrides: {} },
        { name: "Shifted", overrides: withEffect("transform", { transformShiftBeats: 2, transformEdgeMode: 1 }) },
      ]),
      CTX,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].effect).toBe("transform");
    expect(entries[0].step).toBe(1);
    expect(entries[0].brushSeconds).toBeCloseTo(BRUSH_SECONDS, 10);
  });
});
