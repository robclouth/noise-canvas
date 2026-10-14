import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string | undefined>());

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
  openAddFilesAsLayersPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("../history-manager", () => ({
  releaseHistoryManager: vi.fn(async () => {}),
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn((fileId: string) => ({
    currentNodeId: async () => `${fileId}-node`,
    markSaved: async (nodeId?: string) => {
      saved.set(fileId, nodeId);
    },
  })),
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

import { createFilesSlice, openFiles, snapshotSaveAudio } from "../../store/files";
import { createLayerStacksSlice } from "../../store/layers";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

/** An audio buffer holding `channels`, as much of one as a save reads. */
function buffer(channels: number[][]): AudioBuffer {
  const data = channels.map((values) => Float32Array.from(values));
  return {
    numberOfChannels: data.length,
    sampleRate: 48000,
    length: data[0].length,
    getChannelData: (i: number) => data[i],
  } as unknown as AudioBuffer;
}

/** A file "song" whose layers are itself and "perc", each with its own audio. */
function makeLayeredFile(): ZustandGet {
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
    openFileIds: ["song", "perc", "other"],
  } as unknown as State;
  const audio: Record<string, number[][]> = {
    song: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    perc: [
      [0.5, -0.2],
      [0, 0.1],
    ],
    other: [
      [1, 1],
      [1, 1],
    ],
  };
  for (const [id, channels] of Object.entries(audio)) {
    openFiles[id] = {
      id,
      filePath: `/audio/${id}.wav`,
      displayName: `${id}.wav`,
      audioBuffer: buffer(channels),
    } as (typeof openFiles)[string];
  }
  get().createLayerStack({
    method: "hpss",
    label: "song",
    originId: "song",
    layerIds: ["song", "perc"],
    hue: 20,
    ownerId: "song",
  });
  return get;
}

beforeEach(() => {
  for (const id of Object.keys(openFiles)) delete openFiles[id];
  saved.clear();
});

describe("saving a file with layers", () => {
  it("writes the plain sum of every layer, and nothing of other files", async () => {
    const get = makeLayeredFile();
    const audio = await snapshotSaveAudio(get, "song");
    const sum = [
      [0.6, 0],
      [0.3, 0.5],
    ];
    sum.forEach((channel, ch) => channel.forEach((value, i) => expect(audio?.channels[ch][i]).toBeCloseTo(value, 6)));
    expect(audio?.nodes).toEqual([
      { fileId: "song", nodeId: "song-node" },
      { fileId: "perc", nodeId: "perc-node" },
    ]);
  });

  it("counts muted layers in, since mute only changes what you hear", async () => {
    const get = makeLayeredFile();
    get().setFileMuted("perc", true);
    const audio = await snapshotSaveAudio(get, "song");
    expect(audio?.mutedLayers).toBe(1);
    expect(audio?.channels[0][0]).toBeCloseTo(0.6, 5);
  });

  it("writes a file without layers as it is", async () => {
    const get = makeLayeredFile();
    const audio = await snapshotSaveAudio(get, "other");
    expect(audio?.channels.map((channel) => Array.from(channel))).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(audio?.nodes).toEqual([{ fileId: "other", nodeId: "other-node" }]);
  });
});
