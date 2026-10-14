import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for Node Buffer in browser test environment.
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

const { scanFileOnsetsMock } = vi.hoisted(() => ({
  scanFileOnsetsMock: vi.fn<
    (
      read: (ranges: Uint32Array) => Promise<Float32Array>,
      layout: PackedLayout,
      sampleRate: number,
      bandMax: Float32Array,
      region?: { startSec: number; endSec: number; odfReference: number },
    ) => Promise<{ onsets: Float32Array; odfMax: number; bandMax: Float32Array }>
  >(async () => ({
    onsets: new Float32Array(0),
    odfMax: 1,
    bandMax: new Float32Array(0),
  })),
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
  openAddFilesAsLayersPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("../history-manager", () => ({
  releaseHistoryManager: vi.fn(async () => {}),
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn((fileId: string) => ({
    getCurrentId: () => "n1",
    awaitPackedReaders: vi.fn(async () => {}),
    currentRanges: vi.fn(async (ranges: Uint32Array) => {
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
  getContext: () => ({
    rawContext: {
      createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
        const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
        return {
          numberOfChannels,
          length,
          sampleRate,
          getChannelData: (channel: number) => data[channel],
          copyToChannel: (src: Float32Array, channel: number) => {
            data[channel].set(src);
          },
        } as unknown as AudioBuffer;
      },
    },
  }),
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
      openAnalysisStream: vi.fn(),
      synthesisReadReach: vi.fn(async () => 6),
      synthesize: vi.fn(async (_packed, _meta, _sampleRate, _params, _draft, channels) => ({
        channels: channels ?? [new Float32Array(64)],
        peak: 1,
        gainReductionDb: new Float32Array(0),
        maxGainReductionDb: 0,
      })),
      scanFileOnsets: scanFileOnsetsMock,
    },
  },
}));

import { createFilesSlice, openFiles } from "../../store/files";
import { destroyBlockStore, getBlockStore } from "../block-stores";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid } from "../block-grid";
import { canvasViewOf } from "../canvas-view";
import type { FileRendererHandle } from "../file-renderer-types";
import type { State, ZustandGet, ZustandSet } from "../../store/types";
import type { PackedLayout } from "../../../../main/lib/types";

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
    setActiveFileId: vi.fn(async (activeFileId: string | null) => {
      set({ activeFileId });
    }),
  } as unknown as State;

  return { get, files, set };
}

describe("duplicateFile", () => {
  beforeEach(async () => {
    for (const id of Object.keys(openFiles)) {
      await destroyBlockStore(id);
      delete openFiles[id];
    }
    memFs.clear();
    scanFileOnsetsMock.mockClear();
  });

  it("copies onsets and onsetReference into duplicate and skips scanFileOnsets on first synthesis", async () => {
    const { files } = makeStore();

    const spec = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });
    const sourceOnsets = Float32Array.from([0.1, 0.8, 0.5, 0.9]);
    const sourceBandMax = Float32Array.from([1.0, 2.0, 3.0]);
    const sourceReference = { odfMax: 4.5, bandMax: sourceBandMax };

    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: spec,
      onsets: sourceOnsets,
      onsetReference: sourceReference,
    } as (typeof openFiles)[string];

    await files.duplicateFile("f1");

    const newFileId = Object.keys(openFiles).find((id) => id !== "f1");
    expect(newFileId).toBeDefined();
    const newFile = openFiles[newFileId!];

    expect(newFile.onsets).toEqual(sourceOnsets);
    expect(newFile.onsets).not.toBe(sourceOnsets);
    expect(newFile.onsetReference).toEqual(sourceReference);
    expect(newFile.onsetReference?.bandMax).not.toBe(sourceBandMax);

    // Provide a mounted renderer reference for the new file with a windowed view.
    const grid = blockGrid({ numBands: spec.numBands, metadata: spec.metadata }, spec.numFrames, spec.sampleRate);
    const windowView = canvasViewOf(grid, 0, 0);
    const mockRenderer = {
      getFBOData: vi.fn(async () => new Float32Array(0)),
      getCanvasView: () => windowView,
      getDirtyRegion: () => null,
      clearDirtyRegion: vi.fn(),
      reloadTextures: vi.fn(),
      releaseAnalysisData: vi.fn(),
    } as unknown as FileRendererHandle;
    newFile.rendererRef = { current: mockRenderer };

    await files.synthesizeFile(newFileId!);

    expect(scanFileOnsetsMock).not.toHaveBeenCalled();
  });

  it("scans onsets during first synthesis if onsets or onsetReference are missing", async () => {
    const { files } = makeStore();

    const spec = createConstantQMockSpectrogramData({ durationSeconds: 6, sampleRate: 8000 });

    openFiles["f1"] = {
      id: "f1",
      filePath: "/audio/f1.wav",
      displayName: "f1.wav",
      spectrogramData: spec,
    } as (typeof openFiles)[string];

    await files.duplicateFile("f1");

    const newFileId = Object.keys(openFiles).find((id) => id !== "f1")!;
    const newFile = openFiles[newFileId];

    expect(newFile.onsets).toBeUndefined();
    expect(newFile.onsetReference).toBeUndefined();

    const grid = blockGrid({ numBands: spec.numBands, metadata: spec.metadata }, spec.numFrames, spec.sampleRate);
    const windowView = canvasViewOf(grid, 0, 0);
    const mockRenderer = {
      getFBOData: vi.fn(async () => new Float32Array(0)),
      getCanvasView: () => windowView,
      getDirtyRegion: () => null,
      clearDirtyRegion: vi.fn(),
      reloadTextures: vi.fn(),
      releaseAnalysisData: vi.fn(),
    } as unknown as FileRendererHandle;
    newFile.rendererRef = { current: mockRenderer };

    await files.synthesizeFile(newFileId);

    expect(scanFileOnsetsMock).toHaveBeenCalledTimes(1);
  });
});
