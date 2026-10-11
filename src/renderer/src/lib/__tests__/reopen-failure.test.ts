import { beforeEach, describe, expect, it, vi } from "vitest";

// What the history of each reopened file holds: whether any is on disk, and
// whether loading it fails.
const gate = vi.hoisted(() => ({
  histories: new Map<string, { exists: boolean }>(),
}));

vi.mock("@renderer/effects", () => ({ effects: {} }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openInsertSilencePrompt: vi.fn(),
  openSetLengthPrompt: vi.fn(),
  openStackFilesPrompt: vi.fn(),
}));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn((fileId: string) => ({
    initialize: vi.fn(async () => gate.histories.get(fileId)?.exists ?? false),
    isEmpty: () => !(gate.histories.get(fileId)?.exists ?? false),
    loadSpectrogramAtCurrent: vi.fn(async () => {
      throw new Error("the history could not be read.");
    }),
  })),
}));
vi.mock("../onset-map", () => ({
  disposeOnsetTexture: vi.fn(),
  packOnsetState: vi.fn(),
  spliceOnsets: vi.fn(),
  unpackOnsetState: vi.fn(),
}));
vi.mock("tone", () => ({
  getTransport: () => ({ bpm: { value: 120 } }),
  getContext: () => ({ rawContext: {} }),
  Player: class {},
}));
vi.mock("../host", () => ({
  host: {
    env: { platform: "darwin", isExtension: false },
    path: {
      basename: (p: string) => p.split("/").pop() ?? p,
      dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
      extname: (p: string) => `.${p.split(".").pop()}`,
      join: (...parts: string[]) => parts.join("/"),
    },
    os: { totalmem: () => 8 * 1024 ** 3 },
    analysis: { getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }) },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

function makeStore(persisted: Record<string, string>) {
  let state: State;
  const set: ZustandSet = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  };
  const get: ZustandGet = () => state;
  state = {
    ...createFilesSlice(set, get),
    persistedFilePaths: { ...persisted },
    openFileIds: Object.keys(persisted),
    minimizedFileIds: [],
    fileDisplayNames: {},
    filesLoading: {},
    filesBandsPerOctave: {},
    filesZoom: {},
    filesOffset: {},
    filesZoomY: {},
    filesOffsetY: {},
    filesPlaybackStartTime: {},
    filesDirty: {},
    filepathsBpm: {},
    activeFileId: null,
    fullscreenFileId: null,
  } as unknown as State;
  return get;
}

describe("a file that cannot be reopened", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.histories.clear();
  });

  it("stays listed while its history is on disk, so the history is kept and the next launch tries again", async () => {
    gate.histories.set("kept", { exists: true });
    const get = makeStore({ kept: "managed://kept" });

    await get().reopenPersistedFiles();

    expect(get().persistedFilePaths).toEqual({ kept: "managed://kept" });
    expect(get().openFileIds).not.toContain("kept");
    expect(get().filesLoading.kept).toBeUndefined();
    expect(openFiles.kept).toBeUndefined();
  });

  it("is dropped when it has no history to keep", async () => {
    const get = makeStore({ gone: "managed://gone" });

    await get().reopenPersistedFiles();

    expect(get().persistedFilePaths).toEqual({});
    expect(get().openFileIds).not.toContain("gone");
  });
});
