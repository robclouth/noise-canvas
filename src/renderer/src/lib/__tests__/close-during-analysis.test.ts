import { beforeEach, describe, expect, it, vi } from "vitest";

// The analysis a test drives: openFilePath awaits this promise, so a test can
// close the file while the "analysis" is still running.
const gate = vi.hoisted(() => ({ resolve: null as ((result: unknown) => void) | null }));

vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../modals", () => ({ openConfirm: vi.fn(), openNewFilePrompt: vi.fn() }));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn(),
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
  Player: class {
    toDestination() {
      return this;
    }
  },
}));
vi.mock("../host", () => ({
  host: {
    env: { platform: "darwin" },
    path: {
      basename: (p: string) => p.split("/").pop() ?? p,
      extname: () => ".wav",
      join: (...parts: string[]) => parts.join("/"),
    },
    analysis: {
      getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }),
      analyze: () => new Promise((resolve) => (gate.resolve = resolve)),
    },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

const TEXELS = 512;

// The fields of a gaborator result that SpectrogramData is built from.
function analysisResult() {
  return {
    data: new Float32Array(TEXELS * TEXELS * 4),
    inverseMap: new Float32Array(TEXELS * TEXELS * 2),
    metadata: new Float32Array(16),
    textureWidth: TEXELS,
    textureHeight: TEXELS,
    numFrames: 1024,
    numChannels: 2,
    numBands: 96,
    bandOffsets: new Uint32Array(96),
    bandStepLog2s: new Int32Array(96),
    bandLengths: new Uint32Array(96),
    sampleRate: 48000,
    magnitudeEnergy: 1,
    onsets: new Float32Array(0),
  };
}

function makeStore() {
  let state: State;
  const set: ZustandSet = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  };
  const get: ZustandGet = () => state;

  const files = createFilesSlice(set, get);
  state = {
    ...files,
    bandsPerOctave: 12,
    minFreq: 20,
    isPlaying: false,
    stopAudio: vi.fn(),
    removeFileFromStemGroup: vi.fn(),
    stemGroups: {},
    stemGroupOfFile: {},
  } as unknown as State;

  return { get, files };
}

describe("closing a file while it is being analysed", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.resolve = null;
  });

  it("drops the analysis instead of putting the file back", async () => {
    const { get, files } = makeStore();

    const opening = files.openFilePath("/audio/long.wav");
    const fileId = get().openFileIds[0];
    expect(openFiles[fileId]).toBeDefined();

    files.closeFile(fileId);
    expect(openFiles[fileId]).toBeUndefined();

    gate.resolve?.(analysisResult());
    await opening;

    // A resurrected entry holds the whole packed spectrogram for the rest of
    // the session, and no tab is left to close it from.
    expect(Object.keys(openFiles)).toEqual([]);
    expect(get().openFileIds).toEqual([]);
    expect(get().activeFileId).toBeNull();
    expect(get().filesLoading[fileId]).toBeUndefined();
  });

  it("still loads a file that stays open", async () => {
    const { get, files } = makeStore();

    const opening = files.openFilePath("/audio/long.wav");
    const fileId = get().openFileIds[0];

    gate.resolve?.(analysisResult());
    await opening;

    expect(openFiles[fileId]?.spectrogramData?.textureWidth).toBe(TEXELS);
    expect(get().activeFileId).toBe(fileId);
    expect(get().filesLoading[fileId]).toBeUndefined();
  });
});
