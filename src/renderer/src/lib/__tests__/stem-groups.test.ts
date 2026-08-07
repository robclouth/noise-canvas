import { describe, expect, it } from "vitest";

import {
  createStemGroupsSlice,
  getFileSegments,
  selectStemGroupOfFile,
  stemGroupColor,
  stemMemberColor,
  stemMethodLabel,
  type StemGroupsState,
} from "../../store/stem-groups";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

// Drives the real slice through a minimal store: the actions are written
// against zustand's set/get and immer producers, so running them for real is
// the only way to test the group bookkeeping without restating it here.
function makeSlice(): { state: StemGroupsState; get: ZustandGet } {
  let state: StemGroupsState;
  const get = (() => state as State) as ZustandGet;
  const set = ((partial) => {
    const next = typeof partial === "function" ? partial(state as State) : partial;
    state = { ...state, ...next } as StemGroupsState;
  }) as ZustandSet;
  state = createStemGroupsSlice(set, get);
  return { state: new Proxy({} as StemGroupsState, { get: (_, key) => state[key as keyof StemGroupsState] }), get };
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
    const groupId = state.createStemGroup(GROUP);

    expect(state.stemGroups[groupId].memberIds).toEqual(["a", "b", "c"]);
    expect(state.stemGroupOfFile).toEqual({ a: groupId, b: groupId, c: groupId });
  });

  it("defaults a new group to synced views", () => {
    const { state } = makeSlice();
    const groupId = state.createStemGroup(GROUP);
    expect(state.stemGroups[groupId].syncView).toBe(true);

    state.setStemGroupSyncView(groupId, false);
    expect(state.stemGroups[groupId].syncView).toBe(false);
  });

  it("drops a closed file from its group", () => {
    const { state } = makeSlice();
    const groupId = state.createStemGroup(GROUP);

    state.removeFileFromStemGroup("b");

    expect(state.stemGroups[groupId].memberIds).toEqual(["a", "c"]);
    expect(state.stemGroupOfFile).toEqual({ a: groupId, c: groupId });
  });

  it("discards a group once fewer than two members remain", () => {
    const { state } = makeSlice();
    const groupId = state.createStemGroup(GROUP);

    state.removeFileFromStemGroup("b");
    state.removeFileFromStemGroup("c");

    expect(state.stemGroups[groupId]).toBeUndefined();
    expect(state.stemGroupOfFile).toEqual({});
  });

  it("ignores files that belong to no group", () => {
    const { state } = makeSlice();
    const groupId = state.createStemGroup(GROUP);

    state.removeFileFromStemGroup("unrelated");

    expect(state.stemGroups[groupId].memberIds).toEqual(["a", "b", "c"]);
  });

  it("keeps groups independent of each other", () => {
    const { state } = makeSlice();
    const first = state.createStemGroup(GROUP);
    const second = state.createStemGroup({ ...GROUP, memberIds: ["d", "e"], originId: "other" });

    state.removeFileFromStemGroup("d");

    expect(state.stemGroups[second]).toBeUndefined();
    expect(state.stemGroups[first].memberIds).toEqual(["a", "b", "c"]);
    expect(state.stemGroupOfFile).toEqual({ a: first, b: first, c: first });
  });

  it("looks a group up from any of its members", () => {
    const { state, get } = makeSlice();
    const groupId = state.createStemGroup(GROUP);

    expect(selectStemGroupOfFile(get(), "b")?.id).toBe(groupId);
    expect(selectStemGroupOfFile(get(), "origin")).toBeUndefined();
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
    const colors = [0, 1, 2, 3].map((i) => stemMemberColor(210, i, 4));

    for (const color of colors) expect(color).toContain("hsl(210,");
    expect(new Set(colors).size).toBe(4);
  });

  it("centres a lone member rather than putting it at an extreme", () => {
    const solo = stemMemberColor(210, 0, 1);
    expect(solo).toBe(stemGroupColor(210));
  });

  it("names each method", () => {
    expect(stemMethodLabel("hpss")).toBe("HPSS");
    expect(stemMethodLabel("nmf")).toBe("NMF");
    expect(stemMethodLabel("ai")).toBe("AI stems");
  });
});
