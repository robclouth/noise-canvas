import { createElement, createRef } from "react";
import { createRoot, extend } from "@react-three/fiber";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileRendererHandle } from "../../components/file-renderer";
import type { State } from "../../store/types";
import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { gatherPixelRanges, scatterCompactPixelRanges } from "../pixel-ranges";
import { strokeReach } from "../effect-reach";
import { StrokeRenderer } from "../stroke-renderer";
import { BRUSH_SIZE_TIME_FULL, BRUSH_SIZE_PITCH_FULL, snapToSwungGridCenter, uvToUnits } from "../utils";
import { WindowedCanvas } from "../windowed-canvas";

vi.mock("../gpu-budget", async (original) => ({
  ...(await original<typeof import("../gpu-budget")>()),
  canvasWindowBlocks: () => windowBlocks,
}));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(),
  deriveSideData: vi.fn(async () => ({ inverseMap: inverseSeed })),
  historyMemoryCacheBytes: () => ({ deltas: 0, audioHops: 0 }),
  getHistoryManager: () => ({
    initialize: async () => true,
    currentBlockState: async () => currentSeed ?? seed,
    getManifest: () => ({ currentId: "edited" }),
    nearestFullAnchor: () => ({ id: "root" }),
    isCurrentAudioCached: () => true,
    currentRanges: async (ranges: Uint32Array) => gatherPixelRanges(seed, ranges),
    rootRanges: async (ranges: Uint32Array) => gatherPixelRanges(seed, ranges),
    currentBlock: async (index: number) => {
      const list = blockPixelRanges(grid, index);
      return gatherPixelRanges(seed, list.ranges.subarray(0, list.count * 2));
    },
    restoreCurrentAudio: async () => {},
  }),
}));

let windowBlocks = 2;
let seed: Float32Array;
let currentSeed: Float32Array | null = null;
let inverseSeed: Float32Array | undefined;
let grid: ReturnType<typeof blockGrid>;
const disposers: Array<() => void | Promise<void>> = [];
extend({ Mesh: THREE.Mesh, PlaneGeometry: THREE.PlaneGeometry });

afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  currentSeed = null;
  vi.restoreAllMocks();
});

async function mount(state: State, blocks: number, durationSeconds = 300) {
  windowBlocks = blocks;
  const w = window as unknown as Record<string, unknown>;
  const previous = { nodeOs: w.nodeOs, ipcRenderer: w.ipcRenderer, nodePath: w.nodePath };
  Object.assign(w, {
    nodeOs: { homedir: () => "/home", totalmem: () => 16 * 1024 ** 3 },
    ipcRenderer: { invoke: vi.fn(async () => undefined) },
    nodePath: { join: (...parts: string[]) => parts.join("/") },
  });
  disposers.push(() => {
    Object.assign(w, previous);
  });
  const [{ FileRenderer }, { useStore }, { openFiles }, { useTransientStore }] = await Promise.all([
    import("../../components/file-renderer"),
    import("../../store"),
    import("../../store/files"),
    import("../../store/transient"),
  ]);
  const initialState = useStore.getState();
  useStore.setState({
    ...state,
    activeFileId: "residency",
    pickingFileParam: null,
    filesZoom: { residency: 0 },
    filesOffset: { residency: 0 },
    filesSelection: {},
    filepathsBpm: {},
    filepathsOnsetSensitivity: {},
  });
  disposers.push(() => {
    useStore.setState(initialState, true);
  });
  const previousTransient = useTransientStore.getState();
  disposers.push(() => useTransientStore.setState(previousTransient, true));
  useTransientStore.setState({ cursorPosition: null, hoveredFile: null, cursorVisible: false });
  const data = createConstantQMockSpectrogramData({ durationSeconds, sampleRate: 800, bandsPerOctave: 1 });
  seed = data.packedData;
  inverseSeed = data.inverseMap;
  for (let i = 0; i < seed.length; i += 4) {
    seed[i] = 0.2;
    seed[i + 2] = 0.3;
  }
  grid = blockGrid(data, data.numFrames, data.sampleRate);
  const ref = createRef<FileRendererHandle>();
  openFiles.residency = {
    id: "residency",
    filePath: "/residency.wav",
    displayName: "residency.wav",
    spectrogramData: data,
    rendererRef: ref,
  };
  disposers.push(() => {
    delete openFiles.residency;
  });
  const element = document.createElement("canvas");
  const gl = new THREE.WebGLRenderer({ canvas: element });
  const root = createRoot(element);
  await root.configure({ gl, frameloop: "never", size: { width: 100, height: 100, top: 0, left: 0 } });
  const initializeSpy = vi.spyOn(WindowedCanvas.prototype, "initialize");
  const render = (parked: boolean) =>
    root.render(
      createElement(FileRenderer, {
        fileId: "residency",
        isLive: true,
        parked,
        snapshotCanvasRef: createRef<HTMLCanvasElement>(),
        ref,
      }),
    );
  const store = render(false);
  const unmount = async () => {
    root.unmount();
    await vi.waitFor(() => expect(ref.current).toBeNull());
  };
  disposers.push(unmount);
  const frame = () => store.getState().advance(performance.now());
  await vi.waitFor(() => {
    frame();
    expect(ref.current?.getTextures()).toBeTruthy();
  });
  const canvas = initializeSpy.mock.contexts.at(-1);
  if (!(canvas instanceof WindowedCanvas)) throw new Error("no initialised canvas");
  await vi.waitFor(() => expect(canvas.holdsView()).toBe(true));
  return {
    ref,
    data,
    frame,
    canvas,
    state: useStore.getState(),
    useTransientStore,
    unmount,
    render,
    file: openFiles.residency,
  };
}

function brush(anchor: number, gridSize = false, withReach = false, multiple = false): State {
  const steps: Array<{ name: string; overrides: Partial<TestBrushStep> }> = [
    {
      name: "Dab",
      overrides: {
        brushAnchorMode: anchor,
        brushSizeTime: gridSize ? 0 : 1,
        brushSizePitch: 36,
        sourcePositionMode: "follow",
        brushCurveTime: 100,
        brushCurvePitch: 100,
        effects: withReach
          ? [
              {
                id: "transform",
                effect: "transform",
                enabled: true,
                params: { transformShiftBeats: 0.25, transformEdgeMode: 1 },
              },
            ]
          : [{ id: "dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -6 } }],
      },
    },
  ];
  if (multiple)
    steps.push({ name: "Corner", overrides: { ...steps[0].overrides, brushAnchorMode: 0, brushSizeTime: 2 } });
  return createMockStateWithSteps(steps, { snapTime: gridSize, gridSizeBeats: 1, gridSwing: gridSize ? 50 : 0 });
}

describe("anchored dab residency", () => {
  it("holds the production union at a left window boundary", async () => {
    const rig = await mount(brush(1), 2);
    const canvas = rig.canvas!;
    canvas.aim(grid.blockFrames * 4, grid.blockFrames * 5);
    await vi.waitFor(() => expect(canvas.holdsFrames(grid.blockFrames * 4, grid.blockFrames * 5)).toBe(true));
    const view = canvas.span()!;
    const aim = (view.startFrame + 40) / rig.data.numFrames;
    const [beats, pitch] = uvToUnits(aim, 0.5, 120, 300, rig.data.bandsPerOctave, rig.data.numBands);
    rig.useTransientStore.setState({ cursorPosition: { beats, pitch }, cursorVisible: true });
    rig.frame();
    const material = rig.ref.current!.getDisplayMaterial()!;
    const origin = material.uniforms.brushBottomLeftUv.value as THREE.Vector2;
    const size = material.uniforms.brushSizeUv.value as THREE.Vector2;
    const held = vi.spyOn(canvas, "paintWhenHeld");
    const dispatch = vi.spyOn(StrokeRenderer.prototype, "renderStroke");
    expect(canvas.holdsFrames(origin.x * rig.data.numFrames, (origin.x + size.x) * rig.data.numFrames)).toBe(false);
    rig.ref.current!.beginStroke();
    rig.ref.current!.renderStrokeBatch([{ state: rig.state, aimX: aim, aimY: 0.5 }]);
    expect(held.mock.calls[0][0]).toBeCloseTo(origin.x * rig.data.numFrames, 6);
    expect(held.mock.calls[0][1]).toBeCloseTo((origin.x + size.x) * rig.data.numFrames, 6);
    expect(dispatch.mock.calls.length).toBe(0);
    await rig.ref.current!.settleStroke();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("aims, holds and dispatches one anchored span (effect reach: %s)", async (withReach) => {
    const state = brush(1, false, withReach);
    const rig = await mount(state, 2);
    const canvas = rig.canvas;
    const aim = (grid.blockFrames * 4 + 40) / rig.data.numFrames;
    const [beats, pitch] = uvToUnits(aim, 0.5, 120, 300, rig.data.bandsPerOctave, rig.data.numBands);
    rig.useTransientStore.setState({ cursorPosition: { beats, pitch }, cursorVisible: true });
    const aimed = vi.spyOn(canvas, "aim");
    const held = vi.spyOn(canvas, "paintWhenHeld");
    const holds = vi.spyOn(canvas, "holdsFrames");
    rig.ref.current!.beginStroke();
    rig.ref.current!.renderStroke(false);
    rig.frame();
    const material = rig.ref.current!.getDisplayMaterial()!;
    const origin = material.uniforms.brushBottomLeftUv.value as THREE.Vector2;
    const size = material.uniforms.brushSizeUv.value as THREE.Vector2;
    const reach = strokeReach(rig.state, {
      bpm: 120,
      fileSeconds: 300,
      canvasSeconds: canvas.windowSeconds(),
      bandsPerOctave: rig.data.bandsPerOctave,
      numBands: rig.data.numBands,
      responseSpan: () => null,
    });
    expect(reach.before > 0).toBe(withReach);
    const start = origin.x * rig.data.numFrames - reach.before * rig.data.sampleRate;
    const end = (origin.x + size.x) * rig.data.numFrames + reach.after * rig.data.sampleRate;
    expect(aimed.mock.calls[0][0]).toBeCloseTo(start, 6);
    expect(aimed.mock.calls[0][1]).toBeCloseTo(end, 6);
    expect(held.mock.calls[0].slice(0, 2)).toEqual(aimed.mock.calls[0].slice(0, 2));
    await rig.ref.current!.settleStroke();
    expect(holds.mock.calls.at(-1)).toEqual([...held.mock.calls[0].slice(0, 2), false]);
  });

  it.each([
    { name: "centre at the left edge", anchor: 1, right: false, gridSize: false, multiple: false },
    { name: "centre at the right edge", anchor: 1, right: true, gridSize: false, multiple: false },
    { name: "corner at the left edge", anchor: 0, right: false, gridSize: false, multiple: false },
    { name: "corner at the right edge", anchor: 0, right: true, gridSize: false, multiple: false },
    { name: "swung grid at the left edge", anchor: 1, right: false, gridSize: true, multiple: false },
    { name: "snapped grid at the right edge", anchor: 1, right: true, gridSize: true, multiple: false },
    { name: "mixed steps at the left edge", anchor: 1, right: false, gridSize: false, multiple: true },
    { name: "mixed steps at the right edge", anchor: 1, right: true, gridSize: false, multiple: true },
  ])("commits whole-file coefficients for $name", async ({ anchor, right, gridSize, multiple }) => {
    const state = brush(anchor, gridSize, false, multiple);
    const rig = await mount(state, 2);
    const canvas = rig.canvas;
    canvas.aim(grid.blockFrames * 4, grid.blockFrames * 5);
    await vi.waitFor(() => expect(canvas.holdsFrames(grid.blockFrames * 4, grid.blockFrames * 5)).toBe(true));
    const view = canvas.span()!;
    const pointer = (right ? view.endFrame - 40 : view.startFrame + 40) / rig.data.numFrames;
    const aimX = gridSize && right ? snapToSwungGridCenter(pointer * 300, 0.5, state.gridSwing / 100) / 300 : pointer;
    const stroke = { state: rig.state, aimX, aimY: 0.5 };
    rig.ref.current!.beginStroke();
    expect(rig.ref.current!.renderStrokeBatch([stroke])).toBe(1);
    await rig.ref.current!.settleStroke();
    const actual = seed.slice();
    const ranges = rig.ref.current!.getDirtyPixelRanges()!;
    expect(ranges).not.toBeNull();
    scatterCompactPixelRanges(actual, await rig.ref.current!.readPixelRanges(ranges), ranges);
    await rig.unmount();

    const whole = await mount(state, Infinity);
    expect(whole.canvas.wholeFile).toBe(true);
    whole.ref.current!.beginStroke();
    expect(whole.ref.current!.renderStrokeBatch([{ ...stroke, state: whole.state }])).toBe(1);
    await whole.ref.current!.settleStroke();
    const expected = (await whole.ref.current!.getFBOData())!;
    let changed = 0;
    let different = 0;
    let maxError = 0;
    for (let i = 0; i < seed.length; i++) {
      if (Math.abs(expected[i] - seed[i]) > 1e-6) changed++;
      const error = Math.abs(actual[i] - expected[i]);
      if (error > 1e-6) different++;
      maxError = Math.max(maxError, error);
    }
    expect(changed).toBeGreaterThan(0);
    expect(different, `maximum coefficient error: ${maxError}`).toBe(0);
    expect(maxError).toBeLessThanOrEqual(1e-6);
  });
});

describe("pristine sampling after resume", () => {
  it("paints original coefficients after parking an edited whole-file canvas", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Original",
        overrides: {
          sourceDataMode: "original",
          sourcePositionMode: "follow",
          brushSizeTime: BRUSH_SIZE_TIME_FULL,
          brushSizePitch: BRUSH_SIZE_PITCH_FULL,
          effects: [{ id: "pass", effect: "passthrough", enabled: true, params: {} }],
        },
      },
    ]);
    const rig = await mount(state, Infinity, 8);
    expect(rig.canvas.wholeFile).toBe(true);
    const original = seed.slice();
    currentSeed = seed.slice();
    for (let i = 0; i < currentSeed.length; i += 4) {
      currentSeed[i] = 0.8;
      currentSeed[i + 2] = 0.9;
    }
    rig.ref.current!.setFBOData(currentSeed);
    rig.ref.current!.releaseAnalysisData();
    rig.render(true);
    await vi.waitFor(() => expect(rig.file.parked).toBe(true));
    expect(rig.ref.current!.getTextures()).toBeNull();
    rig.render(false);
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.ref.current!.getTextures()).not.toBeNull();
    });
    const resumed = (await rig.ref.current!.getFBOData())!;
    expect(resumed[0]).toBeCloseTo(0.8, 6);
    rig.ref.current!.beginStroke();
    expect(rig.ref.current!.renderStrokeBatch([{ state: rig.state, aimX: 0, aimY: 0 }])).toBe(1);
    await rig.ref.current!.settleStroke();
    const painted = (await rig.ref.current!.getFBOData())!;
    let mismatches = 0;
    let maxError = 0;
    for (let i = 0; i < original.length; i += 2) {
      const error = Math.abs(painted[i] - original[i]);
      if (error > 1e-6) mismatches++;
      maxError = Math.max(maxError, error);
    }
    expect(mismatches, `maximum Original sampling error: ${maxError}; first magnitude: ${painted[0]}`).toBe(0);
    expect(maxError).toBeLessThanOrEqual(1e-6);
  });
});
