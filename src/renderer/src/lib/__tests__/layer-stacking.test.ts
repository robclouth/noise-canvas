import { beforeEach, describe, expect, it, vi } from "vitest";

// The same mocks file-colors.test.ts needs: without them the import chain pulls
// in the full zustand store, which has init-time circular deps outside a
// renderer.
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openContextModal: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openInsertSilencePrompt: vi.fn(),
  openSetLengthPrompt: vi.fn(),
  openStackFilesPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("tone", () => ({
  Player: class {
    toDestination() {
      return this;
    }
  },
}));

vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

vi.mock("../host", () => ({
  host: {
    env: { platform: "darwin" },
    path: {
      basename: (p: string) => p.split("/").pop() ?? p,
      dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
      extname: (p: string) => `.${p.split(".").pop()}`,
      join: (...parts: string[]) => parts.join("/"),
    },
    analysis: { getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }) },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import { createLayerStacksSlice } from "../../store/layers";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

// Both real slices over one state object: grouping spans them, so stubbing
// either side would test the stub instead of the bookkeeping.
function makeStore(openFileIds: string[]) {
  let state: State;
  const get = (() => state) as ZustandGet;
  const set = ((partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  }) as ZustandSet;

  state = {
    ...createLayerStacksSlice(set, get),
    ...createFilesSlice(set, get),
    applyLayerGains: () => {},
    openFileIds,
  } as unknown as State;

  for (const id of openFileIds) {
    openFiles[id] = { id, filePath: `/audio/${id}.wav`, displayName: `${id}.wav` } as (typeof openFiles)[string];
  }

  return get;
}

beforeEach(() => {
  for (const id of Object.keys(openFiles)) delete openFiles[id];
});

describe("grouping files by hand", () => {
  it("brackets the picked files and indexes each back to the stack", () => {
    const get = makeStore(["a", "b", "c"]);

    get().stackFiles(["a", "c"]);

    const stackId = get().stackOfLayer["a"];
    expect(stackId).toBeDefined();
    expect(get().layerStacks[stackId].layerIds).toEqual(["a", "c"]);
    expect(get().layerStacks[stackId].method).toBe("user");
    expect(get().layerStacks[stackId].originId).toBeNull();
  });

  it("moves the layers next to each other, since the bracket is one run", () => {
    const get = makeStore(["a", "b", "c", "d"]);

    get().stackFiles(["b", "d"]);

    expect(get().openFileIds).toEqual(["a", "b", "d", "c"]);
  });

  it("orders the layers by the canvas, not by the order they were picked", () => {
    const get = makeStore(["a", "b", "c"]);

    get().stackFiles(["c", "a"]);

    expect(get().layerStacks[get().stackOfLayer["a"]].layerIds).toEqual(["a", "c"]);
  });

  it("gives every layer the same hue", () => {
    const get = makeStore(["a", "b"]);

    get().stackFiles(["a", "b"]);

    const stack = get().layerStacks[get().stackOfLayer["a"]];
    expect(get().stackOfLayer["b"]).toBe(stack.id);
    expect(stack.hue).toBeGreaterThanOrEqual(0);
  });

  it("takes a file out of the stack it was already in", () => {
    const get = makeStore(["a", "b", "c", "d"]);
    const first = get().createLayerStack({
      method: "nmf",
      label: "loop",
      originId: "a",
      layerIds: ["a", "b"],
      hue: 200,
    });

    get().stackFiles(["b", "c"]);

    // 'a' is left holding the old stack on its own, which is a stack still.
    expect(get().layerStacks[first].layerIds).toEqual(["a"]);
    expect(get().layerStacks[get().stackOfLayer["b"]].layerIds).toEqual(["b", "c"]);
  });

  it("brackets a single file, so more can be dragged in later", () => {
    const get = makeStore(["a", "b"]);

    get().stackFiles(["a"]);

    const stackId = get().stackOfLayer["a"];
    expect(get().layerStacks[stackId].layerIds).toEqual(["a"]);
    expect(get().layerStacks[stackId].label).toBe("a");
  });

  it("does nothing when none of the picked files are open", () => {
    const get = makeStore(["a", "b"]);

    get().stackFiles(["not-open"]);

    expect(get().layerStacks).toEqual({});
    expect(get().openFileIds).toEqual(["a", "b"]);
  });
});

/** A store with `layers` bracketed as one stack, plus loose files around them. */
function makeGrouped(openFileIds: string[], layers: string[]) {
  const get = makeStore(openFileIds);
  const stackId = get().createLayerStack({
    method: "user",
    label: "stack",
    originId: null,
    layerIds: layers,
    hue: 200,
  });
  return { get, stackId };
}

describe("dropping a dragged file", () => {
  it("joins the stack the drop landed in, in canvas order", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("loose", "m2", stackId);

    expect(get().openFileIds).toEqual(["m1", "loose", "m2"]);
    expect(get().layerStacks[stackId].layerIds).toEqual(["m1", "loose", "m2"]);
    expect(get().stackOfLayer["loose"]).toBe(stackId);
  });

  it("stays outside the stack when the drop names no stack", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("loose", "m1", null);

    expect(get().stackOfLayer["loose"]).toBeUndefined();
    // The stack closes back up rather than straddling the file dropped above it.
    expect(get().openFileIds).toEqual(["loose", "m1", "m2"]);
    expect(get().layerStacks[stackId].layerIds).toEqual(["m1", "m2"]);
  });

  it("reorders inside the stack without leaving it", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "m3"], ["m1", "m2", "m3"]);

    get().dropFile("m3", "m1", stackId);

    expect(get().openFileIds).toEqual(["m3", "m1", "m2"]);
    // Member order follows the lanes, so the colours step down the stack as seen.
    expect(get().layerStacks[stackId].layerIds).toEqual(["m3", "m1", "m2"]);
  });

  it("takes a layer out of its stack when dropped outside", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "m3", "loose"], ["m1", "m2", "m3"]);

    get().dropFile("m2", null, null);

    expect(get().stackOfLayer["m2"]).toBeUndefined();
    expect(get().layerStacks[stackId].layerIds).toEqual(["m1", "m3"]);
    expect(get().openFileIds).toEqual(["m1", "m3", "loose", "m2"]);
  });

  it("keeps a stack that a departure leaves with one layer", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("m2", null, null);

    expect(get().layerStacks[stackId].layerIds).toEqual(["m1"]);
    expect(get().stackOfLayer).toEqual({ m1: stackId });
  });

  it("discards a stack once its last layer is dragged out", () => {
    const { get, stackId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("m2", null, null);
    get().dropFile("m1", null, null);

    expect(get().layerStacks[stackId]).toBeUndefined();
    expect(get().stackOfLayer).toEqual({});
  });

  it("moves a layer straight from one stack to another", () => {
    const get = makeStore(["a1", "a2", "a3", "b1", "b2"]);
    const first = get().createLayerStack({
      method: "user",
      label: "first",
      originId: null,
      layerIds: ["a1", "a2", "a3"],
      hue: 100,
    });
    const second = get().createLayerStack({
      method: "user",
      label: "second",
      originId: null,
      layerIds: ["b1", "b2"],
      hue: 200,
    });

    get().dropFile("a3", "b2", second);

    expect(get().layerStacks[first].layerIds).toEqual(["a1", "a2"]);
    expect(get().layerStacks[second].layerIds).toEqual(["b1", "a3", "b2"]);
    expect(get().openFileIds).toEqual(["a1", "a2", "b1", "a3", "b2"]);
  });

  it("leaves the old stack standing on its last layer when one moves across", () => {
    const get = makeStore(["a1", "a2", "b1", "b2"]);
    const first = get().createLayerStack({
      method: "user",
      label: "first",
      originId: null,
      layerIds: ["a1", "a2"],
      hue: 100,
    });
    const second = get().createLayerStack({
      method: "user",
      label: "second",
      originId: null,
      layerIds: ["b1", "b2"],
      hue: 200,
    });

    get().dropFile("a2", "b1", second);

    expect(get().layerStacks[first].layerIds).toEqual(["a1"]);
    expect(get().layerStacks[second].layerIds).toEqual(["a2", "b1", "b2"]);
  });

  it("does nothing to membership when a layer is dropped back in its own stack", () => {
    const { get, stackId } = makeGrouped(["m1", "m2"], ["m1", "m2"]);

    get().dropFile("m1", "m2", stackId);

    expect(get().layerStacks[stackId].layerIds).toEqual(["m1", "m2"]);
    expect(get().openFileIds).toEqual(["m1", "m2"]);
  });
});

describe("soloing a layer", () => {
  it("releases the other solos in its stack", () => {
    const get = makeStore(["a", "b", "c"]);
    get().stackFiles(["a", "b", "c"]);

    get().setFileSoloed("a", true);
    get().setFileSoloed("b", true);

    expect(get().filesSoloed.a).toBeUndefined();
    expect(get().filesSoloed.b).toBe(true);
  });

  it("leaves a solo in another stack alone", () => {
    const get = makeStore(["a", "b", "c", "d"]);
    get().stackFiles(["a", "b"]);
    get().stackFiles(["c", "d"]);

    get().setFileSoloed("a", true);
    get().setFileSoloed("c", true);

    expect(get().filesSoloed.a).toBe(true);
    expect(get().filesSoloed.c).toBe(true);
  });

  it("releases only itself when turned off", () => {
    const get = makeStore(["a", "b"]);
    get().stackFiles(["a", "b"]);

    get().setFileSoloed("a", true);
    get().setFileSoloed("a", false);

    expect(get().filesSoloed.a).toBe(false);
    expect(get().filesSoloed.b).toBeUndefined();
  });
});
