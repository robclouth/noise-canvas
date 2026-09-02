import { describe, expect, it } from "vitest";

import {
  createFileGroupsSlice,
  getFileSegments,
  selectFileGroup,
  fileGroupColor,
  groupMemberColor,
  groupMethodLabel,
  type FileGroupsState,
} from "../../store/file-groups";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

// Drives the real slice through a minimal store: the actions are written
// against zustand's set/get and immer producers, so running them for real is
// the only way to test the group bookkeeping without restating it here.
function makeSlice(): { state: FileGroupsState; get: ZustandGet } {
  let state: FileGroupsState;
  const get = (() => state as State) as ZustandGet;
  const set = ((partial) => {
    const next = typeof partial === "function" ? partial(state as State) : partial;
    state = { ...state, ...next } as FileGroupsState;
  }) as ZustandSet;
  state = createFileGroupsSlice(set, get);
  return { state: new Proxy({} as FileGroupsState, { get: (_, key) => state[key as keyof FileGroupsState] }), get };
}

const GROUP = {
  method: "nmf" as const,
  label: "loop — 3 parts",
  originId: "origin",
  memberIds: ["a", "b", "c"],
  hue: 200,
};

describe("stem groups", () => {
  it("indexes every member back to the group", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    expect(state.fileGroups[groupId].memberIds).toEqual(["a", "b", "c"]);
    expect(state.fileGroupOfFile).toEqual({ a: groupId, b: groupId, c: groupId });
  });

  it("defaults a new group to synced views", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);
    expect(state.fileGroups[groupId].syncView).toBe(true);

    state.setFileGroupSyncView(groupId, false);
    expect(state.fileGroups[groupId].syncView).toBe(false);
  });

  it("drops a closed file from its group", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    state.removeFileFromGroup("b");

    expect(state.fileGroups[groupId].memberIds).toEqual(["a", "c"]);
    expect(state.fileGroupOfFile).toEqual({ a: groupId, c: groupId });
  });

  it("discards a group once fewer than two members remain", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    state.removeFileFromGroup("b");
    state.removeFileFromGroup("c");

    expect(state.fileGroups[groupId]).toBeUndefined();
    expect(state.fileGroupOfFile).toEqual({});
  });

  it("ignores files that belong to no group", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    state.removeFileFromGroup("unrelated");

    expect(state.fileGroups[groupId].memberIds).toEqual(["a", "b", "c"]);
  });

  it("keeps groups independent of each other", () => {
    const { state } = makeSlice();
    const first = state.createFileGroup(GROUP);
    const second = state.createFileGroup({ ...GROUP, memberIds: ["d", "e"], originId: "other" });

    state.removeFileFromGroup("d");

    expect(state.fileGroups[second]).toBeUndefined();
    expect(state.fileGroups[first].memberIds).toEqual(["a", "b", "c"]);
    expect(state.fileGroupOfFile).toEqual({ a: first, b: first, c: first });
  });

  it("discards a group outright when it is ungrouped", () => {
    const { state } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    state.ungroupFiles(groupId);

    expect(state.fileGroups[groupId]).toBeUndefined();
    expect(state.fileGroupOfFile).toEqual({});
  });

  it("leaves other groups alone when one is ungrouped", () => {
    const { state } = makeSlice();
    const first = state.createFileGroup(GROUP);
    const second = state.createFileGroup({ ...GROUP, memberIds: ["d", "e"], originId: null, method: "user" });

    state.ungroupFiles(second);

    expect(state.fileGroups[first].memberIds).toEqual(["a", "b", "c"]);
    expect(state.fileGroupOfFile).toEqual({ a: first, b: first, c: first });
  });

  it("looks a group up from any of its members", () => {
    const { state, get } = makeSlice();
    const groupId = state.createFileGroup(GROUP);

    expect(selectFileGroup(get(), "b")?.id).toBe(groupId);
    expect(selectFileGroup(get(), "origin")).toBeUndefined();
  });
});

describe("getFileSegments", () => {
  it("brackets a run of group members and leaves loose files alone", () => {
    const segments = getFileSegments(["source", "a", "b", "other"], { a: "g1", b: "g1" });

    expect(segments).toEqual([
      { groupId: null, fileIds: ["source"] },
      { groupId: "g1", fileIds: ["a", "b"] },
      { groupId: null, fileIds: ["other"] },
    ]);
  });

  it("keeps adjacent groups apart", () => {
    const segments = getFileSegments(["a", "b", "c", "d"], { a: "g1", b: "g1", c: "g2", d: "g2" });

    expect(segments).toEqual([
      { groupId: "g1", fileIds: ["a", "b"] },
      { groupId: "g2", fileIds: ["c", "d"] },
    ]);
  });

  it("brackets each run separately when a group is split up", () => {
    const segments = getFileSegments(["a", "loose", "b"], { a: "g1", b: "g1" });

    expect(segments).toEqual([
      { groupId: "g1", fileIds: ["a"] },
      { groupId: null, fileIds: ["loose"] },
      { groupId: "g1", fileIds: ["b"] },
    ]);
  });

  it("returns nothing for no open files", () => {
    expect(getFileSegments([], {})).toEqual([]);
  });
});

describe("stem colours", () => {
  it("gives every member the group's hue at a distinct lightness", () => {
    const colors = [0, 1, 2, 3].map((i) => groupMemberColor(210, i, 4));

    for (const color of colors) expect(color).toContain("hsl(210,");
    expect(new Set(colors).size).toBe(4);
  });

  it("centres a lone member rather than putting it at an extreme", () => {
    const solo = groupMemberColor(210, 0, 1);
    expect(solo).toBe(fileGroupColor(210));
  });

  it("names each method", () => {
    expect(groupMethodLabel("hpss")).toBe("HPSS");
    expect(groupMethodLabel("nmf")).toBe("NMF");
    expect(groupMethodLabel("ai")).toBe("AI stems");
    expect(groupMethodLabel("user")).toBe("Group");
  });
});
