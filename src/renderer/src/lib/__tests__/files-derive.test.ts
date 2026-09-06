import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal Buffer stand-in for browser test environment.
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

const historyManagerGate = vi.hoisted(() => ({
  currentRangesHook: null as ((fileId: string, ranges: Uint32Array) => Promise<Float32Array | null | undefined>) | null,
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
  openGroupFilesPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn((fileId: string) => ({
    getCurrentId: () => "n1",
    awaitPackedReaders: vi.fn(async () => {}),
    currentRanges: vi.fn(async (ranges: Uint32Array) => {
      if (historyManagerGate.currentRangesHook) {
        const hooked = await historyManagerGate.currentRangesHook(fileId, ranges);
        if (hooked !== undefined) return hooked;
      }
      const store = await getBlockStore(fileId);
      return store ? store.readRanges(ranges) : null;
    }),
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
      mergeSpectrograms: async (parts: Float32Array[]) => ({
        merged: new Float32Array(parts[0].length),
      }),
    },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import { destroyBlockStore, getBlockStore, openBlockStore } from "../block-stores";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { pixelRangeCount } from "../pixel-ranges";
import { serializeFileTask } from "../file-task-queue";
import type { OpenFile, State, ZustandGet, ZustandSet } from "../../store/types";

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
    removeFileFromGroup: vi.fn(),
    fileGroups: {},
    fileGroupOfFile: {},
    setActiveFileId: vi.fn(async (activeFileId: string | null) => {
      set({ activeFileId });
    }),
  } as unknown as State;

  return { get, files, set };
}

describe("deriving file state", () => {
  beforeEach(async () => {
    for (const id of Object.keys(openFiles)) {
      await destroyBlockStore(id);
      delete openFiles[id];
    }
    memFs.clear();
    historyManagerGate.currentRangesHook = null;
  });

  it("serializes copy against source patches so the copy reads pre-patch state block for block", async () => {
    const { files } = makeStore();
    const spec = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });
    const layout = { numBands: spec.numBands, metadata: spec.metadata };
    const shape = { numFrames: spec.numFrames, sampleRate: spec.sampleRate, texelCount: spec.texels };

    const sourceStore = await openBlockStore("f1", layout, shape);
    await sourceStore.seedFrom(async (index) => {
      const count = pixelRangeCount(sourceStore.blockRanges(index)) * 4;
      const block = new Float32Array(count);
      block.fill(10 * (index + 1));
      return block;
    });

    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: spec,
    } as OpenFile;

    let patchPromise: Promise<void> | null = null;
    let patchRanAtReadCount = -1;
    let readCount = 0;

    historyManagerGate.currentRangesHook = async (fileId, ranges) => {
      if (fileId !== "f1" || ranges.length === 0) return undefined;
      const store = await getBlockStore("f1");
      const data = store ? await store.readRanges(ranges) : null;
      readCount++;
      if (readCount === 1) {
        patchPromise = serializeFileTask("f1", async () => {
          patchRanAtReadCount = readCount;
          const b1Ranges = store!.blockRanges(1);
          const patchValues = new Float32Array(pixelRangeCount(b1Ranges) * 4).fill(999);
          await store!.patch(b1Ranges, patchValues);
        });
      }
      return data;
    };

    await files.duplicateFile("f1");
    await patchPromise;

    expect(patchRanAtReadCount).toBe(3);
    expect(readCount).toBe(3);

    const newFileId = Object.keys(openFiles).find((id) => id !== "f1")!;
    expect(newFileId).toBeDefined();

    const copyStore = await getBlockStore(newFileId)!;
    expect(copyStore).not.toBeNull();

    const copyBlocks = await Promise.all([0, 1, 2].map((index) => copyStore!.readBlock(index)));
    for (let i = 0; i < 3; i++) {
      const copyBlock = copyBlocks[i];
      const expectedValue = 10 * (i + 1);
      expect(copyBlock.every((v) => v === expectedValue)).toBe(true);
    }

    const sourceBlock1 = await sourceStore.readBlock(1);
    expect(sourceBlock1[0]).toBe(999);
  });

  it("falls back to full run when currentRanges returns null mid-read", async () => {
    const { files } = makeStore();
    const spec = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });
    const layout = { numBands: spec.numBands, metadata: spec.metadata };
    const shape = { numFrames: spec.numFrames, sampleRate: spec.sampleRate, texelCount: spec.texels };

    const sourceStore = await openBlockStore("f1", layout, shape);
    await sourceStore.seedFrom(async (index) => {
      const count = pixelRangeCount(sourceStore.blockRanges(index)) * 4;
      const block = new Float32Array(count);
      block.fill(5);
      return block;
    });

    const fullData = new Float32Array(spec.texels * 4).fill(7);
    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: { ...spec, packedData: fullData },
    } as OpenFile;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let callCount = 0;
    historyManagerGate.currentRangesHook = async (fileId, ranges) => {
      if (fileId !== "f1" || ranges.length === 0) return undefined;
      callCount++;
      if (callCount === 2) return null;
      const store = await getBlockStore("f1");
      return store ? store.readRanges(ranges) : null;
    };

    await files.duplicateFile("f1");

    expect(warnSpy).toHaveBeenCalledTimes(1);

    const newFileId = Object.keys(openFiles).find((id) => id !== "f1")!;
    const copyStore = await getBlockStore(newFileId)!;
    expect(copyStore).not.toBeNull();

    const [block0, block1, block2] = await Promise.all([0, 1, 2].map((index) => copyStore!.readBlock(index)));
    expect(block0[0]).toBe(5);
    expect(block1[0]).toBe(7);
    expect(block2[0]).toBe(7);

    warnSpy.mockRestore();
  });

  it("sets filesLoading to Duplicating during duplicate and clears it when done", async () => {
    const { files, get } = makeStore();
    const spec = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });
    const layout = { numBands: spec.numBands, metadata: spec.metadata };
    const shape = { numFrames: spec.numFrames, sampleRate: spec.sampleRate, texelCount: spec.texels };

    const sourceStore = await openBlockStore("f1", layout, shape);
    await sourceStore.seedFrom(async (index) => {
      const count = pixelRangeCount(sourceStore.blockRanges(index)) * 4;
      return new Float32Array(count);
    });

    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: spec,
    } as OpenFile;

    let loadingDuringCopy: string | undefined;
    historyManagerGate.currentRangesHook = async (fileId, ranges) => {
      if (fileId !== "f1" || ranges.length === 0) return undefined;
      const newFileId = Object.keys(openFiles).find((id) => id !== "f1");
      if (newFileId) {
        loadingDuringCopy = get().filesLoading[newFileId];
      }
      const store = await getBlockStore("f1");
      return store ? store.readRanges(ranges) : null;
    };

    await files.duplicateFile("f1");

    expect(loadingDuringCopy).toBe("Duplicating...");

    const newFileId = Object.keys(openFiles).find((id) => id !== "f1")!;
    expect(get().filesLoading[newFileId]).toBeUndefined();
    expect(get().activeFileId).toBe(newFileId);
  });
});
