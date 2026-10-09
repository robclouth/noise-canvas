import { describe, expect, it } from "vitest";
import { clampPlaybackWindow, layerGain, stackHasSolo, type LayerMix } from "../layer-mix";

const EMPTY: LayerMix = { muted: {}, soloed: {} };
const STACK = ["a", "b", "c"];

function mix(partial: Partial<LayerMix>): LayerMix {
  return { ...EMPTY, ...partial };
}

describe("layerGain", () => {
  it("plays every layer when nothing is muted or soloed", () => {
    for (const id of STACK) expect(layerGain(EMPTY, STACK, id)).toBe(1);
  });

  it("silences a muted layer and leaves the others alone", () => {
    const m = mix({ muted: { b: true } });
    expect(layerGain(m, STACK, "b")).toBe(0);
    expect(layerGain(m, STACK, "a")).toBe(1);
  });

  it("silences everything a solo leaves out", () => {
    const m = mix({ soloed: { b: true } });
    expect(layerGain(m, STACK, "b")).toBe(1);
    expect(layerGain(m, STACK, "a")).toBe(0);
    expect(layerGain(m, STACK, "c")).toBe(0);
  });

  it("plays every soloed layer when several are soloed", () => {
    const m = mix({ soloed: { a: true, c: true } });
    expect(layerGain(m, STACK, "a")).toBe(1);
    expect(layerGain(m, STACK, "c")).toBe(1);
    expect(layerGain(m, STACK, "b")).toBe(0);
  });

  it("lets mute win over solo on the same layer", () => {
    const m = mix({ soloed: { a: true }, muted: { a: true } });
    expect(layerGain(m, STACK, "a")).toBe(0);
    // The solo still holds the rest down, so the stack falls silent.
    expect(layerGain(m, STACK, "b")).toBe(0);
  });

  it("ignores a solo outside the stack", () => {
    const m = mix({ soloed: { elsewhere: true } });
    expect(stackHasSolo(m, STACK)).toBe(false);
    expect(layerGain(m, STACK, "a")).toBe(1);
  });
});

describe("clampPlaybackWindow", () => {
  it("covers the whole buffer with no region", () => {
    expect(clampPlaybackWindow(null, 10)).toEqual({ start: 0, end: 10 });
  });

  it("takes a region inside the buffer as it stands", () => {
    expect(clampPlaybackWindow({ start: 2, end: 5 }, 10)).toEqual({ start: 2, end: 5 });
  });

  it("bounds a region measured against a longer file", () => {
    expect(clampPlaybackWindow({ start: 8, end: 30 }, 10)).toEqual({ start: 8, end: 10 });
  });

  it("never starts a window past its own end", () => {
    expect(clampPlaybackWindow({ start: 40, end: 50 }, 10)).toEqual({ start: 10, end: 10 });
  });
});
