import { beforeEach, describe, expect, it, vi } from "vitest";

// Gates the addon calls a test drives, so work can be left in flight while the
// store is asked to do something else.
const gate = vi.hoisted(() => ({
  synthesize: [] as ((result: unknown) => void)[],
  exported: [] as { path: string; channels: Float32Array[] }[],
  confirmed: true,
  declineTitles: [] as string[],
  nodeId: "n1",
  markedSaved: [] as (string | undefined)[],
  holdExport: false,
  releaseExport: null as (() => void) | null,
  order: [] as string[],
  analysisResult: () => {
    const bands = 4;
    return {
      data: new Float32Array(64),
      inverseMap: new Float32Array(16),
      metadata: new Float32Array(16),
      textureWidth: 8,
      textureHeight: 8,
      numFrames: 64,
      numBands: bands,
      numChannels: 1,
      sampleRate: 48000,
      magnitudeEnergy: 1,
      bandOffsets: new Uint32Array(bands),
      bandStepLog2s: new Int32Array(bands),
      bandLengths: new Uint32Array(bands),
    };
  },
}));

vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../modals", () => ({
  openConfirm: vi.fn((opts: { title: string; onConfirm?: () => void; onCancel?: () => void }) => {
    if (gate.confirmed && !gate.declineTitles.includes(opts.title)) void opts.onConfirm?.();
    else void opts.onCancel?.();
  }),
  openNewFilePrompt: vi.fn(),
}));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn(() => ({
    currentNodeId: vi.fn(async () => gate.nodeId),
    markSaved: vi.fn(async (nodeId?: string) => {
      gate.markedSaved.push(nodeId);
    }),
    addSnapshot: vi.fn(async () => {
      gate.order.push("snapshot");
      return "s1";
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
      dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
      extname: (p: string) => `.${p.split(".").pop()}`,
      join: (...parts: string[]) => parts.join("/"),
    },
    analysis: {
      getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }),
      synthesize: () => new Promise((resolve) => gate.synthesize.push(resolve)),
      exportAudio: async (channels: Float32Array[], path: string) => {
        gate.exported.push({ path, channels: channels.map((c) => Float32Array.from(c)) });
        if (gate.holdExport) await new Promise<void>((resolve) => (gate.releaseExport = resolve));
      },
      analyseBuffer: async () => {
        gate.order.push("analyse");
        return gate.analysisResult();
      },
      analyze: async () => {
        gate.order.push("analyse");
        return gate.analysisResult();
      },
    },
  },
}));

import { drainFileTaskQueues, serializeFileTask } from "../file-task-queue";
import { clearFileReferences, createFilesSlice, openFiles } from "../../store/files";
import type { Brush, State, ZustandGet, ZustandSet } from "../../store/types";

const FILE_ID = "f1";

function makeStore(overrides: Partial<State> = {}) {
  let state: State;
  const set: ZustandSet = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  };
  const get: ZustandGet = () => state;

  const files = createFilesSlice(set, get);
  state = {
    ...files,
    activeFileId: FILE_ID,
    bandsPerOctave: 12,
    minFreq: 20,
    isPlaying: false,
    brushes: [],
    filesDirty: {},
    stopAudio: vi.fn(),
    removeFileFromStemGroup: vi.fn(),
    stemGroups: {},
    stemGroupOfFile: {},
    ...overrides,
  } as unknown as State;

  return { get, files, set };
}

/** An open file whose canvas reads back a constant and reports no dirty region. */
function openTestFile(filePath = "/audio/a.wav") {
  const numBands = 4;
  openFiles[FILE_ID] = {
    id: FILE_ID,
    filePath,
    displayName: filePath.split("/").pop(),
    spectrogramData: {
      numFrames: 64,
      numChannels: 1,
      numBands,
      sampleRate: 48000,
      bandsPerOctave: 12,
      minFreq: 20,
      synthesisMetadata: {
        bandOffsets: new Uint32Array(numBands),
        bandStepLog2s: new Int32Array(numBands),
        bandLengths: new Uint32Array(numBands),
      },
    },
    rendererRef: {
      current: {
        getFBOData: async () => new Float32Array(64),
        getDirtyRegion: () => null,
        clearDirtyRegion: vi.fn(),
        reloadTextures: vi.fn(),
      },
    },
  } as unknown as (typeof openFiles)[string];
}

function synthResult(marker: number) {
  return { channels: [Float32Array.from([marker])], peak: 1 };
}

function audioBuffer(samples: number[]) {
  return {
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => Float32Array.from(samples),
  } as unknown as AudioBuffer;
}

describe("two synthesis passes racing", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.synthesize = [];
  });

  it("drops a result that a newer pass has already superseded", async () => {
    const applySynthesizedAudio = vi.fn(async () => {});
    const { get, files } = makeStore({ applySynthesizedAudio } as unknown as Partial<State>);
    openTestFile();

    // Undo then redo: each schedules its own synthesis before the first returns.
    const first = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(1));
    const second = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(2));

    // The newer pass lands first, then the older one arrives late.
    gate.synthesize[1](synthResult(2));
    await second;
    gate.synthesize[0](synthResult(1));
    await first;

    expect(applySynthesizedAudio).toHaveBeenCalledTimes(1);
    const [, result] = applySynthesizedAudio.mock.calls[0] as unknown as [string, { channels: Float32Array[] }];
    expect(Array.from(result.channels[0])).toEqual([2]);
    expect(get().filesSynthesizing[FILE_ID]).toBeFalsy();
  });

  it("holds the synthesising flag until the newest pass finishes", async () => {
    const applySynthesizedAudio = vi.fn(async () => {});
    const { get, files } = makeStore({ applySynthesizedAudio } as unknown as Partial<State>);
    openTestFile();

    const first = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(1));
    const second = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(2));

    // The superseded pass returns first, while the newer one still runs.
    gate.synthesize[0](synthResult(1));
    await first;
    expect(get().filesSynthesizing[FILE_ID]).toBe(true);

    gate.synthesize[1](synthResult(2));
    await second;
    expect(get().filesSynthesizing[FILE_ID]).toBe(false);
  });

  it("applies the result when nothing supersedes it", async () => {
    const applySynthesizedAudio = vi.fn(async () => {});
    const { files } = makeStore({ applySynthesizedAudio } as unknown as Partial<State>);
    openTestFile();

    const only = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(1));
    gate.synthesize[0](synthResult(7));
    await only;

    expect(applySynthesizedAudio).toHaveBeenCalledTimes(1);
  });
});

describe("saving while a stroke is still committing", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.exported = [];
    gate.confirmed = true;
    gate.nodeId = "n1";
    gate.markedSaved = [];
    gate.holdExport = false;
    gate.releaseExport = null;
  });

  it("writes the audio the queued commit produces, not the one it replaces", async () => {
    const { files } = makeStore();
    openTestFile("/audio/a.wav");
    openFiles[FILE_ID].audioBuffer = audioBuffer([1]);

    // The commit tail of a stroke released a moment ago.
    let releaseCommit: (() => void) | null = null;
    const commit = serializeFileTask(FILE_ID, async () => {
      await new Promise<void>((resolve) => (releaseCommit = resolve));
      openFiles[FILE_ID].audioBuffer = audioBuffer([2]);
    });

    const saving = files.saveActiveFile();
    await vi.waitFor(() => expect(releaseCommit).not.toBeNull());
    releaseCommit!();
    await commit;
    await saving;

    expect(gate.exported).toHaveLength(1);
    expect(Array.from(gate.exported[0].channels[0])).toEqual([2]);
  });

  it("marks the node it exported, not one a stroke adds during the write", async () => {
    const { files } = makeStore();
    openTestFile("/audio/a.wav");
    openFiles[FILE_ID].audioBuffer = audioBuffer([1]);

    gate.nodeId = "before";
    gate.holdExport = true;

    const saving = files.saveActiveFile();
    await vi.waitFor(() => expect(gate.releaseExport).not.toBeNull());

    // A stroke commits while the write is still in flight.
    gate.nodeId = "after";
    gate.releaseExport!();
    await saving;

    expect(gate.markedSaved).toEqual(["before"]);
  });
});

describe("saving while a synthesis is still running", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.synthesize = [];
    gate.exported = [];
    gate.confirmed = true;
    gate.nodeId = "n1";
    gate.markedSaved = [];
    gate.holdExport = false;
  });

  it("exports the audio the running synthesis produces, not the one it replaces", async () => {
    const applySynthesizedAudio = vi.fn(async () => {
      openFiles[FILE_ID].audioBuffer = audioBuffer([2]);
    });
    const { files } = makeStore({ applySynthesizedAudio } as unknown as Partial<State>);
    openTestFile("/audio/a.wav");
    openFiles[FILE_ID].audioBuffer = audioBuffer([1]);

    // History navigation moves the node and then starts synthesis off the queue.
    const synthesis = files.synthesizeFile(FILE_ID);
    await vi.waitFor(() => expect(gate.synthesize).toHaveLength(1));
    gate.nodeId = "undone";

    const saving = files.saveActiveFile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate.exported).toHaveLength(0);

    gate.synthesize[0](synthResult(2));
    await synthesis;
    await saving;

    expect(gate.exported).toHaveLength(1);
    expect(Array.from(gate.exported[0].channels[0])).toEqual([2]);
    expect(gate.markedSaved).toEqual(["undone"]);
  });
});

describe("re-analysing while a stroke is still committing", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.order = [];
  });

  it("waits for the queued commit before it replaces the analysis", async () => {
    const { files } = makeStore();
    openTestFile("/audio/a.wav");
    openFiles[FILE_ID].audioBuffer = audioBuffer([1]);

    let releaseCommit: (() => void) | null = null;
    const commit = serializeFileTask(FILE_ID, async () => {
      await new Promise<void>((resolve) => (releaseCommit = resolve));
      gate.order.push("commit");
    });

    const reanalysing = files.reanalyzeFile(FILE_ID, 24);
    await vi.waitFor(() => expect(releaseCommit).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate.order).toEqual([]);

    releaseCommit!();
    await commit;
    await reanalysing;

    expect(gate.order).toEqual(["commit", "analyse", "snapshot"]);
  });
});

describe("draining the task queues at quit", () => {
  it("resolves only after the work already queued has run", async () => {
    let release: (() => void) | null = null;
    let ran = false;
    const task = serializeFileTask("quit-file", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      ran = true;
    });

    const drained = drainFileTaskQueues().then(() => ran);
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(ran).toBe(false);

    release!();
    await task;
    expect(await drained).toBe(true);
  });
});

describe("closing a file other brushes read from", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.confirmed = true;
    gate.declineTitles = [];
  });

  function brushReferencing(path: string): Brush {
    return {
      name: "B",
      linkedParams: [],
      macroValues: [],
      steps: [{ sourceFile: { path, name: "src.wav" } }],
    } as unknown as Brush;
  }

  it("unsets the references the confirmation undertook to remove", async () => {
    const brushes = [brushReferencing("/audio/src.wav")];
    const { get, files } = makeStore({ brushes } as unknown as Partial<State>);
    openTestFile("/audio/src.wav");

    await files.tryCloseFile(FILE_ID);

    // Left set, the next stroke finds no open file at the path and silently
    // samples the destination instead.
    expect(get().brushes[0].steps[0].sourceFile).toBeNull();
    expect(openFiles[FILE_ID]).toBeUndefined();
  });

  it("keeps the references when the close is cancelled", async () => {
    gate.confirmed = false;
    const brushes = [brushReferencing("/audio/src.wav")];
    const { get, files } = makeStore({ brushes } as unknown as Partial<State>);
    openTestFile("/audio/src.wav");

    await files.tryCloseFile(FILE_ID);

    expect(get().brushes[0].steps[0].sourceFile).toEqual({ path: "/audio/src.wav", name: "src.wav" });
    expect(openFiles[FILE_ID]).toBeDefined();
  });

  it("keeps the references when the unsaved-changes prompt is cancelled", async () => {
    gate.declineTitles = ["Unsaved Changes"];
    const brushes = [brushReferencing("/audio/src.wav")];
    const { get, files } = makeStore({
      brushes,
      filesDirty: { [FILE_ID]: true },
    } as unknown as Partial<State>);
    openTestFile("/audio/src.wav");

    await files.tryCloseFile(FILE_ID);

    expect(get().brushes[0].steps[0].sourceFile).toEqual({ path: "/audio/src.wav", name: "src.wav" });
    expect(openFiles[FILE_ID]).toBeDefined();
  });

  it("leaves references to other files alone", () => {
    const brushes = [brushReferencing("/audio/keep.wav")];
    clearFileReferences("/audio/src.wav", brushes);
    expect(brushes[0].steps[0].sourceFile).toEqual({ path: "/audio/keep.wav", name: "src.wav" });
  });
});
