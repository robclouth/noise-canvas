import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import { blockGrid, type BlockGrid } from "../block-grid";
import { gatherPixelRanges } from "../pixel-ranges";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { WindowedCanvas } from "../windowed-canvas";
import { packedFold, padToFold } from "../constants";
import { metadataTextureRows } from "../band-layout";

const SAMPLE_RATE = 8000;
// Long enough for the two-second block grid to cut the file into eight blocks.
const DURATION_SECONDS = 16;

function packedTexture(
  data: Float32Array,
  width: number,
  height: number,
  internalFormat: "RGBA32F" | "RG32F",
): DataTexture {
  const texture = new DataTexture(data, width, height, internalFormat === "RGBA32F" ? RGBAFormat : RGFormat, FloatType);
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Resolves once `check` holds, so a test waits on the reads rather than a delay. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 500; tick++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A dab that reads no other file: no source window, no impulse window.
const NO_OTHER_FILES = { source: null, impulse: null };

describe("a canvas that holds a window of the file", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let data: SpectrogramData & { packedData: Float32Array };
  let grid: BlockGrid;
  let strokeTextures: StrokeTextures;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    const [{ transformEffect }, { passThroughEffect }] = await Promise.all([
      import("../../effects/transform-effect"),
      import("../../effects/passthrough-effect"),
    ]);
    effects = { transform: transformEffect, passthrough: passThroughEffect };
    gl = new WebGLRenderer({ antialias: false });

    data = createConstantQMockSpectrogramData({
      durationSeconds: DURATION_SECONDS,
      sampleRate: SAMPLE_RATE,
      bandsPerOctave: 4,
    });
    const packed = data.packedData;
    for (let i = 0; i < packed.length / 4; i++) {
      packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13));
      packed[i * 4 + 1] = Math.sin(i * 0.7) * 3;
      packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29));
      packed[i * 4 + 3] = Math.cos(i * 0.41) * 3;
    }
    grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE);

    const fold = packedFold(data.texels);
    const originalPackedDataTex = packedTexture(padToFold(packed, data.texels, 4), fold.width, fold.height, "RGBA32F");
    const inverseMapTex = packedTexture(padToFold(data.inverseMap!, data.texels, 2), fold.width, fold.height, "RG32F");
    const metadataTex = packedTexture(metadataTextureRows(data), data.numBands, 1, "RGBA32F");
    const placeholderTexture = packedTexture(new Float32Array(4), 1, 1, "RGBA32F");
    disposers.push(() => {
      originalPackedDataTex.dispose();
      inverseMapTex.dispose();
      metadataTex.dispose();
      placeholderTexture.dispose();
    });
    strokeTextures = {
      originalPackedDataTex,
      inverseMapTex,
      metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    gl.dispose();
  });

  const fileDuration = (): number => data.numFrames / SAMPLE_RATE;

  function strokeParams(cursorPos: Vector2, totalDuration: number): StrokeParams {
    return {
      cursorPos,
      preview: false,
      bpm: 120,
      totalDuration,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 1,
      tiltX: 0,
      tiltY: 0,
    };
  }

  type Harness = {
    canvas: WindowedCanvas;
    /** Paints one dab at a file-UV time, through the canvas's own translation. */
    dab: (fileUvX: number) => boolean;
    /** True once no read is outstanding. */
    quiet: () => boolean;
    /** Lets the reads waiting now, and any that follow, resolve. */
    open: () => void;
    /** Makes the next read wait for `open`. */
    close: () => void;
  };

  /**
   * A canvas of `windowBlocks` blocks over the mock file, its reads served
   * from the file's own packed data. With `gated`, a read waits for `open`.
   */
  function harness(windowBlocks: number, gated = false): Harness {
    let renderer: StrokeRenderer | null = null;
    let outstanding = 0;
    let letThrough = !gated;
    const waiting: Array<() => void> = [];
    const read = async (ranges: Uint32Array): Promise<Float32Array> => {
      outstanding++;
      if (!letThrough) await new Promise<void>((resolve) => waiting.push(resolve));
      const values = gatherPixelRanges(data.packedData, ranges);
      outstanding--;
      return values;
    };

    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: read,
      readRoot: read,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    canvas.initialize(null);

    const state = createMockStateWithSteps([
      {
        name: "Dab",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    const source = (): SourceFileInfo => ({
      id: "window",
      filePath: "/window.wav",
      displayName: "window.wav",
      spectrogramData: data,
      textures: renderer!.getTextures(),
      view: canvas.span(),
    });

    return {
      canvas,
      dab: (fileUvX) => {
        renderer!.renderStroke(
          strokeParams(canvas.dabCursor(new Vector2(fileUvX, 0.35)), canvas.dabDuration(fileDuration())),
          state,
          source(),
        );
        return true;
      },
      quiet: () => outstanding === 0 && waiting.length === 0,
      open: () => {
        letThrough = true;
        while (waiting.length > 0) waiting.pop()!();
      },
      close: () => {
        letThrough = false;
      },
    };
  }

  /** The frames a dab starting at `fileUvX` covers: a beat at 120 bpm. */
  function dabFrames(fileUvX: number): { start: number; end: number } {
    const start = fileUvX * data.numFrames;
    return { start, end: Math.min(data.numFrames, start + (60 / 120) * SAMPLE_RATE) };
  }

  it("cuts the mock file into more blocks than the window holds", () => {
    expect(grid.blockCount).toBeGreaterThanOrEqual(4);
  });

  it("does not hold frames its window has left behind", async () => {
    const { canvas } = harness(2);
    await until(() => canvas.holdsFrames(0, 1), "the first window");
    const last = dabFrames(0.9);
    expect(canvas.holdsFrames(last.start, last.end)).toBe(false);
  });

  it("holds a dab back while the canvas has no content for its block", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.close();
    rig.canvas.beginStroke();

    const far = dabFrames(0.9);
    rig.canvas.aim(far.start, far.end);
    let painted = false;
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      painted = true;
      return rig.dab(0.9);
    });
    expect(painted).toBe(false);
    expect(rig.canvas.committedFootprintUv()).toBeNull();

    rig.open();
    await until(() => painted, "the held dab");
    expect(rig.canvas.holdsFrames(far.start, far.end)).toBe(true);
  });

  it("runs held paint in the order it was given", async () => {
    const rig = harness(2, true);
    rig.open();
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.close();
    rig.canvas.beginStroke();

    const order: number[] = [];
    const far = dabFrames(0.9);
    rig.canvas.aim(far.start, far.end);
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      order.push(1);
      return rig.dab(0.9);
    });
    // The canvas still holds the start of the file, but a dab there must not
    // overtake the one already waiting.
    const near = dabFrames(0.01);
    rig.canvas.paintWhenHeld(near.start, near.end, NO_OTHER_FILES, () => {
      order.push(2);
      return true;
    });
    expect(order).toEqual([]);

    rig.open();
    await rig.canvas.settle();
    expect(order).toEqual([1, 2]);
  });

  it("brings the window back to a waiting dab when the commit settles", async () => {
    const rig = harness(2);
    await until(() => rig.canvas.holdsFrames(0, 1), "the first window");
    rig.canvas.beginStroke();

    const far = dabFrames(0.9);
    let paintedAt: number | null = null;
    rig.canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      paintedAt = 0.9;
      return rig.dab(0.9);
    });
    expect(paintedAt).toBeNull();
    // The brush ran back to the start of the file before the block landed.
    const near = dabFrames(0.01);
    rig.canvas.aim(near.start, near.end);

    await rig.canvas.settle();
    expect(paintedAt).toBe(0.9);
    const box = rig.canvas.committedFootprintUv();
    expect(box).not.toBeNull();
    // The dab landed where it was asked to, not where the brush had moved on to.
    expect(box!.timeMin).toBeGreaterThan(0.85);
  });

  it("drops paint the canvas can never take rather than stalling the commit", async () => {
    let renderer: StrokeRenderer | null = null;
    const canvas = new WindowedCanvas({
      gl,
      spectrogram: data,
      renderer: () => renderer,
      readCurrent: async () => null,
      readRoot: async () => null,
      onChanged: () => {},
      sourceBlocks: () => null,
      windowBlocks: 2,
    });
    const view = canvas.firstView(0, grid.blockFrames);
    renderer = new StrokeRenderer(gl, data, strokeTextures, "window", effects, view);
    disposers.push(() => renderer?.dispose());
    disposers.push(() => canvas.dispose());
    canvas.initialize(null);
    canvas.beginStroke();

    let painted = false;
    const far = dabFrames(0.9);
    canvas.paintWhenHeld(far.start, far.end, NO_OTHER_FILES, () => {
      painted = true;
      return true;
    });
    await canvas.settle();
    expect(painted).toBe(false);
  });

  it("paints straight through when the canvas holds the whole file", async () => {
    const rig = harness(grid.blockCount);
    expect(rig.canvas.wholeFile).toBe(true);
    let painted = false;
    const near = dabFrames(0.01);
    expect(
      rig.canvas.paintWhenHeld(near.start, near.end, NO_OTHER_FILES, () => {
        painted = true;
        return true;
      }),
    ).toBe(true);
    expect(painted).toBe(true);
    await rig.canvas.settle();
    expect(rig.quiet()).toBe(true);
  });
});
