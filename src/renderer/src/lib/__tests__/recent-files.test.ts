import { describe, expect, it, vi } from "vitest";

vi.mock("@renderer/effects", () => ({
  effects: {
    transform: {},
    dynamics: {},
    blur: {},
    overtones: {},
    synthesize: {},
    passthrough: {},
  },
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openContextModal: vi.fn(),
}));

vi.mock("../undo-manager", () => ({
  getUndoManager: vi.fn(),
  destroyUndoManager: vi.fn(),
}));

vi.mock("tone", () => ({
  Player: class {
    toDestination() {
      return this;
    }
  },
}));

vi.mock("@renderer/store", () => ({
  useStore: { getState: vi.fn() },
}));

import { createFilesSlice } from "../../store/files";
import type { State, ZustandSet } from "../../store/types";

function createTestStore() {
  let state: State = {} as State;

  const get = () => state;
  const set: ZustandSet = (partial) => {
    const update = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...update } as State;
  };

  const slice = createFilesSlice(set, get);
  state = { ...state, ...slice } as State;

  return {
    getRecent: () => state.recentFilePaths,
    addRecent: slice.addRecentFilePath,
    clearRecent: slice.clearRecentFilePaths,
  };
}

describe("recent files", () => {
  it("adds a path to the top of the list", () => {
    const store = createTestStore();
    store.addRecent("/a.wav");
    expect(store.getRecent()).toEqual(["/a.wav"]);
  });

  it("prepends newer paths ahead of older ones", () => {
    const store = createTestStore();
    store.addRecent("/a.wav");
    store.addRecent("/b.wav");
    store.addRecent("/c.wav");
    expect(store.getRecent()).toEqual(["/c.wav", "/b.wav", "/a.wav"]);
  });

  it("does not duplicate an existing path — it bumps it to the top", () => {
    const store = createTestStore();
    store.addRecent("/a.wav");
    store.addRecent("/b.wav");
    store.addRecent("/c.wav");
    store.addRecent("/a.wav");
    expect(store.getRecent()).toEqual(["/a.wav", "/c.wav", "/b.wav"]);
  });

  it("caps the list at 20 entries, dropping the oldest", () => {
    const store = createTestStore();
    for (let i = 0; i < 25; i++) {
      store.addRecent(`/file-${i}.wav`);
    }
    const recent = store.getRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("/file-24.wav");
    expect(recent[19]).toBe("/file-5.wav");
    expect(recent).not.toContain("/file-4.wav");
  });

  it("re-adding an existing entry does not grow the list past its current length", () => {
    const store = createTestStore();
    for (let i = 0; i < 20; i++) {
      store.addRecent(`/file-${i}.wav`);
    }
    expect(store.getRecent()).toHaveLength(20);

    store.addRecent("/file-10.wav");
    const recent = store.getRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("/file-10.wav");
    expect(recent.filter((p) => p === "/file-10.wav")).toHaveLength(1);
  });

  it("clears the list", () => {
    const store = createTestStore();
    store.addRecent("/a.wav");
    store.addRecent("/b.wav");
    store.clearRecent();
    expect(store.getRecent()).toEqual([]);
  });
});
