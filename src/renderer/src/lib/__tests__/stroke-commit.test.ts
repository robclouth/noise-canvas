import { describe, expect, it } from "vitest";

import { applyCoefficientPatch } from "../coef-patch";
import {
  buildStrokeCommitSnapshot,
  commitStrokeOf,
  commitWindowOf,
  projectsWholeFile,
  type DirtyRegionUv,
  type FootprintUv,
  type StrokeCommitRenderer,
  type StrokeCommitSnapshot,
} from "../stroke-commit";
import type { SpectrogramData, State } from "@renderer/store/types";

const SR = 48000;
const NUM_FRAMES = SR * 4;
const NUM_BANDS = 8;

function makeSpec(): SpectrogramData {
  const bandOffsets: number[] = [];
  const bandLengths: number[] = [];
  const bandStepLog2s: number[] = [];
  let offset = 0;
  for (let b = 0; b < NUM_BANDS; b++) {
    const step = b; // coarser strides as the band index rises
    const length = Math.max(1, NUM_FRAMES >> step);
    bandOffsets.push(offset);
    bandLengths.push(length);
    bandStepLog2s.push(step);
    offset += length;
  }
  return {
    numFrames: NUM_FRAMES,
    numBands: NUM_BANDS,
    numChannels: 1,
    sampleRate: SR,
    minFreq: 27.5,
    bandsPerOctave: 36,
    textureWidth: 64,
    textureHeight: 64,
    synthesisMetadata: { bandOffsets, bandLengths, bandStepLog2s, bandFreqs: [] },
  } as unknown as SpectrogramData;
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    brushes: [{ name: "Test", steps: [{}] }],
    activeBrushIndex: 0,
    activeStepIndex: 0,
    brushCurveTime: 100,
    brushSkewTime: -100,
    brushWrapMode: 0,
    limiterEnabled: false,
    reanalyzeStrokes: false,
    ...overrides,
  } as unknown as State;
}

function makeRenderer(overrides: Partial<Record<string, unknown>> = {}): StrokeCommitRenderer & { consumed: number } {
  const state = {
    consumed: 0,
    region: { startX: 0.25, endX: 0.5, startY: 0.2, endY: 0.8 } as DirtyRegionUv | null,
    ranges: new Uint32Array([10, 4]),
    footprint: { timeMin: 0.25, timeMax: 0.5, pitchMin: 0.2, pitchMax: 0.8 } as FootprintUv | null,
    generation: 3,
    ...overrides,
  };
  return {
    get consumed() {
      return state.consumed;
    },
    consumeDirtyRegion: () => {
      state.consumed++;
      const region = state.region;
      state.region = null;
      return region;
    },
    getDirtyPixelRanges: () => state.ranges,
    getCommittedFootprintUv: () => state.footprint,
    getStrokeGeneration: () => state.generation,
  } as StrokeCommitRenderer & { consumed: number };
}

function makeSnapshot(overrides: Partial<StrokeCommitSnapshot> = {}): StrokeCommitSnapshot {
  return {
    ...buildStrokeCommitSnapshot({
      renderer: makeRenderer(),
      state: makeState(),
      spec: makeSpec(),
      brushName: "Test",
      autoPlaybackParams: null,
    }),
    ...overrides,
  };
}

describe("stroke commit snapshot", () => {
  it("takes the dirty region away from the renderer, so only this commit owns it", () => {
    const renderer = makeRenderer();
    const first = buildStrokeCommitSnapshot({
      renderer,
      state: makeState(),
      spec: makeSpec(),
      brushName: "Test",
      autoPlaybackParams: null,
    });
    expect(first.dirtyRegion).toEqual({ startX: 0.25, endX: 0.5, startY: 0.2, endY: 0.8 });

    // Dabs painted after the snapshot accumulate into a fresh region; this one
    // is gone, so a second commit cannot synthesise it twice.
    const second = buildStrokeCommitSnapshot({
      renderer,
      state: makeState(),
      spec: makeSpec(),
      brushName: "Test",
      autoPlaybackParams: null,
    });
    expect(second.dirtyRegion).toBeNull();
  });

  it("captures the re-analyse toggle at mouse-up", () => {
    const snapshot = buildStrokeCommitSnapshot({
      renderer: makeRenderer(),
      state: makeState({ reanalyzeStrokes: true } as unknown as Partial<State>),
      spec: makeSpec(),
      brushName: "Test",
      autoPlaybackParams: null,
    });
    expect(snapshot.reanalyzeEnabled).toBe(true);
  });

  it("carries the file's unprojected paint, and reads false without one", () => {
    const built = (hasUnprojectedPaint?: boolean): boolean =>
      buildStrokeCommitSnapshot({
        renderer: makeRenderer(),
        state: makeState(),
        spec: makeSpec(),
        brushName: "Test",
        autoPlaybackParams: null,
        hasUnprojectedPaint,
      }).hasUnprojectedPaint;
    expect(built(true)).toBe(true);
    expect(built()).toBe(false);
  });

  it("prefers the active step's envelope parameters over the globals", () => {
    const state = makeState({
      brushes: [{ name: "Test", steps: [{ brushCurveTime: 10, brushSkewTime: 40, brushWrapMode: 1 }] }],
    } as unknown as Partial<State>);
    const snapshot = buildStrokeCommitSnapshot({
      renderer: makeRenderer(),
      state,
      spec: makeSpec(),
      brushName: "Test",
      autoPlaybackParams: null,
    });
    expect(snapshot.curveTime).toBe(10);
    expect(snapshot.wrapMode).toBe(1);
  });
});

describe("commit window", () => {
  it("maps the dirty region to frames, and inverts the pitch axis", () => {
    const spec = makeSpec();
    const window = commitWindowOf(makeSnapshot({ spec }));
    expect(window).not.toBeNull();
    expect(window?.startFrame).toBe(Math.floor(0.25 * NUM_FRAMES));
    expect(window?.endFrame).toBe(Math.ceil(0.5 * NUM_FRAMES));
    // UV Y=0 is the top of the picture, which is the highest band.
    expect(window?.startBand).toBe(Math.floor((1 - 0.8) * NUM_BANDS));
    expect(window?.endBand).toBe(Math.ceil((1 - 0.2) * NUM_BANDS));
  });

  it("is null when the stroke changed nothing", () => {
    expect(commitWindowOf(makeSnapshot({ dirtyRegion: null }))).toBeNull();
  });

  it("is null for the first re-analysing stroke after paint that was never projected", () => {
    const snapshot = makeSnapshot({ reanalyzeEnabled: true, hasUnprojectedPaint: true });
    expect(projectsWholeFile(snapshot)).toBe(true);
    expect(commitWindowOf(snapshot)).toBeNull();
  });

  it("keeps the stroke's window once the file holds nothing unprojected", () => {
    const snapshot = makeSnapshot({ reanalyzeEnabled: true, hasUnprojectedPaint: false });
    expect(projectsWholeFile(snapshot)).toBe(false);
    expect(commitWindowOf(snapshot)).not.toBeNull();
  });

  it("keeps the stroke's window while re-analyse is off, however much paint is unprojected", () => {
    const snapshot = makeSnapshot({ reanalyzeEnabled: false, hasUnprojectedPaint: true });
    expect(projectsWholeFile(snapshot)).toBe(false);
    expect(commitWindowOf(snapshot)).not.toBeNull();
  });
});

describe("commit stroke request", () => {
  it("calls a rectangular envelope's edges hard, and a soft one's not", () => {
    expect(commitStrokeOf(makeSnapshot({ curveTime: 100 }), false).hardEdgeStart).toBe(true);
    expect(commitStrokeOf(makeSnapshot({ curveTime: 100 }), false).hardEdgeEnd).toBe(true);
    expect(commitStrokeOf(makeSnapshot({ curveTime: 40 }), false).hardEdgeStart).toBe(false);
  });

  it("has no hard edges when the footprint wraps the time axis", () => {
    for (const wrapMode of [1, 3]) {
      const stroke = commitStrokeOf(makeSnapshot({ wrapMode }), false);
      expect(stroke.hardEdgeStart).toBe(false);
      expect(stroke.hardEdgeEnd).toBe(false);
    }
  });

  it("has no hard edge where the footprint sits on a file boundary", () => {
    const spec = makeSpec();
    const snapshot = makeSnapshot({ spec, footprintUv: { timeMin: 0, timeMax: 1, pitchMin: 0, pitchMax: 1 } });
    const stroke = commitStrokeOf(snapshot, false);
    expect(stroke.hardEdgeStart).toBe(false);
    expect(stroke.hardEdgeEnd).toBe(false);
  });

  it("passes the limiter toggle straight through", () => {
    expect(commitStrokeOf(makeSnapshot(), true).applyLimiter).toBe(true);
    expect(commitStrokeOf(makeSnapshot(), false).applyLimiter).toBe(false);
  });

  it("asks for the projection only when re-analyse is on", () => {
    expect(commitStrokeOf(makeSnapshot({ reanalyzeEnabled: true }), false).project).toBe(true);
    expect(commitStrokeOf(makeSnapshot({ reanalyzeEnabled: false }), false).project).toBe(false);
  });
});

describe("coefficient patch", () => {
  it("writes each band's run where the band layout puts it, and reports its reach", () => {
    const spec = makeSpec();
    const { bandOffsets, bandStepLog2s } = spec.synthesisMetadata;
    const totalPixels = bandOffsets[NUM_BANDS - 1] + 1;
    const data = new Float32Array(totalPixels * 4);

    // Two bands, two coefficients each.
    const ranges = new Uint32Array([2, 5, 2, 4, 1, 2]);
    const pixels = new Float32Array([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8, // band 2, k=5 and k=6
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16, // band 4, k=1 and k=2
    ]);

    const extent = applyCoefficientPatch(data, { ranges, pixels }, bandOffsets, bandStepLog2s);
    expect(extent).not.toBeNull();

    const at = (band: number, k: number): number[] =>
      Array.from(data.subarray((bandOffsets[band] + k) * 4, (bandOffsets[band] + k) * 4 + 4));
    expect(at(2, 5)).toEqual([1, 2, 3, 4]);
    expect(at(2, 6)).toEqual([5, 6, 7, 8]);
    expect(at(4, 1)).toEqual([9, 10, 11, 12]);
    expect(at(4, 2)).toEqual([13, 14, 15, 16]);
    // Nothing else moved.
    expect(at(2, 4)).toEqual([0, 0, 0, 0]);
    expect(at(4, 3)).toEqual([0, 0, 0, 0]);

    expect(Array.from(extent!.pixelRanges)).toEqual([bandOffsets[2] + 5, 2, bandOffsets[4] + 1, 2]);
    expect(extent!.minBand).toBe(2);
    expect(extent!.maxBand).toBe(4);
    // Frames come from each band's own stride.
    expect(extent!.minFrame).toBe(Math.min(5 << bandStepLog2s[2], 1 << bandStepLog2s[4]));
    expect(extent!.maxFrame).toBe(Math.max(7 << bandStepLog2s[2], 3 << bandStepLog2s[4]));
  });

  it("computes the extent without writing when the patch carries no pixels", () => {
    const spec = makeSpec();
    const { bandOffsets, bandStepLog2s } = spec.synthesisMetadata;
    const totalPixels = bandOffsets[NUM_BANDS - 1] + 1;
    const data = new Float32Array(totalPixels * 4).fill(7);

    const ranges = new Uint32Array([2, 5, 2, 4, 1, 2]);
    const extent = applyCoefficientPatch(data, { ranges }, bandOffsets, bandStepLog2s);

    expect(data.every((v) => v === 7)).toBe(true);
    expect(Array.from(extent!.pixelRanges)).toEqual([bandOffsets[2] + 5, 2, bandOffsets[4] + 1, 2]);
    expect(extent!.minBand).toBe(2);
    expect(extent!.maxBand).toBe(4);
  });

  it("reports nothing for an empty patch", () => {
    const spec = makeSpec();
    const data = new Float32Array(16);
    const patch = { ranges: new Uint32Array(0), pixels: new Float32Array(0) };
    expect(
      applyCoefficientPatch(data, patch, spec.synthesisMetadata.bandOffsets, spec.synthesisMetadata.bandStepLog2s),
    ).toBeNull();
  });
});
