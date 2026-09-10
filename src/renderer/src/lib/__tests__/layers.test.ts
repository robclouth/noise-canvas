import { describe, expect, it } from "vitest";

import {
  createLayerStacksSlice,
  getLayerSegments,
  selectLayerStack,
  stackColor,
  layerColor,
  stackMethodLabel,
  type LayerStacksState,
} from "../../store/layers";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

// Drives the real slice through a minimal store: the actions are written
// against zustand's set/get and immer producers, so running them for real is
// the only way to test the stack bookkeeping without restating it here.
function makeSlice(): { state: LayerStacksState; get: ZustandGet } {
  let state: LayerStacksState;
  const get = (() => state as State) as ZustandGet;
  const set = ((partial) => {
    const next = typeof partial === "function" ? partial(state as State) : partial;
    state = { ...state, ...next } as LayerStacksState;
  }) as ZustandSet;
  state = createLayerStacksSlice(set, get);
  return { state: new Proxy({} as LayerStacksState, { get: (_, key) => state[key as keyof LayerStacksState] }), get };
}

const STACK = {
  method: "nmf" as const,
  label: "loop — 3 parts",
  originId: "origin",
  layerIds: ["a", "b", "c"],
  hue: 200,
};

describe("layer stacks", () => {
  it("indexes every layer back to the stack", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    expect(state.layerStacks[stackId].layerIds).toEqual(["a", "b", "c"]);
    expect(state.stackOfLayer).toEqual({ a: stackId, b: stackId, c: stackId });
  });

  it("defaults a new stack to synced views", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);
    expect(state.layerStacks[stackId].syncView).toBe(true);

    state.setLayerStackSyncView(stackId, false);
    expect(state.layerStacks[stackId].syncView).toBe(false);
  });

  it("drops a closed file from its stack", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    state.removeLayerFromStack("b");

    expect(state.layerStacks[stackId].layerIds).toEqual(["a", "c"]);
    expect(state.stackOfLayer).toEqual({ a: stackId, c: stackId });
  });

  it("keeps a stack down to its last layer", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    state.removeLayerFromStack("b");
    state.removeLayerFromStack("c");

    expect(state.layerStacks[stackId].layerIds).toEqual(["a"]);
    expect(state.stackOfLayer).toEqual({ a: stackId });
  });

  it("discards a stack once nothing is left in it", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    for (const id of ["a", "b", "c"]) state.removeLayerFromStack(id);

    expect(state.layerStacks[stackId]).toBeUndefined();
    expect(state.stackOfLayer).toEqual({});
  });

  it("ignores files that belong to no stack", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    state.removeLayerFromStack("unrelated");

    expect(state.layerStacks[stackId].layerIds).toEqual(["a", "b", "c"]);
  });

  it("keeps stacks independent of each other", () => {
    const { state } = makeSlice();
    const first = state.createLayerStack(STACK);
    const second = state.createLayerStack({ ...STACK, layerIds: ["d", "e"], originId: "other" });

    state.removeLayerFromStack("d");

    expect(state.layerStacks[second].layerIds).toEqual(["e"]);
    expect(state.layerStacks[first].layerIds).toEqual(["a", "b", "c"]);
    expect(state.stackOfLayer).toEqual({ a: first, b: first, c: first, e: second });
  });

  it("discards a stack outright when it is ungrouped", () => {
    const { state } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    state.unstackLayers(stackId);

    expect(state.layerStacks[stackId]).toBeUndefined();
    expect(state.stackOfLayer).toEqual({});
  });

  it("leaves other stacks alone when one is ungrouped", () => {
    const { state } = makeSlice();
    const first = state.createLayerStack(STACK);
    const second = state.createLayerStack({ ...STACK, layerIds: ["d", "e"], originId: null, method: "user" });

    state.unstackLayers(second);

    expect(state.layerStacks[first].layerIds).toEqual(["a", "b", "c"]);
    expect(state.stackOfLayer).toEqual({ a: first, b: first, c: first });
  });

  it("looks a stack up from any of its layers", () => {
    const { state, get } = makeSlice();
    const stackId = state.createLayerStack(STACK);

    expect(selectLayerStack(get(), "b")?.id).toBe(stackId);
    expect(selectLayerStack(get(), "origin")).toBeUndefined();
  });
});

describe("getLayerSegments", () => {
  it("brackets a run of stack layers and leaves loose files alone", () => {
    const segments = getLayerSegments(["source", "a", "b", "other"], { a: "g1", b: "g1" });

    expect(segments).toEqual([
      { stackId: null, fileIds: ["source"] },
      { stackId: "g1", fileIds: ["a", "b"] },
      { stackId: null, fileIds: ["other"] },
    ]);
  });

  it("keeps adjacent stacks apart", () => {
    const segments = getLayerSegments(["a", "b", "c", "d"], { a: "g1", b: "g1", c: "g2", d: "g2" });

    expect(segments).toEqual([
      { stackId: "g1", fileIds: ["a", "b"] },
      { stackId: "g2", fileIds: ["c", "d"] },
    ]);
  });

  it("brackets each run separately when a stack is split up", () => {
    const segments = getLayerSegments(["a", "loose", "b"], { a: "g1", b: "g1" });

    expect(segments).toEqual([
      { stackId: "g1", fileIds: ["a"] },
      { stackId: null, fileIds: ["loose"] },
      { stackId: "g1", fileIds: ["b"] },
    ]);
  });

  it("returns nothing for no open files", () => {
    expect(getLayerSegments([], {})).toEqual([]);
  });
});

describe("stack colours", () => {
  it("gives every layer the stack's hue at a distinct lightness", () => {
    const colors = [0, 1, 2, 3].map((i) => layerColor(210, i, 4));

    for (const color of colors) expect(color).toContain("hsl(210,");
    expect(new Set(colors).size).toBe(4);
  });

  it("centres a lone layer rather than putting it at an extreme", () => {
    const solo = layerColor(210, 0, 1);
    expect(solo).toBe(stackColor(210));
  });

  it("names each method", () => {
    expect(stackMethodLabel("hpss")).toBe("HPSS");
    expect(stackMethodLabel("nmf")).toBe("NMF");
    expect(stackMethodLabel("ai")).toBe("AI stems");
    expect(stackMethodLabel("user")).toBe("Stack");
  });
});
