import { beforeEach, describe, expect, it, vi } from "vitest";

// The committed state the block store holds, and the packed buffers the addon
// was handed.
const gate = vi.hoisted(() => ({
  stored: null as Float32Array | null,
  committed: [] as Float32Array[],
  readRanges: null as ((ranges: Uint32Array) => Float32Array) | null,
  prepared: [] as { base: Float32Array; baseRanges: Uint32Array; after: Float32Array; ranges: Uint32Array }[],
  calls: [] as { layout: PackedLayout; window: CommitWindow; stroke: CommitStroke }[],
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
  releaseHistoryManager: vi.fn(async () => {}),
  destroyHistoryManager: vi.fn(async () => {}),
  getHistoryManager: vi.fn(() => ({
    getCurrentId: () => "n1",
    movedOnlyByStrokes: (id: string | null) => id === "n1",
    awaitPackedReaders: vi.fn(async () => {}),
    currentRanges: vi.fn(async (ranges: Uint32Array) => gate.readRanges?.(ranges) ?? null),
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
      commitStroke: async (
        packed: Float32Array,
        layout: PackedLayout,
        _sampleRate: number,
        _params: unknown,
        _audio: Float32Array[],
        window: CommitWindow,
        stroke: CommitStroke,
      ) => {
        gate.committed.push(Float32Array.from(packed));
        gate.calls.push({ layout, window, stroke });
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
      prepareHistoryDelta: async (
        base: Float32Array,
        baseRanges: Uint32Array,
        after: Float32Array,
        ranges: Uint32Array,
      ) => {
        gate.prepared.push({ base: Float32Array.from(base), baseRanges, after, ranges });
        return { changed: true, bytes: Promise.resolve(new Uint8Array(0)) };
      },
    },
  },
}));

import { createFilesSlice, openFiles, type CommitSource } from "../../store/files";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { gatherPixelRanges, scatterCompactPixelRanges } from "../pixel-ranges";
import { createBrushSlice } from "../../store/brush";
import type { StrokeCommitSnapshot } from "../stroke-commit";
import type { CommitStroke, CommitWindow, PackedLayout } from "../../../../main/lib/types";
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
        holdPaint: () => async () => {},
        forgetBlocks: () => {},
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
      /could not read the committed state/,
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

describe("a commit over a view of the file", () => {
  const long = {
    ...createConstantQMockSpectrogramData({ durationSeconds: 40, sampleRate: 4000, bandsPerOctave: 6 }),
    numChannels: 1,
  };
  const layout = long.synthesisMetadata;
  const band = Math.floor(long.numBands / 2);
  const k0 = Math.floor((0.52 * long.numFrames) / (1 << layout.bandStepLog2s[band]));
  const painted = Uint32Array.of(layout.bandOffsets[band] + k0, 3);
  const paintedValues = Float32Array.from({ length: 12 }, (_, i) => -1 - i);
  const stored = Float32Array.from({ length: long.texels * 4 }, (_, i) => i * 0.25);

  function openLongFile(): void {
    openFiles[FILE_ID] = {
      id: FILE_ID,
      filePath: "/audio/long.wav",
      displayName: "long.wav",
      spectrogramData: long,
      audioBuffer: audioBuffer(),
      unprojectedPaint: false,
      onsets: [],
      onsetReference: { odfMax: 1, bandMax: new Float32Array(long.numBands) },
      rendererRef: { current: {} },
    } as unknown as (typeof openFiles)[string];
  }

  function viewSnapshot(reanalyzeEnabled: boolean): StrokeCommitSnapshot {
    return {
      ...wholeFileSnapshot(),
      dirtyRegion: { startX: 0.5, endX: 0.55, startY: 0, endY: 1 },
      dirtyRanges: painted,
      reanalyzeEnabled,
      hasUnprojectedPaint: false,
      spec: long,
    } as StrokeCommitSnapshot;
  }

  beforeEach(() => {
    for (const id of Object.keys(openFiles)) delete openFiles[id];
    gate.stored = stored;
    gate.committed = [];
    gate.prepared = [];
    gate.calls = [];
    gate.readRanges = (ranges) => gatherPixelRanges(stored, ranges);
  });

  it("commits a brush that wraps across the end on a view of each end, the last first, as one outcome", async () => {
    const { files } = makeStore();
    openLongFile();
    const step = 1 << layout.bandStepLog2s[band];
    const kEnd = Math.floor((long.numFrames - 2000) / step);
    const ends = Uint32Array.of(layout.bandOffsets[band], 3, layout.bandOffsets[band] + kEnd, 3);
    const endValues = Float32Array.from({ length: 24 }, (_, i) => -1 - i);
    const snapshot = {
      ...viewSnapshot(false),
      dirtyRegion: { startX: 0, endX: 1, startY: 0, endY: 1 },
      dirtyRanges: ends,
      wrapMode: 3,
      footprintUv: { timeMin: 0, timeMax: 1, pitchMin: 0, pitchMax: 1 },
    } as StrokeCommitSnapshot;

    const outcome = await files.commitStroke(FILE_ID, snapshot, {
      data: null,
      footprint: { ranges: ends, values: Promise.resolve(endValues) },
    });

    expect(gate.calls).toHaveLength(2);
    const [last, first] = gate.calls;
    expect(last.window.startFrame).toBeGreaterThan(first.window.endFrame);
    expect(first.window.startFrame).toBe(0);
    expect(last.window.endFrame).toBe((kEnd + 3) * step);
    for (const call of gate.calls) {
      expect(call.layout.viewStartFrame).toBeDefined();
      expect(call.stroke.footStartFrame).toBe(call.window.startFrame);
      expect(call.stroke.footEndFrame).toBe(call.window.endFrame);
    }
    expect((last.layout.viewEndFrame ?? 0) - (last.layout.viewStartFrame ?? 0)).toBeLessThan(long.numFrames / 2);
    expect(outcome?.audioHops).toHaveLength(2);
    expect(outcome?.view).toBeNull();
    expect(outcome?.preparedDelta).toBeNull();
    expect(gate.prepared).toHaveLength(0);
    expect(firstDifference(outcome!.baseFootprint!, gatherPixelRanges(stored, ends))).toBe(-1);
  });

  it("cuts the delta from the view as the store held it, then hands the addon the view with the stroke over it", async () => {
    const { files } = makeStore();
    openLongFile();

    const outcome = await files.commitStroke(FILE_ID, viewSnapshot(false), {
      data: null,
      footprint: { ranges: painted, values: Promise.resolve(paintedValues) },
    });

    const view = outcome?.view;
    expect(view).toBeTruthy();
    expect(outcome?.preparedDelta?.ranges).toBe(painted);
    expect(outcome?.baseFootprint).toBeNull();
    expect(gate.prepared).toHaveLength(1);
    const [prepared] = gate.prepared;
    expect(prepared.baseRanges).toBe(view!.ranges);
    expect(firstDifference(prepared.base, gatherPixelRanges(stored, view!.ranges))).toBe(-1);
    expect(firstDifference(prepared.after, paintedValues)).toBe(-1);
    const whole = Float32Array.from(stored);
    scatterCompactPixelRanges(whole, paintedValues, painted);
    expect(firstDifference(gate.committed[0], gatherPixelRanges(whole, view!.ranges))).toBe(-1);
  });

  it("keeps the footprint's old values instead when a projection may widen the delta", async () => {
    const { files } = makeStore();
    openLongFile();

    const outcome = await files.commitStroke(FILE_ID, viewSnapshot(true), {
      data: null,
      footprint: { ranges: painted, values: Promise.resolve(paintedValues) },
    });

    expect(outcome?.view).toBeTruthy();
    expect(outcome?.preparedDelta).toBeNull();
    expect(gate.prepared).toHaveLength(0);
    expect(firstDifference(outcome!.baseFootprint!, gatherPixelRanges(stored, painted))).toBe(-1);
  });
});
