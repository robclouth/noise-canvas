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
  openGroupFilesPrompt: vi.fn(),
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
import { createFileGroupsSlice } from "../../store/file-groups";
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
    ...createFileGroupsSlice(set, get),
    ...createFilesSlice(set, get),
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
  it("brackets the picked files and indexes each back to the group", () => {
    const get = makeStore(["a", "b", "c"]);

    get().groupFiles(["a", "c"]);

    const groupId = get().fileGroupOfFile["a"];
    expect(groupId).toBeDefined();
    expect(get().fileGroups[groupId].memberIds).toEqual(["a", "c"]);
    expect(get().fileGroups[groupId].method).toBe("user");
    expect(get().fileGroups[groupId].originId).toBeNull();
  });

  it("moves the members next to each other, since the bracket is one run", () => {
    const get = makeStore(["a", "b", "c", "d"]);

    get().groupFiles(["b", "d"]);

    expect(get().openFileIds).toEqual(["a", "b", "d", "c"]);
  });

  it("orders the members by the canvas, not by the order they were picked", () => {
    const get = makeStore(["a", "b", "c"]);

    get().groupFiles(["c", "a"]);

    expect(get().fileGroups[get().fileGroupOfFile["a"]].memberIds).toEqual(["a", "c"]);
  });

  it("gives every member the same hue", () => {
    const get = makeStore(["a", "b"]);

    get().groupFiles(["a", "b"]);

    const group = get().fileGroups[get().fileGroupOfFile["a"]];
    expect(get().fileGroupOfFile["b"]).toBe(group.id);
    expect(group.hue).toBeGreaterThanOrEqual(0);
  });

  it("takes a file out of the group it was already in", () => {
    const get = makeStore(["a", "b", "c", "d"]);
    const first = get().createFileGroup({
      method: "nmf",
      label: "loop",
      originId: "a",
      memberIds: ["a", "b"],
      hue: 200,
    });

    get().groupFiles(["b", "c"]);

    // 'a' is left alone in the old group, which drops below two and dissolves.
    expect(get().fileGroups[first]).toBeUndefined();
    expect(get().fileGroupOfFile["a"]).toBeUndefined();
    expect(get().fileGroups[get().fileGroupOfFile["b"]].memberIds).toEqual(["b", "c"]);
  });

  it("does nothing for fewer than two open files", () => {
    const get = makeStore(["a", "b"]);

    get().groupFiles(["a"]);
    get().groupFiles(["a", "not-open"]);

    expect(get().fileGroups).toEqual({});
    expect(get().openFileIds).toEqual(["a", "b"]);
  });
});

/** A store with `members` bracketed as one group, plus loose files around them. */
function makeGrouped(openFileIds: string[], members: string[]) {
  const get = makeStore(openFileIds);
  const groupId = get().createFileGroup({
    method: "user",
    label: "group",
    originId: null,
    memberIds: members,
    hue: 200,
  });
  return { get, groupId };
}

describe("dropping a dragged file", () => {
  it("joins the group the drop landed in, in canvas order", () => {
    const { get, groupId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("loose", "m2", groupId);

    expect(get().openFileIds).toEqual(["m1", "loose", "m2"]);
    expect(get().fileGroups[groupId].memberIds).toEqual(["m1", "loose", "m2"]);
    expect(get().fileGroupOfFile["loose"]).toBe(groupId);
  });

  it("stays outside the group when the drop names no group", () => {
    const { get, groupId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("loose", "m1", null);

    expect(get().fileGroupOfFile["loose"]).toBeUndefined();
    // The group closes back up rather than straddling the file dropped above it.
    expect(get().openFileIds).toEqual(["loose", "m1", "m2"]);
    expect(get().fileGroups[groupId].memberIds).toEqual(["m1", "m2"]);
  });

  it("reorders inside the group without leaving it", () => {
    const { get, groupId } = makeGrouped(["m1", "m2", "m3"], ["m1", "m2", "m3"]);

    get().dropFile("m3", "m1", groupId);

    expect(get().openFileIds).toEqual(["m3", "m1", "m2"]);
    // Member order follows the lanes, so the colours step down the group as seen.
    expect(get().fileGroups[groupId].memberIds).toEqual(["m3", "m1", "m2"]);
  });

  it("takes a member out of its group when dropped outside", () => {
    const { get, groupId } = makeGrouped(["m1", "m2", "m3", "loose"], ["m1", "m2", "m3"]);

    get().dropFile("m2", null, null);

    expect(get().fileGroupOfFile["m2"]).toBeUndefined();
    expect(get().fileGroups[groupId].memberIds).toEqual(["m1", "m3"]);
    expect(get().openFileIds).toEqual(["m1", "m3", "loose", "m2"]);
  });

  it("dissolves a group that a departure leaves with one member", () => {
    const { get, groupId } = makeGrouped(["m1", "m2", "loose"], ["m1", "m2"]);

    get().dropFile("m2", null, null);

    expect(get().fileGroups[groupId]).toBeUndefined();
    expect(get().fileGroupOfFile).toEqual({});
  });

  it("moves a member straight from one group to another", () => {
    const get = makeStore(["a1", "a2", "a3", "b1", "b2"]);
    const first = get().createFileGroup({
      method: "user",
      label: "first",
      originId: null,
      memberIds: ["a1", "a2", "a3"],
      hue: 100,
    });
    const second = get().createFileGroup({
      method: "user",
      label: "second",
      originId: null,
      memberIds: ["b1", "b2"],
      hue: 200,
    });

    get().dropFile("a3", "b2", second);

    expect(get().fileGroups[first].memberIds).toEqual(["a1", "a2"]);
    expect(get().fileGroups[second].memberIds).toEqual(["b1", "a3", "b2"]);
    expect(get().openFileIds).toEqual(["a1", "a2", "b1", "a3", "b2"]);
  });

  it("dissolves the old group when the mover leaves only one behind", () => {
    const get = makeStore(["a1", "a2", "b1", "b2"]);
    const first = get().createFileGroup({
      method: "user",
      label: "first",
      originId: null,
      memberIds: ["a1", "a2"],
      hue: 100,
    });
    const second = get().createFileGroup({
      method: "user",
      label: "second",
      originId: null,
      memberIds: ["b1", "b2"],
      hue: 200,
    });

    get().dropFile("a2", "b1", second);

    expect(get().fileGroups[first]).toBeUndefined();
    expect(get().fileGroupOfFile["a1"]).toBeUndefined();
    expect(get().fileGroups[second].memberIds).toEqual(["a2", "b1", "b2"]);
  });

  it("does nothing to membership when a member is dropped back in its own group", () => {
    const { get, groupId } = makeGrouped(["m1", "m2"], ["m1", "m2"]);

    get().dropFile("m1", "m2", groupId);

    expect(get().fileGroups[groupId].memberIds).toEqual(["m1", "m2"]);
    expect(get().openFileIds).toEqual(["m1", "m2"]);
  });
});
