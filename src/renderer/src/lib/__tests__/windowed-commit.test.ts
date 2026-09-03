import { beforeEach, describe, expect, it, vi } from "vitest";

// The committed state the block store holds, and the packed buffers the addon
// was handed.
const gate = vi.hoisted(() => ({
  stored: null as Float32Array | null,
  committed: [] as Float32Array[],
}));

vi.mock("@renderer/effects", () => ({ effects: {} }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openInsertSilencePrompt: vi.fn(),
  openSetLengthPrompt: vi.fn(),
  openGroupFilesPrompt: vi.fn(),
}));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn(() => ({
    getCurrentId: () => "n1",
    awaitPackedReaders: vi.fn(async () => {}),
    currentRanges: vi.fn(async () => null),
    currentBlockState: vi.fn(async () => (gate.stored ? Float32Array.from(gate.stored) : null)),
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
    analysis: {
      getGpuMemoryInfo: () => ({ bytes: 8 * 1024 ** 3, unified: true }),
      commitStroke: async (packed: Float32Array) => {
        gate.committed.push(Float32Array.from(packed));
        return {
          channels: [new Float32Array(SAMPLES)],
          peak: 1,
          patch: { ranges: new Uint32Array(0) },
          gainReductionDb: new Float32Array(0),
          maxGainReductionDb: 0,
          audioWindow: { start: 0, end: SAMPLES },
          tail: {
            pixelStarts: new Uint32Array(0),
            pixelCounts: new Uint32Array(0),
            offsets: new Float32Array(0),
            residuals: new Uint32Array(0),
          },
          levels: { startHop: 0, peaks: new Float32Array(0), overDb: new Float32Array(0) },
        };
      },
    },
  },
}));

import { createFilesSlice, openFiles, type CommitSource } from "../../store/files";
import { createBrushSlice } from "../../store/brush";
import type { StrokeCommitSnapshot } from "../stroke-commit";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

const FILE_ID = "f1";
const NUM_BANDS = 4;
const TEXELS = 64;
const SAMPLES = 64;

/** The stroke's own pixels: two texels, every channel set to a distinct value. */
const PAINTED_RANGES = Uint32Array.from([4, 2]);
const PAINTED_VALUES = Float32Array.from([9, 8, 7, 6, 5, 4, 3, 2]);

function storedState(): Float32Array {
  return new Float32Array(TEXELS * 4).fill(1);
}

/** What the store's state looks like once the stroke's pixels are written over it. */
function expectedWhole(): Float32Array {
  const whole = storedState();
  whole.set(PAINTED_VALUES, PAINTED_RANGES[0] * 4);
  return whole;
}

function spectrogram() {
  return {
    numFrames: 64,
    numChannels: 1,
    numBands: NUM_BANDS,
    sampleRate: 48000,
    bandsPerOctave: 12,
    minFreq: 20,
    textureWidth: 8,
    textureHeight: 8,
    metadata: new Float32Array(NUM_BANDS * 4),
    synthesisMetadata: {
      bandOffsets: new Uint32Array(NUM_BANDS),
      bandStepLog2s: new Int32Array(NUM_BANDS),
      bandLengths: new Uint32Array(NUM_BANDS),
    },
  };
}

function audioBuffer() {
  return {
    numberOfChannels: 1,
    sampleRate: 48000,
    length: SAMPLES,
    getChannelData: () => new Float32Array(SAMPLES),
  } as unknown as AudioBuffer;
}

/** An open file whose canvas holds a window, so it cannot read the whole state. */
function openWindowedFile(renderer: Record<string, unknown> = {}) {
  openFiles[FILE_ID] = {
    id: FILE_ID,
    filePath: "/audio/a.wav",
    displayName: "a.wav",
    spectrogramData: spectrogram(),
    audioBuffer: audioBuffer(),
    unprojectedPaint: true,
    rendererRef: {
      current: {
        getFBOData: async () => null,
        readPixelRanges: async () => Float32Array.from(PAINTED_VALUES),
        ...renderer,
      },
    },
  } as unknown as (typeof openFiles)[string];
}

function makeStore(overrides: Partial<State> = {}) {
  let state: State;
  const set: ZustandSet = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  };
  const get: ZustandGet = () => state;

  const files = createFilesSlice(set, get);
  const brush = createBrushSlice(set, get);
  state = {
    ...files,
    ...brush,
    activeFileId: FILE_ID,
    applySynthesizedAudio: vi.fn(async () => null),
    autoPlayStroke: false,
    brushes: [{ steps: [{}] }],
    activeBrushIndex: 0,
    activeStepIndex: 0,
    brushAnchorMode: 0,
    brushCurveTime: 0,
    brushWrapMode: 0,
    brushSizeTime: 4,
    brushSizePitch: 4,
    gridSizeBeats: 1,
    gridSizeSemis: 1,
    gridSwing: 0,
    snapTime: false,
    filepathsBpm: {},
    limiterEnabled: false,
    reanalyzeStrokes: true,
    isPlaying: false,
    ...overrides,
  } as unknown as State;

  return { get, files, brush };
}

/** A stroke that rebuilds the whole file, so the commit needs all of the state. */
function wholeFileSnapshot(): StrokeCommitSnapshot {
  const spec = spectrogram();
  return {
    dirtyRegion: { startX: 0, endX: 0.25, startY: 0, endY: 1 },
    dirtyRanges: Uint32Array.from(PAINTED_RANGES),
    footprintUv: null,
    strokeGeneration: 0,
    curveTime: 0,
    wrapMode: 0,
    limiterEnabled: false,
    reanalyzeEnabled: true,
    hasUnprojectedPaint: true,
    spec,
    dimensions: {
      textureWidth: spec.textureWidth,
      textureHeight: spec.textureHeight,
      numFrames: spec.numFrames,
      numBands: spec.numBands,
      numChannels: spec.numChannels,
      sampleRate: spec.sampleRate,
      minFreq: spec.minFreq,
      bandsPerOctave: spec.bandsPerOctave,
    },
    brushName: "Stroke",
    autoPlaybackParams: null,
  } as unknown as StrokeCommitSnapshot;
}

function firstDifference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe("a commit whose canvas holds a window", () => {
  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.stored = storedState();
    gate.committed = [];
  });

  it("takes the whole state from the block store when the canvas cannot serve it", async () => {
    const { files } = makeStore();
    openWindowedFile();

    const source: CommitSource = {
      data: null,
      footprint: { ranges: Uint32Array.from(PAINTED_RANGES), values: Float32Array.from(PAINTED_VALUES) },
    };
    const outcome = await files.commitStroke(FILE_ID, wholeFileSnapshot(), source);

    expect(outcome).not.toBeNull();
    expect(gate.committed).toHaveLength(1);
    expect(firstDifference(gate.committed[0], expectedWhole())).toBe(-1);
  });

  it("gives up rather than commit a picture the store cannot serve either", async () => {
    gate.stored = null;
    const { files } = makeStore();
    openWindowedFile();

    await expect(files.commitStroke(FILE_ID, wholeFileSnapshot(), { data: null, footprint: null })).rejects.toThrow(
      /could not read the canvas/,
    );
  });

  it("hands the stroke a whole picture built from the store and its own pixels", async () => {
    let taken: CommitSource | null = null;
    const commitStroke = vi.fn(async (_id: string, _snapshot: StrokeCommitSnapshot, source: CommitSource) => {
      taken = source;
      return null;
    });
    const { brush } = makeStore({ commitStroke } as unknown as Partial<State>);
    openWindowedFile({
      consumeDirtyRegion: () => ({ startX: 0, endX: 0.25, startY: 0, endY: 1 }),
      getDirtyPixelRanges: () => Uint32Array.from(PAINTED_RANGES),
      getCommittedFootprintUv: () => null,
      getStrokeGeneration: () => 0,
    });

    await brush.applyStrokeAtPosition({ beats: 0, pitch: 0 }, undefined, "Stroke", false);

    expect(commitStroke).toHaveBeenCalledTimes(1);
    const data = (taken as CommitSource | null)?.data;
    expect(data).toBeInstanceOf(Float32Array);
    expect(firstDifference(data as Float32Array, expectedWhole())).toBe(-1);
  });

  it("paints nothing rather than commit a whole picture it cannot build", async () => {
    gate.stored = null;
    const commitStroke = vi.fn(async () => null);
    const { brush } = makeStore({ commitStroke } as unknown as Partial<State>);
    openWindowedFile({
      consumeDirtyRegion: () => ({ startX: 0, endX: 0.25, startY: 0, endY: 1 }),
      getDirtyPixelRanges: () => Uint32Array.from(PAINTED_RANGES),
      getCommittedFootprintUv: () => null,
      getStrokeGeneration: () => 0,
    });

    await brush.applyStrokeAtPosition({ beats: 0, pitch: 0 }, undefined, "Stroke", false);

    expect(commitStroke).not.toHaveBeenCalled();
  });
});
