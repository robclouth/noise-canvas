import { beforeEach, describe, expect, it, vi } from "vitest";

// The browser test environment has no Node Buffer; provide a minimal stand-in
// so fileBlockBackend's Buffer.from call succeeds.
const g = globalThis as unknown as { Buffer?: unknown };
if (g.Buffer === undefined) {
  function stub(): void {
    return undefined;
  }
  g.Buffer = Object.assign(stub, {
    from: (src: ArrayBuffer | ArrayBufferView | number[], off?: number, len?: number): Uint8Array => {
      if (src instanceof ArrayBuffer) return new Uint8Array(src, off ?? 0, len ?? src.byteLength - (off ?? 0));
      if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      return new Uint8Array(src);
    },
  });
}

const gate = vi.hoisted(() => ({
  mergeCalls: 0,
  failOnBlock: null as number | null,
  capturedNewFileId: null as string | null,
  storeWasOpenDuringMerge: false,
}));

vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openInsertSilencePrompt: vi.fn(),
  openSetLengthPrompt: vi.fn(),
  openStackFilesPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("../history-manager", () => ({
  releaseHistoryManager: vi.fn(async () => {}),
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn(() => ({
    getCurrentId: () => "n1",
    awaitPackedReaders: vi.fn(async () => {}),
    currentRanges: vi.fn(async () => null),
    currentBlockState: vi.fn(async () => null),
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
  Player: class {
    toDestination() {
      return this;
    }
  },
}));

const memFs = new Map<string, Uint8Array>();

vi.mock("../host", () => ({
  host: {
    env: { platform: "darwin", isExtension: false },
    path: {
      basename: (p: string) => p.split("/").pop() ?? p,
      dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
      extname: (p: string) => `.${p.split(".").pop()}`,
      join: (...parts: string[]) => parts.join("/"),
    },
    os: { totalmem: () => 16 * 1024 ** 3 },
    dialogs: {
      getUserDataPath: async () => "/userdata",
    },
    fs: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, data: Uint8Array) => {
        memFs.set(path, data);
      }),
      readFile: vi.fn(async (path: string) => {
        const data = memFs.get(path);
        if (!data) throw new Error(`ENOENT: ${path}`);
        return data;
      }),
      rm: vi.fn(async (path: string) => {
        memFs.delete(path);
        for (const key of [...memFs.keys()]) {
          if (key.startsWith(`${path}/`)) memFs.delete(key);
        }
      }),
    },
    analysis: {
      getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }),
      encodeHistorySnapshot: async (block: Float32Array) =>
        new Uint8Array(block.buffer, block.byteOffset, block.byteLength),
      decodeHistorySnapshot: async (bytes: Uint8Array) =>
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      mergeSpectrograms: async (parts: Float32Array[]) => {
        const callIndex = gate.mergeCalls++;
        if (gate.capturedNewFileId === null) {
          gate.capturedNewFileId = Object.keys(openFiles).find((id) => id !== "f1" && id !== "f2") ?? null;
          if (gate.capturedNewFileId && getBlockStore(gate.capturedNewFileId) !== null) {
            gate.storeWasOpenDuringMerge = true;
          }
        }
        if (gate.failOnBlock !== null && callIndex === gate.failOnBlock) {
          throw new Error(`mergeSpectrograms failed on block ${callIndex}`);
        }
        return { merged: new Float32Array(parts[0].length) };
      },
    },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import { getBlockStore } from "../block-stores";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

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
    openFileIds: [],
    activeFileId: null,
    bandsPerOctave: 12,
    minFreq: 20,
    isPlaying: false,
    filesDirty: {},
    filesBandsPerOctave: {},
    filesZoom: {},
    filesOffset: {},
    filesZoomY: {},
    filesOffsetY: {},
    filesPlaybackStartTime: {},
    persistedFilePaths: {},
    fileDisplayNames: {},
    filepathsBpm: {},
    filesLoading: {},
    stopAudio: vi.fn(),
    removeLayerFromStack: vi.fn(),
    layerStacks: {},
    stackOfLayer: {},
    setActiveFileId: vi.fn(async () => {}),
  } as unknown as State;

  return { get, files, set };
}

describe("mergeFiles", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    memFs.clear();
    gate.mergeCalls = 0;
    gate.failOnBlock = null;
    gate.capturedNewFileId = null;
    gate.storeWasOpenDuringMerge = false;
  });

  it("destroys the block store when mergeSpectrograms fails on the second block", async () => {
    const { files } = makeStore();

    // 6 seconds at 8000 Hz with 2-second target produces 3 blocks.
    const spec1 = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });
    const spec2 = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });

    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: spec1,
    } as (typeof openFiles)[string];
    openFiles["f2"] = {
      id: "f2",
      filePath: "/audio/f2.wav",
      displayName: "f2.wav",
      spectrogramData: spec2,
    } as (typeof openFiles)[string];

    // Make mergeSpectrograms reject on the second block (index 1)
    gate.failOnBlock = 1;

    await files.mergeFiles(["f1", "f2"]);

    expect(gate.capturedNewFileId).not.toBeNull();
    expect(gate.storeWasOpenDuringMerge).toBe(true);
    expect(gate.mergeCalls).toBe(2);
    expect(getBlockStore(gate.capturedNewFileId!)).toBeNull();
  });
});
