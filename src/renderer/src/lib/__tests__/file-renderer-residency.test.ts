import { FileEngine } from "../file-engine";
import { AimRest } from "../canvas-window";
import {
  applyDisplayPyramidUniforms,
  prepareVisibleRegion,
  disposeDisplayResidency,
  type FileDisplayResidencyContext,
} from "../file-display-residency";
import { createElement, createRef } from "react";
import { createRoot, extend } from "@react-three/fiber";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewRendererHandle } from "../../components/view-renderer";
import type { FileRendererHandle } from "../file-renderer-types";
import type { State } from "../../store/types";
import { createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { gatherPixelRanges, gatherTaps, scatterCompactPixelRanges } from "../pixel-ranges";
import { strokeReach } from "../effect-reach";
import { StrokeRenderer } from "../stroke-renderer";
import { BRUSH_SIZE_TIME_FULL, BRUSH_SIZE_PITCH_FULL, snapToSwungGridCenter, uvToUnits } from "../utils";
import { WindowedCanvas } from "../windowed-canvas";
import { savedViewTransform, type ViewTransform } from "../view-display";

vi.mock("../effect-reach", { spy: true });

vi.mock("../gpu-budget", async (original) => ({
  ...(await original<typeof import("../gpu-budget")>()),
  canvasWindowBlocks: () => windowBlocks,
}));
vi.mock("../history-manager", () => ({
  destroyHistoryManager: vi.fn(),
  deriveSideData: vi.fn(async () => ({ inverseMap: inverseSeed })),
  historyMemoryCacheBytes: () => ({ deltas: 0, audioHops: 0 }),
  getHistoryManager: () => ({
    initialize: () => historyInitialize(),
    addRootSnapshot: () => addRootSnapshot(),
    setStateAudio: vi.fn(),
    currentBlockState: async () => currentSeed ?? seed,
    getManifest: () => ({ currentId: "edited" }),
    nearestFullAnchor: () => ({ id: "root" }),
    isCurrentAudioCached: () => true,
    currentTaps: async (runs: Uint32Array) => gatherTaps(seed, runs),
    currentRanges: async (ranges: Uint32Array) => gatherPixelRanges(seed, ranges),
    rootRanges: async (ranges: Uint32Array) => gatherPixelRanges(seed, ranges),
    currentBlock: async (index: number) => {
      const list = blockPixelRanges(grid, index);
      return gatherPixelRanges(seed, list.ranges.subarray(0, list.count * 2));
    },
    restoreCurrentAudio: async () => {},
  }),
}));

vi.mock("../display-pyramid", async (original) => {
  const module = await original<typeof import("../display-pyramid")>();
  return {
    ...module,
    displayPyramidLevels: (layout: Parameters<typeof module.displayPyramidLevels>[0]) =>
      module.displayPyramidLevels(layout, pyramidBudget),
  };
});

const historyInitialize = vi.fn(async () => true);
const addRootSnapshot = vi.fn(async (): Promise<string> => "root");

let pyramidBudget: number | undefined;
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
  historyInitialize.mockReset().mockResolvedValue(true);
  addRootSnapshot.mockReset().mockResolvedValue("root");
  pyramidBudget = undefined;
  vi.restoreAllMocks();
});

async function mount(state: State, blocks: number, durationSeconds = 300, requestFrame?: () => void) {
  windowBlocks = blocks;
  const w = window as unknown as Record<string, unknown>;
  const previous = { nodeOs: w.nodeOs, ipcRenderer: w.ipcRenderer, nodePath: w.nodePath };
  Object.assign(w, {
    nodeOs: { homedir: () => "/home", totalmem: () => 16 * 1024 ** 3 },
    ipcRenderer: { invoke: vi.fn(async () => undefined) },
    nodePath: { join: (...parts: string[]) => parts.join("/"), basename: (path: string) => path.split("/").at(-1) },
  });
  disposers.push(() => {
    Object.assign(w, previous);
  });
  const [{ ViewRenderer }, { useStore }, { openFiles }, { useTransientStore }, { FileEngineProvider }] =
    await Promise.all([
      import("../../components/view-renderer"),
      import("../../store"),
      import("../../store/files"),
      import("../../store/transient"),
      import("../../components/file-engine-provider"),
    ]);
  const initialState = useStore.getState();
  useStore.setState({
    ...state,
    activeFileId: "residency",
    openFileIds: ["residency"],
    minimizedFileIds: [],
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
  const viewRef = createRef<ViewRendererHandle>();
  const snapshot = createRef<HTMLCanvasElement>();
  snapshot.current = document.createElement("canvas");
  snapshot.current.style.width = "100px";
  snapshot.current.style.height = "100px";
  document.body.append(snapshot.current);
  disposers.push(() => snapshot.current?.remove());
  const onFileHandle = (handle: FileRendererHandle | null) => {
    ref.current = handle;
  };
  openFiles.residency = {
    id: "residency",
    filePath: "/residency.wav",
    displayName: "residency.wav",
    spectrogramData: data,
    rendererRef: { current: null },
  };
  disposers.push(() => {
    delete openFiles.residency;
  });
  const element = document.createElement("canvas");
  const gl = new THREE.WebGLRenderer({ canvas: element });
  const root = createRoot(element);
  await root.configure({
    gl,
    frameloop: "never",
    size: { width: 100, height: 100, top: 0, left: 0 },
    onCreated: (state) => {
      if (requestFrame) state.set({ invalidate: requestFrame });
    },
  });
  const initializeSpy = vi.spyOn(WindowedCanvas.prototype, "initialize");
  const displaySpy = vi.spyOn(StrokeRenderer.prototype, "getDisplayPyramid");
  function TestView({ parked, selected }: { parked: boolean; selected: string }) {
    const ids = useStore((state) => state.openFileIds);
    return createElement(ViewRenderer, {
      descriptor: { topId: selected, layerIds: ids },
      isLive: true,
      parked,
      snapshotCanvasRef: snapshot,
      ref: viewRef,
      onFileHandle,
    });
  }
  const render = (parked: boolean, instance = 0, session = 0, visible = true, selected = "residency") => {
    useStore.setState({ minimizedFileIds: parked ? ["residency"] : [] });
    return root.render(
      createElement(
        FileEngineProvider,
        { key: session },
        visible ? createElement(TestView, { key: instance, parked, selected }) : null,
      ),
    );
  };
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
  await vi.waitFor(() => expect(canvas.isPopulated()).toBe(true));
  const strokeRenderer = displaySpy.mock.contexts.at(-1);
  if (!(strokeRenderer instanceof StrokeRenderer)) throw new Error("no display renderer");
  return {
    ref,
    viewRef,
    snapshot,
    getMaterial: () => viewRef.current?.display.top?.material ?? null,
    data,
    frame,
    canvas,
    state: useStore.getState(),
    useTransientStore,
    unmount,
    render,
    file: openFiles.residency,
    useStore,
    gl,
    strokeRenderer,
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
  it("rolls back failed keyboard paint without committing it", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const before = await rig.ref.current!.getFBOData();
    const [beats, pitch] = uvToUnits(0.5, 0.5, 120, 8, rig.data.bandsPerOctave, rig.data.numBands);
    rig.useTransientStore.setState({ cursorPosition: { beats, pitch }, cursorVisible: true });
    const commit = vi.fn(async () => {});
    rig.useStore.setState({ applyStrokeAtPosition: commit });
    vi.spyOn(rig.canvas, "settle").mockImplementation(async () => {
      rig.frame();
      return { status: "failed", reason: "unavailable" };
    });
    await rig.useStore.getState().applyBrushAtPosition();
    expect(commit).not.toHaveBeenCalled();
    expect(await rig.ref.current!.getFBOData()).toEqual(before);
    expect(rig.ref.current!.beginStroke()).toBe(true);
    rig.ref.current!.endStroke();
  });

  it("cancels grid fill during settlement without creating a history commit", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const before = await rig.ref.current!.getFBOData();
    const commit = vi.fn(async () => {});
    rig.useStore.setState({ snapTime: true, snapPitch: false, applyStrokeAtPosition: commit });
    const settle = rig.canvas.settle.bind(rig.canvas);
    const spy = vi.spyOn(rig.canvas, "settle").mockImplementation(async (signal) => {
      rig.useStore.getState().cancelFill();
      expect(signal?.aborted).toBe(true);
      return settle(signal);
    });
    await rig.useStore.getState().fillGrid();
    expect(spy).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(await rig.ref.current!.getFBOData()).toEqual(before);
    expect(rig.useStore.getState().isFilling).toBe(false);
  });

  it("leaves a replacement state usable when the previous stroke finishes settling", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const handle = rig.ref.current!;
    handle.beginStroke();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(rig.canvas, "settle").mockImplementation(async () => {
      await pending;
      return { status: "cancelled" };
    });
    const discard = vi.spyOn(rig.canvas, "discardStroke");
    const settling = handle.settleStroke();
    handle.setFBOData(seed);
    release();
    expect(await settling).toEqual({ status: "cancelled" });
    expect(discard).not.toHaveBeenCalled();
    expect(handle.beginStroke()).toBe(true);
    handle.endStroke();
  });

  it("blocks another stroke while settlement or a failed rollback owns the canvas", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const handle = rig.ref.current!;
    handle.beginStroke();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(rig.canvas, "settle").mockImplementation(async () => {
      await waiting;
      return { status: "failed", reason: "read-error" };
    });
    vi.spyOn(rig.canvas, "discardStroke").mockResolvedValue(false);
    const settling = handle.settleStroke();
    expect(handle.beginStroke()).toBe(false);
    finish();
    expect(await settling).toEqual({ status: "failed", reason: "read-error" });
    expect(handle.beginStroke()).toBe(false);
    expect(await handle.settleStroke()).toEqual({ status: "failed", reason: "read-error" });
  });

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
    const material = rig.getMaterial()!;
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
    const material = rig.getMaterial()!;
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

describe("visible screen residency", () => {
  it.each([8, 5])("keeps fine tiles for a disjoint screen at zoom %s through the rest delay", async (zoom) => {
    pyramidBudget = 1000;
    const rig = await mount(brush(0), 2);
    const read = vi.spyOn(rig.canvas, "readCommittedTaps");
    const aim = vi.spyOn(rig.canvas, "aim");
    rig.useStore.setState({ filesZoom: { residency: zoom }, filesOffset: { residency: 0.75 } });
    await vi.waitFor(() => expect(rig.viewRef.current?.display.descriptor.transform.viewZoomPower).toBe(zoom));
    rig.frame();
    expect(aim).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
    const material = rig.getMaterial()!;
    await vi.waitFor(() => {
      rig.frame();
      expect(material.uniforms.displayTileCount.value).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    rig.frame();
    expect(aim).toHaveBeenCalled();
    const visible = { start: aim.mock.calls[0][0], end: aim.mock.calls[0][1] };
    if (rig.canvas.fitsWindow(visible.start, visible.end)) {
      await vi.waitFor(() => expect(rig.canvas.holdsFrames(visible.start, visible.end)).toBe(true));
      rig.frame();
      expect(material.uniforms.displayTileCount.value).toBe(0);
    } else {
      expect(material.uniforms.displayTileCount.value).toBeGreaterThan(0);
    }
    const { createByteTarget, renderMaterialToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(100, 100);
    disposers.push(() => target.dispose());
    material.uniforms.drawOverlays.value = false;
    const pixels = await renderMaterialToBytes(rig.gl, material, target);
    expect(pixels).not.toBeNull();
    expect(pixels!.some((value, index) => index % 4 !== 3 && value > 20)).toBe(true);
    expect(material.uniforms.displayLoading.value).toBe(0);
  });
});

it("uses block capacity for the visible refusal and batch admission", async () => {
  const state = brush(0);
  const rig = await mount(state, 2);
  const wideBrush = createMockStateWithSteps([
    {
      name: "Wide",
      overrides: {
        brushSizeTime: rig.canvas.windowSeconds() * 2 - 0.01,
        brushAnchorMode: 0,
        sourcePositionMode: "follow",
        effects: [],
      },
    },
  ]);
  const wide = { ...rig.state, brushes: wideBrush.brushes };
  const aim = { x: (grid.blockFrames - 1) / rig.data.numFrames, y: 0.5 };
  expect(rig.ref.current!.strokeRefusal(wide, aim)).not.toBeNull();
  rig.ref.current!.beginStroke();
  expect(rig.ref.current!.renderStrokeBatch([{ state: wide, aimX: aim.x, aimY: aim.y }])).toBe(0);
});

it("disposes each display material and releases its renderer properties across remounts", async () => {
  const rig = await mount(brush(0), Infinity, 8);
  for (let cycle = 0; cycle < 4; cycle++) {
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.ref.current?.getTextures()).toBeTruthy();
    });
    const material = rig.getMaterial()!;
    expect(rig.gl.properties.has(material)).toBe(true);
    const disposed = vi.fn();
    material.addEventListener("dispose", disposed);
    if (cycle < 3) rig.render(false, cycle + 1);
    else await rig.unmount();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
    expect(rig.gl.properties.has(material)).toBe(false);
  }
});

describe("pending frame dab settlement", () => {
  it.each([
    { blocks: Infinity, duration: 8 },
    { blocks: 2, duration: 300 },
  ])("paints the pending dab before the commit read ($blocks blocks)", async ({ blocks, duration }) => {
    const rig = await mount(brush(0), blocks, duration);
    const handle = rig.ref.current!;
    const aim = 0.7;
    const [beats, pitch] = uvToUnits(aim, 0.5, 120, duration, rig.data.bandsPerOctave, rig.data.numBands);
    rig.useTransientStore.setState({ cursorPosition: { beats, pitch }, cursorVisible: true });
    const painted = vi.spyOn(StrokeRenderer.prototype, "renderStroke");
    handle.beginStroke();
    handle.renderStroke(false);
    expect(painted).not.toHaveBeenCalled();

    await handle.settleStroke();
    expect(painted).toHaveBeenCalledTimes(1);
    const footprint = handle.getCommittedFootprintUv();
    expect(footprint).not.toBeNull();
    const ranges = handle.getDirtyPixelRanges()!;
    const committed = (await handle.readPixelRanges(ranges))!;
    const original = gatherPixelRanges(seed, ranges);
    expect(committed.some((value, i) => Math.abs(value - original[i]) > 1e-6)).toBe(true);
    handle.endStroke();
    rig.frame();
    expect(painted).toHaveBeenCalledTimes(1);
    expect(await handle.readPixelRanges(ranges)).toEqual(committed);

    handle.beginStroke();
    handle.renderStrokeBatch([{ state: rig.state, aimX: aim, aimY: 0.5 }]);
    await handle.settleStroke();
    expect(painted).toHaveBeenCalledTimes(2);
    expect(handle.getCommittedFootprintUv()).toEqual(footprint);
    handle.endStroke();
  });

  it("leaves a pending preview out of the commit", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const [beats, pitch] = uvToUnits(0.5, 0.5, 120, 8, rig.data.bandsPerOctave, rig.data.numBands);
    rig.useTransientStore.setState({ cursorPosition: { beats, pitch }, cursorVisible: true });
    const painted = vi.spyOn(StrokeRenderer.prototype, "renderStroke");
    rig.ref.current!.renderStroke(true);
    await rig.ref.current!.settleStroke();
    expect(painted).not.toHaveBeenCalled();
    expect(rig.ref.current!.getCommittedFootprintUv()).toBeNull();
  });
});

function displayContext(rig: Awaited<ReturnType<typeof mount>>): FileDisplayResidencyContext {
  return {
    get transform() {
      const state = rig.useStore.getState();
      return { viewZoomPower: state.filesZoom.residency ?? 0, viewOffset: state.filesOffset.residency ?? 0 };
    },
    spectrogramData: rig.data,
    displayMaterial: rig.getMaterial()!,
    glRef: { current: rig.gl },
    strokeRendererRef: { current: rig.strokeRenderer },
    canvasRef: { current: rig.canvas },
    invalidateRef: { current: vi.fn() },
    ringRequestsRef: { current: new Set() },
    loadingSinceRef: { current: null },
    loadingViewRef: { current: { zoom: 0, offset: 0 } },
    aimRest: { current: new AimRest() },
    aimRestTimer: { current: null },
    currentTaps: async (runs) => gatherTaps(seed, runs),
  };
}

describe("display residency completion", () => {
  it.each(["current", "renderer replaced", "level changed", "slot reclaimed"])(
    "checks a delayed tile before publishing: %s",
    async (completion) => {
      pyramidBudget = 1000;
      const rig = await mount(brush(0), 2);
      const context = displayContext(rig);
      const tiles = rig.strokeRenderer.getDisplayTiles()!;
      const cut = vi.spyOn(tiles, "cutTileFromTaps");
      const pending: Array<() => void> = [];
      vi.spyOn(rig.canvas, "readCommittedTaps").mockImplementation(
        (runs) => new Promise((resolve) => pending.push(() => resolve(gatherTaps(seed, runs)))),
      );
      rig.useStore.setState({ filesZoom: { residency: 8 }, filesOffset: { residency: 0.75 } });
      applyDisplayPyramidUniforms(context, 8, 0.75, 100);
      expect(pending.length).toBeGreaterThan(0);
      const requests = pending.length;
      applyDisplayPyramidUniforms(context, 8, 0.75, 100);
      expect(pending).toHaveLength(requests);
      if (completion === "renderer replaced") context.strokeRendererRef.current = null;
      if (completion === "level changed") vi.spyOn(tiles, "gridLevel").mockReturnValue(tiles.gridLevel() + 1);
      if (completion === "slot reclaimed") vi.spyOn(tiles, "canCutTile").mockReturnValue(false);
      vi.mocked(context.invalidateRef.current).mockClear();
      for (const resolve of pending) resolve();
      await vi.waitFor(() => expect(context.ringRequestsRef.current.size).toBe(0));
      expect(cut).toHaveBeenCalledTimes(completion === "current" ? requests : 0);
      expect(context.invalidateRef.current).toHaveBeenCalledTimes(completion === "current" ? requests : 0);
    },
  );

  it("advances loading grace and fade without pointer input and stops requesting frames once ready", async () => {
    pyramidBudget = 1000;
    const rig = await mount(brush(0), 2);
    const context = displayContext(rig);
    const pending: Array<() => void> = [];
    vi.spyOn(rig.canvas, "readCommittedTaps").mockImplementation(
      (runs) => new Promise((resolve) => pending.push(() => resolve(gatherTaps(seed, runs)))),
    );
    rig.useStore.setState({ filesZoom: { residency: 5 }, filesOffset: { residency: 0.75 } });
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const loading = context.displayMaterial.uniforms.displayLoading;
    applyDisplayPyramidUniforms(context, 5, 0.75, 100);
    expect(loading.value).toBe(0);
    expect(context.invalidateRef.current).toHaveBeenCalled();
    context.displayMaterial.uniforms.drawOverlays.value = false;
    vi.mocked(context.invalidateRef.current).mockClear();
    applyDisplayPyramidUniforms(context, 5, 0.75, 100);
    expect(context.invalidateRef.current).not.toHaveBeenCalled();
    context.displayMaterial.uniforms.drawOverlays.value = true;
    now.mockReturnValue(1200);
    applyDisplayPyramidUniforms(context, 5, 0.75, 100);
    expect(loading.value).toBeGreaterThan(0);
    expect(loading.value).toBeLessThan(1);
    now.mockReturnValue(2000);
    vi.mocked(context.invalidateRef.current).mockClear();
    applyDisplayPyramidUniforms(context, 5, 0.75, 100);
    expect(loading.value).toBe(1);
    expect(context.invalidateRef.current).not.toHaveBeenCalled();
    for (const resolve of pending) resolve();
    await vi.waitFor(() => expect(context.ringRequestsRef.current.size).toBe(0));
    vi.mocked(context.invalidateRef.current).mockClear();
    applyDisplayPyramidUniforms(context, 5, 0.75, 100);
    expect(loading.value).toBe(0);
    expect(context.loadingSinceRef.current).toBeNull();
    expect(context.invalidateRef.current).not.toHaveBeenCalled();
  });

  it("owns the frame at aim rest and cancels it at disposal", async () => {
    const rig = await mount(brush(0), 2);
    const context = displayContext(rig);
    const aim = vi.spyOn(rig.canvas, "aim");
    rig.useStore.setState({ filesZoom: { residency: 8 }, filesOffset: { residency: 0.75 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      prepareVisibleRegion(context, rig.canvas, { x: -1 }, 0, 0, false);
      expect(aim).not.toHaveBeenCalled();
      expect(context.aimRestTimer.current).not.toBeNull();
      vi.advanceTimersByTime(1000);
      expect(context.invalidateRef.current).toHaveBeenCalledTimes(1);
      expect(context.aimRestTimer.current).toBeNull();
      rig.useStore.setState({ filesOffset: { residency: 0.25 } });
      prepareVisibleRegion(context, rig.canvas, { x: -1 }, 0, 0, false);
      expect(context.aimRestTimer.current).not.toBeNull();
      disposeDisplayResidency(context.aimRestTimer);
      vi.advanceTimersByTime(1000);
      expect(context.invalidateRef.current).toHaveBeenCalledTimes(1);
    } finally {
      disposeDisplayResidency(context.aimRestTimer);
      vi.useRealTimers();
    }
  });
});

describe("session-owned file engine", () => {
  it("retains one engine through reload, parking and display remounts", async () => {
    const contexts = vi.spyOn(FileEngine.prototype, "updateContext");
    const rig = await mount(brush(0), Infinity, 8);
    const engine = contexts.mock.contexts.at(-1);
    if (!(engine instanceof FileEngine)) throw new Error("no file engine");
    const originalRenderer = engine.strokeRendererRef.current!;
    const disposed = vi.spyOn(originalRenderer, "dispose");
    const historyCalls = historyInitialize.mock.calls.length;
    rig.file.spectrogramData = { ...rig.data, packedData: seed, inverseMap: inverseSeed };
    rig.ref.current!.reloadTextures();
    expect(rig.file.spectrogramData.packedData).toBe(seed);
    expect(disposed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.ref.current!.getTextures()).toBeTruthy();
    });
    expect(contexts.mock.contexts.at(-1)).toBe(engine);
    expect(engine.strokeRendererRef.current).not.toBe(originalRenderer);
    expect(historyInitialize).toHaveBeenCalledTimes(historyCalls);
    rig.render(true);
    await vi.waitFor(() => expect(rig.file.parked).toBe(true));
    expect(engine.strokeRendererRef.current).toBeNull();
    expect(engine.canvasRef.current).toBeNull();
    expect(engine.borrowDisplaySource()).toBeNull();
    rig.file.spectrogramData = { ...rig.data, packedData: seed, inverseMap: inverseSeed };
    rig.file.rendererRef!.current!.reloadTextures();
    expect(engine.liveTexturesRef.current).toBeNull();
    expect(engine.strokeRendererRef.current).toBeNull();
    rig.render(false);
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.ref.current!.getTextures()).toBeTruthy();
    });
    expect(contexts.mock.contexts.at(-1)).toBe(engine);
    rig.render(false, 1);
    await vi.waitFor(() => {
      rig.frame();
      expect(contexts.mock.contexts.at(-1)).toBe(engine);
      expect(rig.ref.current!.getTextures()).toBeTruthy();
    });
    expect(engine.strokeRendererRef.current).not.toBeNull();
    expect(engine.canvasRef.current).not.toBeNull();
    expect(engine.borrowDisplaySource()).not.toBeNull();
  });

  it("keeps editable state and the registered adapter while every display is detached", async () => {
    const contexts = vi.spyOn(FileEngine.prototype, "updateContext");
    const rig = await mount(brush(0), Infinity, 8);
    const engine = contexts.mock.contexts.at(-1);
    if (!(engine instanceof FileEngine)) throw new Error("no file engine");
    const adapter = rig.file.rendererRef!.current!;
    const renderer = engine.strokeRendererRef.current;
    const historyCalls = historyInitialize.mock.calls.length;
    const dispose = vi.spyOn(engine, "dispose");
    const current = await adapter.getFBOData();
    rig.render(false, 0, 0, false);
    await vi.waitFor(() => expect(rig.ref.current).toBeNull());
    expect(rig.file.rendererRef!.current).toBe(adapter);
    expect(await adapter.getFBOData()).toEqual(current);
    expect(rig.viewRef.current).toBeNull();
    for (let instance = 1; instance <= 8; instance++) {
      rig.render(false, instance);
      await vi.waitFor(() => {
        rig.frame();
        expect(rig.ref.current).toBe(adapter);
      });
      expect(engine.strokeRendererRef.current).toBe(renderer);
    }
    expect(historyInitialize).toHaveBeenCalledTimes(historyCalls);
    expect(dispose).not.toHaveBeenCalled();
    await rig.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(rig.file.rendererRef!.current).toBeNull();
  });

  it("borrows the selected file's saved transform without changing either saved view", async () => {
    const rig = await mount(brush(0), Infinity, 8);
    const { openFiles } = await import("../../store/files");
    openFiles.selected = { ...rig.file, id: "selected", filePath: "/selected.wav", rendererRef: { current: null } };
    disposers.push(() => {
      delete openFiles.selected;
    });
    rig.useStore.setState({ openFileIds: ["residency", "selected"] });
    const saved = {
      filesZoom: { residency: 2, selected: 4 },
      filesOffset: { residency: 0.2, selected: 0.6 },
      filesZoomY: { residency: 1, selected: 3 },
      filesOffsetY: { residency: 0.1, selected: 0.4 },
    };
    rig.useStore.setState(saved);
    for (const [instance, id] of ["selected", "residency", "selected", "residency"].entries()) {
      const previous = rig.getMaterial();
      rig.render(false, instance + 1, 0, true, id);
      await vi.waitFor(() => {
        rig.frame();
        expect(rig.getMaterial()).not.toBe(previous);
      });
      const material = rig.getMaterial()!;
      const key = id === "selected" ? "selected" : "residency";
      expect(material.uniforms.viewZoomPower.value).toBe(saved.filesZoom[key]);
      expect(material.uniforms.viewOffset.value).toBe(saved.filesOffset[key]);
      expect(material.uniforms.viewZoomPowerY.value).toBe(saved.filesZoomY[key]);
      expect(material.uniforms.viewOffsetY.value).toBe(saved.filesOffsetY[key]);
      for (const field of ["filesZoom", "filesOffset", "filesZoomY", "filesOffsetY"] as const)
        expect(rig.useStore.getState()[field]).toEqual(saved[field]);
    }
  });

  it("reconstructs a new engine after graphics context restoration", async () => {
    const contexts = vi.spyOn(FileEngine.prototype, "updateContext");
    const rig = await mount(brush(0), Infinity, 8);
    const engine = contexts.mock.contexts.at(-1);
    if (!(engine instanceof FileEngine)) throw new Error("no file engine");
    const expected = await rig.file.rendererRef!.current!.getFBOData();
    rig.gl.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(rig.file.rendererRef!.current).toBeNull();
    expect(engine.borrowDisplaySource()).toBeNull();
    rig.gl.domElement.dispatchEvent(new Event("webglcontextrestored"));
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.file.rendererRef!.current?.getTextures()).toBeTruthy();
    });
    expect(contexts.mock.contexts.at(-1)).not.toBe(engine);
    expect(await rig.file.rendererRef!.current!.getFBOData()).toEqual(expected);
  });

  it("paints with the bridge's current scale texture while retaining its engine", async () => {
    const contexts = vi.spyOn(FileEngine.prototype, "updateContext");
    const rig = await mount(brush(0), Infinity, 8);
    const engine = contexts.mock.contexts.at(-1);
    const original = contexts.mock.calls.at(-1)![0].modulatorScaleLut;
    rig.useStore.setState({ scaleTonic: "D" });
    await vi.waitFor(() => expect(contexts.mock.calls.at(-1)![0].modulatorScaleLut).not.toBe(original));
    const current = contexts.mock.calls.at(-1)![0].modulatorScaleLut;
    expect(current).not.toBeNull();
    expect(contexts.mock.contexts.at(-1)).toBe(engine);
    const luts: unknown[] = [];
    const render = rig.gl.render.bind(rig.gl);
    vi.spyOn(rig.gl, "render").mockImplementation((scene, camera) => {
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          object.material instanceof THREE.RawShaderMaterial &&
          object.material.uniforms.gainLut
        )
          luts.push(object.material.uniforms.gainLut.value);
      });
      render(scene, camera);
    });
    rig.ref.current!.renderRegionStroke({ aimX: 0.5, aimY: 0.5, state: rig.useStore.getState() }, false);
    expect(luts).toContain(current);
    expect(luts).not.toContain(original);
  });

  it("keeps the initial seeds until the queued root has taken them and attaches once", async () => {
    historyInitialize.mockResolvedValue(false);
    let finishRoot!: (id: string) => void;
    addRootSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRoot = resolve;
        }),
    );
    const synthesizeFile = vi.fn(async () => {});
    const rig = await mount({ ...brush(0), synthesizeFile }, Infinity, 8);
    await vi.waitFor(() => expect(addRootSnapshot).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i++) rig.frame();
    expect(historyInitialize).toHaveBeenCalledTimes(1);
    expect(rig.data.packedData).toBe(seed);
    expect(rig.data.inverseMap).toBe(inverseSeed);
    const upload = vi.spyOn(rig.gl, "initTexture");
    finishRoot("root");
    await vi.waitFor(() => expect(synthesizeFile).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(rig.data.packedData).toBeUndefined();
    expect(rig.data.inverseMap).toBeUndefined();
    expect(synthesizeFile).toHaveBeenCalledWith("residency", undefined, seed);
    rig.frame();
    expect(addRootSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(["context replacement", "resume"])(
    "cancels %s installation after a close during side-data recovery",
    async (path) => {
      const contexts = vi.spyOn(FileEngine.prototype, "updateContext");
      const rig = await mount(brush(0), Infinity, 8);
      rig.ref.current!.releaseAnalysisData();
      const { deriveSideData } = await import("../history-manager");
      let finishSide!: () => void;
      vi.mocked(deriveSideData).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSide = () => resolve({ inverseMap: inverseSeed!, metadata: rig.data.metadata });
          }),
      );
      if (path === "resume") {
        rig.render(true);
        await vi.waitFor(() => expect(rig.file.parked).toBe(true));
        rig.render(false);
      } else rig.render(false, 1, 1);
      await vi.waitFor(() => expect(finishSide).toBeTypeOf("function"));
      const engine = contexts.mock.contexts.at(-1);
      if (!(engine instanceof FileEngine)) throw new Error("no file engine");
      const install = vi.spyOn(engine, "installTextures");
      await rig.unmount();
      finishSide();
      const { serializeFileTask } = await import("../file-task-queue");
      await serializeFileTask("residency", async () => {});
      expect(install).not.toHaveBeenCalled();
      expect(engine.currentSeedRef.current).toBeNull();
      expect(engine.packedSeedRef.current).toBeNull();
      expect(engine.borrowDisplaySource()).toBeNull();
    },
  );
});

async function stackedView(count: number) {
  const rig = await mount(brush(0), Infinity, 8);
  const { openFiles } = await import("../../store/files");
  const ids = ["residency"];
  for (let i = 1; i < count; i++) {
    const id = `background-${i}`;
    const data = createConstantQMockSpectrogramData({ durationSeconds: 8, sampleRate: 800, bandsPerOctave: 1 });
    data.packedData.set(seed);
    openFiles[id] = {
      id,
      filePath: `/${id}.wav`,
      displayName: id,
      spectrogramData: data,
      rendererRef: { current: null },
    };
    disposers.push(() => {
      delete openFiles[id];
    });
    ids.push(id);
  }
  rig.useStore.setState({ openFileIds: ids });
  await vi.waitFor(() => {
    rig.frame();
    expect(rig.viewRef.current?.display.layers).toHaveLength(count);
    expect(rig.viewRef.current?.display.layers.every((layer) => layer.ready)).toBe(true);
  });
  return rig;
}

describe("one direct display per view", () => {
  it("reuses reach computations across frames until the state changes", async () => {
    const rig = await mount(brush(0, false, true), 2);
    rig.useTransientStore.setState({ cursorPosition: { beats: 1, pitch: 0 }, cursorVisible: true });
    rig.useStore.setState({ filepathsBpm: { "/residency.wav": 120 } });
    vi.mocked(strokeReach).mockClear();
    const state = rig.useStore.getState();
    for (let frame = 0; frame < 4; frame++) {
      rig.frame();
      expect(rig.useStore.getState()).toBe(state);
      expect.soft(strokeReach).toHaveBeenCalledTimes(1);
    }
    rig.useStore.setState({ filepathsBpm: { "/residency.wav": 140 } });
    const nextState = rig.useStore.getState();
    expect(nextState).not.toBe(state);
    for (let frame = 0; frame < 4; frame++) {
      rig.frame();
      expect(rig.useStore.getState()).toBe(nextState);
      expect.soft(strokeReach).toHaveBeenCalledTimes(2);
    }
  });

  it("draws each gesture revision once, with its current transform, including momentum", async () => {
    let pending = false;
    const rig = await mount(brush(0), Infinity, 8, () => {
      pending = true;
    });
    const flush = () => {
      if (!pending) return;
      pending = false;
      rig.frame();
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    flush();
    const frames: ViewTransform[] = [];
    const material = rig.getMaterial()!;
    const render = rig.gl.render.bind(rig.gl);
    vi.spyOn(rig.gl, "render").mockImplementation((scene, camera) => {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object.material !== material) return;
        frames.push({
          viewZoomPower: material.uniforms.viewZoomPower.value,
          viewOffset: material.uniforms.viewOffset.value,
          viewZoomPowerY: material.uniforms.viewZoomPowerY.value,
          viewOffsetY: material.uniforms.viewOffsetY.value,
        });
      });
      render(scene, camera);
    });
    const state = rig.useStore.getState();
    const inputs = [
      () => state.setFileZoomAndOffset("residency", 2, 0.2),
      () => state.setFileOffset("residency", 0.4),
      () => state.setFileOffset("residency", 0.45),
      () => state.setFileOffset("residency", 0.475),
      () => state.setFileZoomAndOffsetY("residency", 1, 0.3),
    ];
    for (const input of inputs) {
      frames.length = 0;
      input();
      const expected = savedViewTransform(rig.useStore.getState(), "residency");
      flush();
      await new Promise((resolve) => setTimeout(resolve, 100));
      flush();
      expect.soft(frames).toHaveLength(1);
      for (const transform of frames) expect.soft(transform).toEqual(expected);
    }
  });

  it("draws a background whose history seed arrives after its record mounts", async () => {
    const rig = await stackedView(1);
    const { openFiles } = await import("../../store/files");
    const data = createConstantQMockSpectrogramData({ durationSeconds: 8, sampleRate: 800, bandsPerOctave: 1 });
    const fileData = { ...data, packedData: undefined };
    let release: () => void = () => {};
    historyInitialize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    openFiles.delayed = {
      id: "delayed",
      filePath: "/delayed.wav",
      displayName: "delayed",
      spectrogramData: fileData,
      rendererRef: { current: null },
    };
    disposers.push(() => {
      delete openFiles.delayed;
    });
    rig.useStore.setState({ openFileIds: ["residency", "delayed"] });
    await vi.waitFor(() => {
      rig.frame();
      expect(rig.viewRef.current?.display.layers).toHaveLength(2);
    });
    const layer = rig.viewRef.current!.display.layers[0];
    expect(layer.ready).toBe(false);
    release();
    await vi.waitFor(() => {
      rig.frame();
      expect(layer.ready).toBe(true);
    });
    expect(layer.material.uniforms.drawOverlays.value).toBe(false);
    expect(layer.material.blending).toBe(THREE.AdditiveBlending);
  });

  it("rejects an old-size capture after the view resizes", async () => {
    const rig = await stackedView(1);
    const view = rig.viewRef.current!;
    const capture = view.captureSnapshot();
    rig.snapshot.current!.style.width = "81px";
    rig.snapshot.current!.style.height = "45px";
    view.display.resize(81, 45);
    expect(await capture).toBe(false);
  });

  it("rejects a capture when background content changes during readback", async () => {
    const rig = await stackedView(2);
    const view = rig.viewRef.current!;
    const capture = view.captureSnapshot();
    view.display.layers[0].engine.notifyContentChanged();
    expect(await capture).toBe(false);
    expect(await view.captureSnapshot()).toBe(true);
  });

  it("rejects a capture when membership changes at the same size", async () => {
    const rig = await stackedView(2);
    const view = rig.viewRef.current!;
    const capture = view.captureSnapshot();
    view.display.update(
      { ...view.display.descriptor, layerIds: [view.display.descriptor.topId] },
      rig.useStore.getState(),
    );
    expect(await capture).toBe(false);
    expect(await view.captureSnapshot()).toBe(true);
  });

  it("coalesces background changes and keeps editor work on the top layer", async () => {
    const rig = await stackedView(4);
    const display = rig.viewRef.current!.display;
    const background = display.layers[0];
    const prepare = vi.spyOn(background.engine, "initialise");
    const dispatch = vi.spyOn(background.engine, "strokeDispatch");
    const bind = vi.spyOn(display, "bind");
    for (let i = 0; i < 5; i++) rig.frame();
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(bind.mock.calls.filter(([layer]) => layer === background)).toHaveLength(0);
    const content = background.engine.contentRevision;
    const residency = background.engine.residencyRevision;
    for (let i = 0; i < 3; i++) background.engine.notifyResidencyChanged();
    rig.frame();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls.filter(([layer]) => layer === background)).toHaveLength(1);
    expect(background.engine.contentRevision).toBe(content);
    expect(background.engine.residencyRevision).toBe(residency + 3);
    background.engine.notifyContentChanged();
    rig.frame();
    expect(background.engine.contentRevision).toBe(content + 1);
    expect(bind.mock.calls.filter(([layer]) => layer === background)).toHaveLength(2);
    rig.useStore.setState({ gridSizeSemis: 12, pickingFileParam: null });
    rig.frame();
    expect(bind.mock.calls.filter(([layer]) => layer === background)).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([1, 2, 4, 8])("keeps the ordered byte composition at %i layers", async (count) => {
    const rig = await stackedView(count);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes, renderMaterialToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    const top = display.top!;
    top.material.uniforms.previewActive.value = false;
    top.material.uniforms.showSourceRectangle.value = false;
    top.material.uniforms.showTargetRectangle.value = false;
    const before = rig.gl.info.render.calls;
    const live = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "live"), target);
    expect(rig.gl.info.render.calls - before).toBe(count);
    const still = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
    const oracle = await renderMaterialToBytes(
      rig.gl,
      display.layers.map((layer) => layer.material),
      target,
    );
    expect(live).toEqual(oracle);
    expect(still).toEqual(oracle);
    expect(live.some((value, i) => i % 4 !== 3 && value > 0)).toBe(true);
    for (const layer of display.layers) {
      expect(layer.material.uniforms.drawOverlays.value).toBe(layer === top);
      if (layer !== top) expect(layer.material.uniforms.leftTint).not.toBe(top.material.uniforms.leftTint);
    }
    top.material.uniforms.showTargetRectangle.value = true;
    await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
    expect(top.material.uniforms.showTargetRectangle.value).toBe(true);
  });

  it.each([3, 4, 8])("matches direct pixels with a byte backdrop at %i layers", async (count) => {
    const rig = await stackedView(count);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    display.resize(80, 40);
    display.prepare(rig.useStore.getState());
    for (const minDb of [-72, -30, -12]) {
      const state = { ...rig.useStore.getState(), displayMinDb: minDb, displayMaxDb: minDb + 12 };
      display.updateState(state);
      display.prepare(state);
      for (const purpose of ["live", "capture"] as const) {
        const direct = await renderCompositionToBytes(rig.gl, () => display.composeDirect(rig.gl, purpose), target);
        const cached = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, purpose), target);
        expect(cached).toEqual(direct);
        expect(cached.some((v, i) => i % 4 !== 3 && v > 0)).toBe(true);
      }
    }
    expect(display.backdropBytes).toBe(80 * 40 * 4);
  });

  it("colours only the editing layer and refreshes the backdrop when it changes", async () => {
    const rig = await stackedView(4);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    display.resize(80, 40);
    for (const topId of display.descriptor.layerIds) {
      display.update({ ...display.descriptor, topId }, rig.useStore.getState());
      display.prepare(rig.useStore.getState());
      for (const layer of display.layers) {
        for (const name of ["leftTint", "rightTint"]) {
          const tint = layer.material.uniforms[name].value as import("three").Color;
          if (layer.engine.fileId === topId) expect(tint.r === tint.g && tint.g === tint.b).toBe(false);
          else {
            expect(tint.r).toBe(tint.g);
            expect(tint.g).toBe(tint.b);
          }
        }
      }
      const direct = await renderCompositionToBytes(rig.gl, () => display.composeDirect(rig.gl, "capture"), target);
      const cached = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
      expect(cached).toEqual(direct);
    }
  });

  it("keeps engines and GPU allocations stable through 100 view switches", async () => {
    const rig = await stackedView(4);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    const engines = new Map(display.layers.map((layer) => [layer.engine.fileId, layer.engine]));
    const historyCalls = historyInitialize.mock.calls.length;
    const ids = [...display.descriptor.layerIds];
    const draw = async (index: number) => {
      const width = index % 2 ? 96 : 80;
      const order = index % 2 ? [...ids].reverse() : ids;
      display.update(
        { ...display.descriptor, layerIds: order, topId: order[index % order.length] },
        rig.useStore.getState(),
      );
      display.resize(width, 40);
      target.setSize(width, 40);
      display.prepare(rig.useStore.getState());
      await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
      expect(display.backdropBytes).toBe(width * 40 * 4);
      for (const layer of display.layers) expect(layer.engine).toBe(engines.get(layer.engine.fileId));
    };
    await draw(0);
    await draw(1);
    const memory = { ...rig.gl.info.memory };
    for (let i = 0; i < 100; i++) await draw(i);
    expect(rig.gl.info.memory).toEqual(memory);
    expect(historyInitialize).toHaveBeenCalledTimes(historyCalls);
    display.releaseBackdrop();
    expect(display.backdropBytes).toBe(0);
  });

  it("rebuilds the backdrop for background dependencies, but not top-only changes", async () => {
    const rig = await stackedView(4);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    display.resize(80, 40);
    const drawCount = async () => {
      display.prepare(rig.useStore.getState());
      const before = rig.gl.info.render.calls;
      await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
      return rig.gl.info.render.calls - before;
    };
    expect(await drawCount()).toBe(5);
    expect(await drawCount()).toBe(2);
    display.top!.engine.notifyContentChanged();
    expect(await drawCount()).toBe(2);
    rig.useStore.setState({ gridSizeSemis: 12 });
    expect(await drawCount()).toBe(2);
    for (let i = 0; i < 3; i++) display.layers[0].engine.notifyContentChanged();
    expect(await drawCount()).toBe(5);
    expect(await drawCount()).toBe(2);
    display.layers[0].engine.notifyResidencyChanged();
    expect(await drawCount()).toBe(5);
    display.updateTransform({ ...display.descriptor.transform, viewZoomPower: 1 });
    expect(await drawCount()).toBe(5);
    rig.useStore.setState({ displayMinDb: -50 });
    expect(await drawCount()).toBe(5);
    display.update(
      { ...display.descriptor, layerIds: display.descriptor.layerIds.slice(0, 2) },
      rig.useStore.getState(),
    );
    expect(await drawCount()).toBe(2);
    expect(display.backdropBytes).toBe(0);
  });

  it("draws directly during transform movement and captures the final cache", async () => {
    const rig = await stackedView(4);
    const display = rig.viewRef.current!.display;
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    display.resize(80, 40);
    display.prepare(rig.useStore.getState());
    await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
    display.updateTransform({ ...display.descriptor.transform, viewZoomPower: 2 });
    expect(display.motion.active).toBe(true);
    display.prepare(rig.useStore.getState());
    const before = rig.gl.info.render.calls;
    const live = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "live"), target);
    expect(rig.gl.info.render.calls - before).toBe(4);
    const still = await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "capture"), target);
    expect(still).toEqual(live);
    await vi.waitFor(() => expect(display.motion.active).toBe(false));
    const settled = rig.gl.info.render.calls;
    await renderCompositionToBytes(rig.gl, () => display.compose(rig.gl, "live"), target);
    expect(rig.gl.info.render.calls - settled).toBe(2);
  });

  it("preserves the caller's scissor and view rectangle across direct capture", async () => {
    const rig = await stackedView(2);
    const { createByteTarget, renderCompositionToBytes } = await import("../snapshot-capture");
    const target = createByteTarget(80, 40);
    disposers.push(() => target.dispose());
    rig.gl.setViewport(7, 8, 33, 22);
    rig.gl.setScissor(10, 11, 20, 15);
    rig.gl.setScissorTest(true);
    const viewport = rig.gl.getViewport(new THREE.Vector4());
    const scissor = rig.gl.getScissor(new THREE.Vector4());
    const pixels = await renderCompositionToBytes(
      rig.gl,
      () => rig.viewRef.current!.display.compose(rig.gl, "capture"),
      target,
    );
    expect(pixels.some((v, i) => i % 4 !== 3 && v > 0)).toBe(true);
    expect(rig.gl.getViewport(new THREE.Vector4())).toEqual(viewport);
    expect(rig.gl.getScissor(new THREE.Vector4())).toEqual(scissor);
    expect(rig.gl.getScissorTest()).toBe(true);
    await expect(
      renderCompositionToBytes(
        rig.gl,
        () => {
          throw new Error("draw failed");
        },
        target,
      ),
    ).rejects.toThrow("draw failed");
    expect(rig.gl.getViewport(new THREE.Vector4())).toEqual(viewport);
    expect(rig.gl.getScissor(new THREE.Vector4())).toEqual(scissor);
    expect(rig.gl.getScissorTest()).toBe(true);
  });
});
