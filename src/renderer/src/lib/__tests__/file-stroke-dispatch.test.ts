import { Vector2 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStepStateView } from "../../store";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createGL,
  createHarnessTextures,
  createStateForEffects,
  disposeHarnessTextures,
  toStrokeTextures,
} from "../../test/render-harness";
import { dabSpan, dispatchStroke, prepareStrokeBatch, type FileStrokeContext } from "../file-stroke-dispatch";
import { disposeOnsetTexture } from "../onset-map";
import { penState } from "../pen-state";
import { gatherPixelRanges } from "../pixel-ranges";
import { StrokeRenderer } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";
import { impulseNeeds } from "../impulse-need";

vi.mock("../impulse-need", { spy: true });

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

async function harness() {
  const { passThroughEffect } = await import("../../effects/passthrough-effect");
  const data = createMockSpectrogramData({
    numFrames: 300 * 64,
    sampleRate: 64,
    numBands: 4,
    pattern: "constant",
  });
  const gl = createGL();
  const textures = createHarnessTextures(data);
  const strokeRendererRef: FileStrokeContext["strokeRendererRef"] = { current: null };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = async (ranges: Uint32Array) => {
    await gate;
    return gatherPixelRanges(data.packedData, ranges);
  };
  const canvas = new WindowedCanvas({
    gl,
    spectrogram: data,
    renderer: () => strokeRendererRef.current,
    readCurrent: read,
    readRoot: read,
    onChanged: () => {},
    sourceBlocks: () => null,
    windowBlocks: 2,
  });
  const view = canvas.firstView(0, 1);
  const renderer = new StrokeRenderer(
    gl,
    data,
    toStrokeTextures(textures),
    "dispatch",
    { passthrough: passThroughEffect },
    view,
  );
  strokeRendererRef.current = renderer;
  canvas.initialize(null);
  const context: FileStrokeContext = {
    fileId: "dispatch",
    spectrogramData: data,
    strokeRendererRef,
    canvasRef: { current: canvas },
    openFiles: {
      dispatch: {
        id: "dispatch",
        filePath: "/dispatch.wav",
        displayName: "dispatch.wav",
        spectrogramData: data,
        rendererRef: {
          current: { getTextures: () => renderer.getTextures(), getCanvasView: () => canvas.span() ?? null },
        },
      },
    },
    getOpenFileByPath: () => undefined,
    createStepStateView,
    getFileOnsets: vi.fn(() => []),
    closeFile: vi.fn(),
    reachByState: new WeakMap(),
  };
  disposers.push(() => {
    release();
    canvas.dispose();
    renderer.dispose();
    disposeHarnessTextures(textures);
    disposeOnsetTexture("dispatch");
    gl.dispose();
  });
  const state = createStateForEffects(["passthrough"], {
    brushSizeTime: 1,
    brushSizePitch: 12,
    overrides: {
      activeFileId: "dispatch",
      filepathsBpm: { "/dispatch.wav": 120 },
      filepathsOnsetSensitivity: {},
      filesSelection: {},
      filesZoomY: {},
      filesOffsetY: {},
      filesZoom: { dispatch: 3 },
      filesOffset: { dispatch: 0.2 },
    },
  });
  return { context, canvas, renderer, state, release };
}

describe("file-space stroke dispatch", () => {
  it("uses the prepared source request without calculating it again", async () => {
    const { context, canvas, renderer } = await harness();
    const source = { ...context.openFiles.dispatch, id: "source", filePath: "/source.wav", rendererRef: undefined };
    context.openFiles.source = source;
    context.getOpenFileByPath = () => source;
    const state = createStateForEffects(["passthrough"], {
      brushSizeTime: 1,
      stepOverrides: { sourceFile: { path: "/source.wav", name: "source" } },
      overrides: { activeFileId: "dispatch", filepathsBpm: { "/dispatch.wav": 120 } },
    });
    const resolve = vi.spyOn(renderer, "sourceReadFrames");
    const aimSource = vi.spyOn(canvas, "aimSource");
    vi.spyOn(canvas, "holdsFrames").mockReturnValue(true);
    const aim = new Vector2(0.5, 0.5);
    const span = dabSpan(context, state, aim, canvas);
    expect(span.needs.sources).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(dispatchStroke(context, state, aim, false, undefined, span)).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(aimSource.mock.calls[0][0]).toBe(span.needs.sources[0]);
  });

  it("uses the prepared impulse request without calculating it again", async () => {
    const { context, canvas } = await harness();
    const state = createStateForEffects(["convolve"], {
      brushSizeTime: 1,
      stepOverrides: { convolveIrSize: 2 },
      overrides: { activeFileId: "dispatch", filepathsBpm: { "/dispatch.wav": 120 } },
    });
    vi.mocked(impulseNeeds).mockClear();
    vi.spyOn(canvas, "holdsFrames").mockReturnValue(true);
    const aimImpulse = vi.spyOn(canvas, "aimImpulse").mockReturnValue(null);
    const aim = new Vector2(0.5, 0.5);
    const span = dabSpan(context, state, aim, canvas);
    expect(span.needs.impulses).toHaveLength(1);
    expect(impulseNeeds).toHaveBeenCalledTimes(1);
    expect(dispatchStroke(context, state, aim, false, undefined, span)).toBe(false);
    expect(impulseNeeds).toHaveBeenCalledTimes(1);
    expect(aimImpulse.mock.calls[0][0]).toBe(span.needs.impulses[0]);
  });

  it("keeps held batch state, admission spans and order while reading the pen at dispatch", async () => {
    const { context, canvas, renderer, state, release } = await harness();
    const penBefore = { ...penState };
    disposers.push(() => Object.assign(penState, penBefore));
    const render = vi.spyOn(renderer, "renderStroke");
    const admit = vi.spyOn(canvas, "paintWhenHeld");
    const held = vi.spyOn(canvas, "holdsFrames");
    const prefetch = vi.spyOn(canvas, "prefetch");
    const secondState = { ...state, filepathsBpm: { "/dispatch.wav": 90 } };
    const strokes = [
      { state, aimX: 0.9, aimY: 0.5 },
      { state: secondState, aimX: 0.1, aimY: 0.5 },
    ];
    const ahead = [{ state, aimX: 0.95, aimY: 0.5 }];
    const aheadSpan = dabSpan(context, state, new Vector2(ahead[0].aimX, ahead[0].aimY), canvas);
    canvas.beginStroke();
    expect(canvas.wholeFile).toBe(false);
    expect(prepareStrokeBatch(context, canvas, strokes, ahead)).toBe(2);
    expect(render).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledWith(aheadSpan.startFrame, aheadSpan.endFrame);
    expect(prefetch.mock.invocationCallOrder[0]).toBeLessThan(admit.mock.invocationCallOrder[0]);
    const admitted = [...admit.mock.calls];
    const otherState = createStateForEffects(["passthrough"], { brushSizeTime: 8 });
    for (const stroke of strokes) {
      stroke.state = otherState;
      stroke.aimX = 0.5;
    }
    Object.assign(penState, { pressure: 0.7, tiltX: 12, tiltY: -8 });
    release();
    await canvas.settle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0][1]).toBe(state);
    expect(render.mock.calls[1][1]).toBe(secondState);
    expect(render.mock.calls.map(([params]) => params.bpm)).toEqual([120, 90]);
    for (const [params] of render.mock.calls) {
      expect(params).toMatchObject({
        viewZoomPower: 3,
        viewOffset: 0.2,
        pressure: 0.7,
        tiltX: 12,
        tiltY: -8,
      });
    }
    for (const [start, end, needs] of admitted) {
      expect(held).toHaveBeenCalledWith(start, end, needs.original);
    }
    expect(canvas.committedFootprintUv()).not.toBeNull();
    expect(context.closeFile).not.toHaveBeenCalled();
  });

  it("uses the supplied anchored interval without resolving the brush again", async () => {
    const { context, canvas, renderer, state, release } = await harness();
    const aim = new Vector2(0.5, 0.5);
    const span = dabSpan(context, state, aim, canvas);
    const held = vi.spyOn(canvas, "holdsFrames");
    const render = vi.spyOn(renderer, "renderStroke");
    const onsetCalls = vi.mocked(context.getFileOnsets).mock.calls.length;
    canvas.beginStroke();
    canvas.paintWhenHeld(span.startFrame, span.endFrame, span.needs, () =>
      dispatchStroke(context, state, aim, false, undefined, span),
    );
    release();
    await canvas.settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(held).toHaveBeenCalledWith(span.startFrame, span.endFrame, span.needs.original);
    expect(context.getFileOnsets).toHaveBeenCalledTimes(onsetCalls);
    expect(render.mock.calls[0][0].cursorPos).toEqual(canvas.dabCursor(aim));
    expect(render.mock.calls[0][0].totalDuration).toBe(canvas.dabDuration(300));
  });
});
