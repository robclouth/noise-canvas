import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Scene,
  Texture,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpectrogramData, State } from "../../store/types";
import { createDisplayTestMaterial } from "../../test/display-test-material";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState, createMockStateWithSteps } from "../../test/mock-state";
import {
  blockGrid,
  blockOfFrame,
  blockPixelRanges,
  blockTexels,
  PACKED_BYTES_PER_TEXEL,
  type BlockGrid,
} from "../block-grid";
import { NEUTRAL_ALGORITHM, packedFold, padToFold } from "../constants";
import { bakeOnsetTexture } from "../onset-map";
import { BlockSlotCache } from "../block-slot-cache";
import { canvasViewOf, composeViewContent, fileRangesToView, type CanvasView } from "../canvas-view";
import { strokeReach } from "../effect-reach";
import { levelDecimation } from "../display-pyramid";
import { DisplayTileRing } from "../display-tiles-textures";
import { PackedWindow } from "../packed-window";
import { gatherPixelRanges } from "../pixel-ranges";
import type { Selection } from "../selection";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";
import { metadataTextureRows } from "../band-layout";

async function loadEffects(): Promise<EffectsRegistry> {
  const [
    { transformEffect },
    { passThroughEffect },
    { dynamicsEffect },
    { synthesizeEffect },
    { blurEffect },
    { cloneEffect },
  ] = await Promise.all([
    import("../../effects/transform-effect"),
    import("../../effects/passthrough-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/synthesize-effect"),
    import("../../effects/blur-effect"),
    import("../../effects/clone-effect"),
  ]);
  return {
    transform: transformEffect,
    passthrough: passThroughEffect,
    dynamics: dynamicsEffect,
    synthesize: synthesizeEffect,
    blur: blurEffect,
    clone: cloneEffect,
  };
}

function dataTexture(
  data: Float32Array,
  width: number,
  height: number,
  format: typeof RGBAFormat | typeof RGFormat,
  internalFormat: "RGBA32F" | "RG32F",
): DataTexture {
  const texture = new DataTexture(data, width, height, format, FloatType);
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>, length: number): number {
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const SAMPLE_RATE = 8000;

describe("stroke parity between a whole-file canvas and a sub-view canvas", () => {
  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  let data: SpectrogramData & { packedData: Float32Array };
  let grid: BlockGrid;
  let view: CanvasView;
  let viewFrames: number;
  let strokeTextures: StrokeTextures;
  const fileCursor = new Vector2(0.4, 0.35);
  let viewCursor: Vector2;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    effects = await loadEffects();
    gl = new WebGLRenderer({ antialias: false });

    data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
    // Every texel gets its own value, so a read from the wrong place shows.
    const packed = data.packedData;
    for (let i = 0; i < packed.length / 4; i++) {
      packed[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.13));
      packed[i * 4 + 1] = Math.sin(i * 0.7) * 3;
      packed[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.29));
      packed[i * 4 + 3] = Math.cos(i * 0.41) * 3;
    }

    grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, SAMPLE_RATE, 0.25);
    expect(grid.blockCount).toBeGreaterThanOrEqual(8);
    view = canvasViewOf(grid, 2, 5);
    viewFrames = view.endFrame - view.startFrame;
    viewCursor = new Vector2((fileCursor.x * data.numFrames - view.startFrame) / viewFrames, fileCursor.y);

    const fold = packedFold(data.texels);
    const originalPackedDataTex = dataTexture(
      padToFold(packed, data.texels, 4),
      fold.width,
      fold.height,
      RGBAFormat,
      "RGBA32F",
    );
    const inverseMapTex = dataTexture(
      padToFold(data.inverseMap!, data.texels, 2),
      fold.width,
      fold.height,
      RGFormat,
      "RG32F",
    );
    const metadataTex = dataTexture(metadataTextureRows(data), data.numBands, 1, RGBAFormat, "RGBA32F");
    const placeholderTexture = dataTexture(new Float32Array(4), 1, 1, RGBAFormat, "RGBA32F");
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

  function strokeParams(
    cursor: Vector2,
    totalDuration: number,
    pressure = 1,
    destOnsetTexture?: Texture,
  ): StrokeParams {
    return {
      cursorPos: cursor,
      preview: false,
      bpm: 120,
      totalDuration,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure,
      tiltX: 0,
      tiltY: 0,
      destOnsetTexture,
    };
  }

  /**
   * The renderer as its own paint source. The file's own spectrogram travels
   * with the canvas, so `span` is what tells the shaders which part of it the
   * canvas holds.
   */
  function sourceFor(renderer: StrokeRenderer, span?: CanvasView, onsetTexture?: Texture): SourceFileInfo {
    return {
      id: "parity",
      filePath: "/parity.wav",
      displayName: "parity.wav",
      spectrogramData: data,
      textures: renderer.getTextures(),
      view: span,
      onsetTexture,
    };
  }

  function subViewRenderer(span: CanvasView = view): StrokeRenderer {
    const renderer = new StrokeRenderer(gl, data, strokeTextures, "parity", effects, span);
    renderer.initialize();
    // Original reads are addressed through the canvas metadata, so a sub-view
    // canvas takes a window of the original, as the app's canvas does.
    const original = dataTexture(
      composeViewContent(span, data.packedData),
      span.textureWidth,
      span.textureHeight,
      RGBAFormat,
      "RGBA32F",
    );
    renderer.setOriginalTexture(original);
    disposers.push(() => {
      renderer.dispose();
      original.dispose();
    });
    return renderer;
  }

  /** The RG pairs of a display texture, read back through a full-precision pass. */
  function readDisplayTexture(tex: Texture, width: number, height: number): Float32Array {
    const material = new RawShaderMaterial({
      uniforms: { srcTex: { value: tex } },
      vertexShader: /* glsl */ `
        in vec3 position;
        in vec2 uv;
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D srcTex;
        in vec2 vUv;
        layout(location = 0) out vec4 outColor;
        void main() {
          outColor = vec4(texture(srcTex, vUv).rg, 0.0, 1.0);
        }
      `,
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Float32Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    target.dispose();
    material.dispose();
    return pixels;
  }

  /** The largest magnitude and phase gaps between two packed states, over their first `texels`. */
  function gaps(a: Float32Array, b: Float32Array, texels: number): { magnitude: number; phase: number } {
    let magnitude = 0;
    let phase = 0;
    for (let i = 0; i < texels * 4; i++) {
      const diff = Math.abs(a[i] - b[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
      else phase = Math.max(phase, diff);
    }
    return { magnitude, phase };
  }

  it("paints a dab in clipped spans as it paints it whole, reach and all", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Blurred",
        overrides: {
          blurAmountTime: 4,
          blurAmountPitch: 0,
          blurNoiseTime: 0,
          blurEdgeMode: 1,
          effects: [{ id: "blur", effect: "blur", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };
    const duration = data.numFrames / SAMPLE_RATE;
    const paint = async (clips: ({ frameStart: number; frameEnd: number } | null)[]): Promise<Float32Array> => {
      const renderer = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
      renderer.initialize();
      renderer.setFBOData(data.packedData);
      disposers.push(() => renderer.dispose());
      renderer.beginStroke();
      for (const clip of clips) {
        renderer.renderStroke({ ...strokeParams(fileCursor, duration), clip }, state, sourceFor(renderer));
      }
      return await renderer.getFBOData();
    };
    const whole = await paint([null]);
    // The dab starts at 0.4 of the file and runs a beat; a block edge falls inside it.
    const edge = 4 * grid.blockFrames;
    expect(edge).toBeGreaterThan(fileCursor.x * data.numFrames);
    const split = await paint([
      { frameStart: edge, frameEnd: data.numFrames },
      { frameStart: 0, frameEnd: edge },
    ]);
    expect(firstDifference(whole, data.packedData, data.texels * 4)).not.toBe(-1);
    const gap = gaps(split, whole, data.texels);
    expect(gap.magnitude, `largest magnitude difference ${gap.magnitude}`).toBeLessThan(1e-6);
    expect(gap.phase, `largest phase difference ${gap.phase}`).toBeLessThan(1e-5);
  });

  it("paints a brush the length of the file over a sub-view as over the whole file", async () => {
    const state = createMockStateWithSteps([
      // A curve over time, so the brush weighs each part of the file differently.
      { name: "Full", overrides: { brushSizeTime: 32, brushCurveTime: 0, transformShiftSemis: 3 } },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    whole.beginStroke();
    whole.renderStroke(strokeParams(fileCursor, data.numFrames / SAMPLE_RATE), state, sourceFor(whole));
    const inView = composeViewContent(view, await whole.getFBOData());

    // The span stops a block short of the view's end, as the window keeps a
    // block past what it paints: the last bin's reads reach past the view.
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));
    sub.beginStroke();
    const clipEnd = viewFrames - grid.blockFrames;
    sub.renderStroke(
      { ...strokeParams(viewCursor, viewFrames / SAMPLE_RATE), clip: { frameStart: 0, frameEnd: clipEnd } },
      state,
      sourceFor(sub, view),
    );
    const subData = await sub.getFBOData();
    const layout = { numBands: data.numBands, metadata: data.metadata };
    const painted: number[] = [];
    for (let block = view.firstBlock; block < view.lastBlock; block++) {
      const list = blockPixelRanges(grid, block);
      painted.push(...fileRangesToView(view, layout, list.ranges.slice(0, list.count * 2))!);
    }
    const within = Uint32Array.from(painted);
    const before = gatherPixelRanges(composeViewContent(view, data.packedData), within);
    expect(firstDifference(gatherPixelRanges(inView, within), before, before.length)).not.toBe(-1);
    // Past the span the sub-view leaves the canvas as it was.
    const last = blockPixelRanges(grid, view.lastBlock);
    const outside = fileRangesToView(view, layout, last.ranges.slice(0, last.count * 2))!;
    const untouched = gatherPixelRanges(composeViewContent(view, data.packedData), outside);
    expect(firstDifference(gatherPixelRanges(subData, outside), untouched, untouched.length)).toBe(-1);
    const withinSub = gatherPixelRanges(subData, within);
    const gap = gaps(withinSub, gatherPixelRanges(inView, within), withinSub.length / 4);
    expect(gap.magnitude, `largest magnitude difference ${gap.magnitude}`).toBeLessThan(1e-4);
    expect(gap.phase, `largest phase difference ${gap.phase}`).toBeLessThan(1e-2);
  });

  it("commits the same coefficients through a sub-view as through the whole file", async () => {
    const state = createMockState();

    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());

    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    whole.beginStroke();
    whole.renderStroke(strokeParams(fileCursor, data.numFrames / SAMPLE_RATE), state, sourceFor(whole));
    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));

    const wholeData = await whole.getFBOData();
    const subData = await sub.getFBOData();

    // The stroke must have painted, and only inside the view's file span.
    let changed = 0;
    for (let i = 0; i < data.packedData.length; i++) if (wholeData[i] !== data.packedData[i]) changed++;
    expect(changed).toBeGreaterThan(0);
    const inView = composeViewContent(view, wholeData);
    const outside = Float32Array.from(wholeData);
    for (let band = 0; band < view.layout.numBands; band++) {
      const fileStart = view.ranges[band * 2];
      const count = view.ranges[band * 2 + 1];
      outside.set(data.packedData.subarray(fileStart * 4, (fileStart + count) * 4), fileStart * 4);
    }
    let leaked = 0;
    for (let i = 0; i < data.packedData.length; i++) if (outside[i] !== data.packedData[i]) leaked++;
    expect(leaked).toBe(0);

    // The sub-view stroke lands on the same coefficients. The two paths
    // compute the same positions from different texture bases, so values
    // agree to float rounding rather than bit-for-bit: magnitudes vary
    // smoothly and stay tight, while interpolated reads across the seeded
    // random phase jumps amplify a last-bit position difference.
    let maxMagnitude = 0;
    let maxPhase = 0;
    for (let i = 0; i < view.texels * 4; i++) {
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) maxMagnitude = Math.max(maxMagnitude, diff);
      else maxPhase = Math.max(maxPhase, diff);
    }
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-5);
    expect(maxPhase, `largest phase difference ${maxPhase}`).toBeLessThan(1e-3);
  });

  /**
   * Paints the same dab on a whole-file canvas and on the sub-view canvas and
   * returns the largest difference between them inside the view.
   */
  async function parityOf(
    state: State,
    onsetTexture?: Texture,
    span: CanvasView = view,
    selection: Selection | null = null,
  ): Promise<{ magnitude: number; phase: number; changed: number; subChanged: number }> {
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());

    const sub = subViewRenderer(span);
    sub.setFBOData(composeViewContent(span, data.packedData));
    const spanFrames = span.endFrame - span.startFrame;
    const spanCursor = new Vector2((fileCursor.x * data.numFrames - span.startFrame) / spanFrames, fileCursor.y);

    whole.beginStroke();
    whole.renderStroke(
      { ...strokeParams(fileCursor, data.numFrames / SAMPLE_RATE, 1, onsetTexture), selection },
      state,
      sourceFor(whole, undefined, onsetTexture),
    );
    sub.beginStroke();
    sub.renderStroke(
      { ...strokeParams(spanCursor, spanFrames / SAMPLE_RATE, 1, onsetTexture), selection },
      state,
      sourceFor(sub, span, onsetTexture),
    );

    const inView = composeViewContent(span, await whole.getFBOData());
    const subData = await sub.getFBOData();
    const before = composeViewContent(span, data.packedData);
    let magnitude = 0;
    let phase = 0;
    let changed = 0;
    let subChanged = 0;
    for (let i = 0; i < span.texels * 4; i++) {
      if (inView[i] !== before[i]) changed++;
      if (subData[i] !== before[i]) subChanged++;
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
      else phase = Math.max(phase, diff);
    }
    return { magnitude, phase, changed, subChanged };
  }

  /**
   * Paints one dab from a second file, once with both canvases holding their
   * whole files and once with both holding a window, and returns the largest
   * difference between the two inside the destination's view. The source
   * window spans `sourceSpanSec` of the source file.
   */
  async function crossFileParity(
    sourcePositionMode: string,
    sourceSpanSec: { start: number; end: number },
    step: { lockedOffset?: { beats: number; pitch: number }; sourceTimeOffset?: number } = {},
  ): Promise<{ magnitude: number; phase: number; changed: number }> {
    const sourceData = createConstantQMockSpectrogramData({
      durationSeconds: 3,
      sampleRate: SAMPLE_RATE,
      bandsPerOctave: 4,
    });
    const sourcePacked = sourceData.packedData;
    for (let i = 0; i < sourcePacked.length / 4; i++) {
      sourcePacked[i * 4] = 0.05 + 0.45 * (1 + Math.sin(i * 0.19));
      sourcePacked[i * 4 + 1] = Math.sin(i * 0.53) * 3;
      sourcePacked[i * 4 + 2] = 0.05 + 0.45 * (1 + Math.cos(i * 0.37));
      sourcePacked[i * 4 + 3] = Math.cos(i * 0.61) * 3;
    }
    const sourceFold = packedFold(sourceData.texels);
    const sourceTextures: StrokeTextures = {
      ...strokeTextures,
      originalPackedDataTex: dataTexture(
        padToFold(sourcePacked, sourceData.texels, 4),
        sourceFold.width,
        sourceFold.height,
        RGBAFormat,
        "RGBA32F",
      ),
      inverseMapTex: dataTexture(
        padToFold(sourceData.inverseMap!, sourceData.texels, 2),
        sourceFold.width,
        sourceFold.height,
        RGFormat,
        "RG32F",
      ),
      metadataTex: dataTexture(metadataTextureRows(sourceData), sourceData.numBands, 1, RGBAFormat, "RGBA32F"),
    };
    disposers.push(() => {
      sourceTextures.originalPackedDataTex.dispose();
      sourceTextures.inverseMapTex.dispose();
      sourceTextures.metadataTex.dispose();
    });
    const sourceGrid = blockGrid(
      { numBands: sourceData.numBands, metadata: sourceData.metadata },
      sourceData.numFrames,
      SAMPLE_RATE,
      0.25,
    );
    const sourceView = canvasViewOf(
      sourceGrid,
      blockOfFrame(sourceGrid, sourceSpanSec.start * SAMPLE_RATE),
      blockOfFrame(sourceGrid, sourceSpanSec.end * SAMPLE_RATE),
    );
    expect(sourceView.endFrame - sourceView.startFrame).toBeLessThan(sourceData.numFrames);

    // A tempo of its own, so the beat map between the two files is not the
    // identity and a source window placed by frames alone reads the wrong bins.
    const state = createMockStateWithSteps([
      {
        name: "Cross",
        overrides: {
          sourcePositionMode,
          ...step,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/source.wav": 90 };
    state.isStroking = step.lockedOffset !== undefined;

    const sourceInfo = (renderer: StrokeRenderer, span?: CanvasView): SourceFileInfo => ({
      id: "source",
      filePath: "/source.wav",
      displayName: "source.wav",
      spectrogramData: sourceData,
      textures: renderer.getTextures(),
      view: span,
    });

    const wholeSource = new StrokeRenderer(gl, sourceData, sourceTextures, "source", effects);
    wholeSource.initialize();
    wholeSource.setFBOData(sourcePacked);
    disposers.push(() => wholeSource.dispose());

    const subSource = new StrokeRenderer(gl, sourceData, sourceTextures, "source", effects, sourceView);
    subSource.initialize();
    subSource.setFBOData(composeViewContent(sourceView, sourcePacked));
    disposers.push(() => subSource.dispose());

    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());

    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    whole.beginStroke();
    whole.renderStroke(strokeParams(fileCursor, data.numFrames / SAMPLE_RATE), state, sourceInfo(wholeSource));
    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceInfo(subSource, sourceView));

    const inView = composeViewContent(view, await whole.getFBOData());
    const subData = await sub.getFBOData();
    const before = composeViewContent(view, data.packedData);
    let magnitude = 0;
    let phase = 0;
    let changed = 0;
    for (let i = 0; i < view.texels * 4; i++) {
      if (inView[i] !== before[i]) changed++;
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
      else phase = Math.max(phase, diff);
    }
    return { magnitude, phase, changed };
  }

  it.each([
    // Follow reads the source at the destination's own beat, so the window has
    // to sit where that beat falls in the source file.
    { mode: "follow", start: 0.75, end: 2.25, step: {} },
    // Anchored holds the offset the stroke started with, in the source file's
    // own UV, so the window has to read it as a position in the file.
    { mode: "anchored", start: 0.5, end: 2, step: { lockedOffset: { beats: -0.05, pitch: 0 } } },
    // Fixed reads from the brush anchor, and the source time offset is a
    // fraction of the source file's whole length.
    { mode: "fixed", start: 1, end: 2.25, step: { sourceTimeOffset: 40 } },
  ])("reads the same source frames in $mode mode through windows on both files", async ({ mode, start, end, step }) => {
    const parity = await crossFileParity(mode, { start, end }, step);
    expect(parity.changed).toBeGreaterThan(0);
    // Both paths reach the same source position by different routes: the
    // whole-file path scales the file's UV once, the windowed path folds the
    // file offset onto two windows. The last bits differ, and interpolated
    // reads across the seeded random phase jumps amplify that.
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  it("re-anchors transient phase at the same onsets through a sub-view", async () => {
    const onsets = [0.15, 0.42, 0.61, 0.88, 1.35, 1.7].map((timeSec) => ({ timeSec, strength: 1 }));
    const onsetTexture = bakeOnsetTexture(onsets, data.numFrames / SAMPLE_RATE);
    disposers.push(() => onsetTexture.dispose());

    // Sharp warp reads the onset map to re-anchor transient phase, so it takes
    // absolute file positions the view has to keep pointing at.
    const state = createMockStateWithSteps([
      {
        name: "Onsets",
        overrides: {
          algorithm: NEUTRAL_ALGORITHM,
          transformShiftBeats: 0.25,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftBeats: 0.25 } }],
        },
      },
    ]);
    const parity = await parityOf(state, onsetTexture);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-5);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  it("puts a modulator pattern at the same file positions through a sub-view", async () => {
    // A rate that does not divide the view's offset into whole cycles, so a
    // pattern anchored on the view rather than the file lands out of step.
    const state = createMockStateWithSteps([
      {
        name: "Modulated",
        overrides: {
          effects: [
            {
              id: "dynamics",
              effect: "dynamics",
              enabled: true,
              params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
            },
          ],
          modulator1Mode: 0,
          modulator1PatternShape: 0,
          modulator1PatternRateBeats: 0.7,
          modulator1PatternRateSemis: 0,
          modulator1Strength: 100,
          modulator1StereoSpread: 0,
          modulator1PhaseMode: 0,
          modulator1PhaseX: 0,
          modulator1PhaseY: 0,
        },
      },
    ]);
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    // The gain comes from a pattern read at a UV rebuilt from the view, so a
    // last-bit difference in position sweeps the gain a little either way.
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-3);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  it.each([
    // Noise draws its value per texel, the impulse sets its phase against
    // absolute time: one needs the file's texel, the other the file's clock.
    { name: "noise", synthesizeBrushType: 0 },
    { name: "impulse", synthesizeBrushType: 2 },
  ])("synthesises the same $name through a sub-view", async ({ synthesizeBrushType }) => {
    const state = createMockStateWithSteps([
      {
        name: "Synthesised",
        overrides: {
          synthesizeBrushType,
          effects: [{ id: "synthesize", effect: "synthesize", enabled: true, params: {} }],
        },
      },
    ]);
    state.synthesizeBrushType = synthesizeBrushType;
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-5);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  // A reversal turns phase by the whole file's duration, so every warp
  // algorithm that applies that turn has to ask the file rather than the span
  // the canvas holds. The scale sits a hair off an exact mirror: at exactly -1
  // the read lands on bin edges, and the algorithms that difference adjacent
  // stored phases floor a value whose last bit decides which pair they take.
  it.each([0, 2, 3, NEUTRAL_ALGORITHM])(
    "turns reversed phase under algorithm %i against the file, not the canvas",
    async (algorithm) => {
      const state = createMockStateWithSteps([
        {
          name: "Reversed",
          overrides: {
            algorithm,
            transformScaleTime: -1.013,
            effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
          },
        },
      ]);
      const parity = await parityOf(state);
      expect(parity.changed).toBeGreaterThan(0);
      expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(2e-5);
      // A turn taken against the canvas instead of the file is out by radians.
      expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(0.1);
    },
  );

  // A step with no source of its own reads the canvas it paints on, which is a
  // window of the file like any other: a position or an offset in the file
  // lands on the frames it names, not on the span's own UV.
  it.each([
    ["a fixed position", { sourcePositionMode: "fixed", sourceTimeOffset: 40 }],
    ["a locked offset", { sourcePositionMode: "anchored", lockedOffset: { beats: -0.1, pitch: 0 } }],
  ])("reads this file at %s through a sub-view", async (_, step) => {
    const state = createMockStateWithSteps([
      {
        name: "Clone",
        overrides: { ...step, effects: [{ id: "passthrough", effect: "passthrough", enabled: true, params: {} }] },
      },
    ]);
    state.isStroking = "lockedOffset" in step;
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.subChanged).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-5);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  it("clips a stroke to a selection at the same file frames through a sub-view", async () => {
    const state = createMockState();
    // The dab starts 0.8 s into the file; the selection takes a middle part of it.
    const selection: Selection = { start: 0.9, end: 1.1, pitchLo: 0.2, pitchHi: 0.6 };
    const parity = await parityOf(state, undefined, view, selection);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.subChanged).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-5);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  // A smear and a repeat gap are offsets added to a source UV, so the beats
  // they are given convert against the span the source textures hold. Against
  // the file instead, a windowed canvas smears and spaces by the wrong
  // fraction of what it holds. Both average many taps, so their rounding is
  // looser than a single read.
  it("smears a blur over the same span through a sub-view", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Blurred",
        overrides: {
          blurAmountTime: 4,
          blurAmountPitch: 0,
          blurNoiseTime: 0,
          blurEdgeMode: 1,
          effects: [{ id: "blur", effect: "blur", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  // Cut drops every tap that lands outside the brush, so a blur wider than the
  // view reads nothing the view lacks and has to match exactly.
  it("cuts a blur at the same taps through a sub-view", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Blurred",
        overrides: {
          blurAmountTime: 25,
          blurAmountPitch: 0,
          blurNoiseTime: 0,
          blurEdgeMode: 0,
          effects: [{ id: "blur", effect: "blur", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  it("spaces repeat copies by the same gap through a sub-view", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Cloned",
        overrides: {
          cloneCountX: 2,
          cloneCountY: 0,
          cloneSpaceBeats: 0.05,
          cloneEdgeMode: 1,
          effects: [{ id: "clone", effect: "clone", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  // A turn trades a distance in time for a distance in pitch, so it is taken on
  // the file's time axis. Taken on the canvas's, a shorter canvas turns the
  // sound by a different amount and the read lands somewhere else entirely.
  it.each([5, 30, 90])("turns the sound by %i degrees on the file's axis", async (degrees) => {
    const state = createMockStateWithSteps([
      {
        name: "Turned",
        overrides: {
          transformRotation: degrees,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);
    state.transformRotation = degrees;
    state.filepathsBpm = { "/parity.wav": 120 };
    const parity = await parityOf(state);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  // The declared reach is what tells the canvas how much of the file to hold
  // around a dab. A view that holds the dab alone reads past its own edge and
  // paints the wrong values; the same view widened by the reach is at parity.
  it("holds what a shifted warp reads once the view covers its reach", async () => {
    const state = createMockStateWithSteps([
      {
        name: "Shifted",
        overrides: {
          transformShiftBeats: 1.5,
          transformEdgeMode: 1,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);
    state.filepathsBpm = { "/parity.wav": 120 };

    const fileSeconds = data.numFrames / SAMPLE_RATE;
    const reach = strokeReach(state, {
      bpm: 120,
      fileSeconds,
      canvasSeconds: viewFrames / SAMPLE_RATE,
      bandsPerOctave: data.bandsPerOctave,
      numBands: data.numBands,
    });
    expect(reach.before).toBeGreaterThan(0);

    const tight = await parityOf(state);
    expect(tight.magnitude, "a view holding only the dab reads past its edge").toBeGreaterThan(0.1);

    const wide = canvasViewOf(
      grid,
      blockOfFrame(grid, view.startFrame - reach.before * SAMPLE_RATE),
      blockOfFrame(grid, view.endFrame - 1 + reach.after * SAMPLE_RATE),
    );
    const parity = await parityOf(state, undefined, wide);
    expect(parity.changed).toBeGreaterThan(0);
    expect(parity.magnitude, `largest magnitude difference ${parity.magnitude}`).toBeLessThan(1e-4);
    expect(parity.phase, `largest phase difference ${parity.phase}`).toBeLessThan(1e-3);
  });

  /** A packed texture read back through a full-precision 1:1 pass. */
  function readPackedTexture(tex: Texture, width: number, height: number): Float32Array {
    const material = new RawShaderMaterial({
      uniforms: { srcTex: { value: tex } },
      vertexShader: /* glsl */ `
        in vec3 position;
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D srcTex;
        layout(location = 0) out vec4 outColor;
        void main() { outColor = texelFetch(srcTex, ivec2(gl_FragCoord.xy), 0); }
      `,
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    const pixels = new Float32Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    target.dispose();
    material.dispose();
    return pixels;
  }

  it("composes a window of the packed state as the view lays it out", async () => {
    const window = new PackedWindow(gl, grid, {
      windowBlocks: view.lastBlock - view.firstBlock + 1,
      maxBytes: 0,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => window.dispose());
    expect(await window.hold(view)).toBe(true);
    expect(window.view).toBe(view);
    expect(window.holds(view)).toBe(true);

    const composed = readPackedTexture(window.texture, view.textureWidth, view.textureHeight);
    const expected = composeViewContent(view, data.packedData);
    expect(firstDifference(composed, expected, view.texels * 4)).toBe(-1);
  });

  it("reads the original through a window of the file's blocks", async () => {
    const state = createMockStateWithSteps([
      {
        name: "From the original",
        overrides: {
          sourceDataMode: "original",
          effects: [{ id: "transform", effect: "transform", enabled: true, params: {} }],
        },
      },
    ]);

    // The canvas has to differ from the original, or a dab reading the wrong
    // one paints the same coefficients either way.
    const painted = Float32Array.from(data.packedData, (value, i) => (i % 2 === 0 ? value * 0.25 : value + 1.7));

    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(painted);
    disposers.push(() => whole.dispose());

    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, painted));
    const original = new PackedWindow(gl, grid, {
      windowBlocks: view.lastBlock - view.firstBlock + 1,
      maxBytes: 0,
      read: async (ranges) => gatherPixelRanges(data.packedData, ranges),
    });
    disposers.push(() => original.dispose());
    expect(await original.hold(view)).toBe(true);
    sub.setOriginalTexture(original.texture);

    whole.beginStroke();
    whole.renderStroke(strokeParams(fileCursor, data.numFrames / SAMPLE_RATE), state, sourceFor(whole));
    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));

    const inView = composeViewContent(view, await whole.getFBOData());
    const subData = await sub.getFBOData();
    const before = composeViewContent(view, painted);
    let changed = 0;
    let magnitude = 0;
    let phase = 0;
    for (let i = 0; i < view.texels * 4; i++) {
      if (inView[i] !== before[i]) changed++;
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) magnitude = Math.max(magnitude, diff);
      else phase = Math.max(phase, diff);
    }
    expect(changed).toBeGreaterThan(0);
    expect(magnitude, `largest magnitude difference ${magnitude}`).toBeLessThan(1e-5);
    expect(phase, `largest phase difference ${phase}`).toBeLessThan(1e-3);
  });

  it("paints over a canvas composed from block slots and patches the blocks with the result", async () => {
    const state = createMockState();
    const cache = new BlockSlotCache(gl, grid, grid.blockCount * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL);
    disposers.push(() => cache.dispose());
    const viewBlocks: number[] = [];
    for (let block = view.firstBlock; block <= view.lastBlock; block++) viewBlocks.push(block);
    for (const block of viewBlocks) {
      const list = blockPixelRanges(grid, block);
      cache.upload(block, gatherPixelRanges(data.packedData, list.ranges.subarray(0, list.count * 2)));
    }

    const sub = subViewRenderer();
    cache.compose(view, viewBlocks, sub.getTextures().packed);
    const seeded = await sub.getFBOData();
    expect(firstDifference(seeded, composeViewContent(view, data.packedData), view.texels * 4)).toBe(-1);

    sub.beginStroke();
    sub.renderStroke(strokeParams(viewCursor, viewFrames / SAMPLE_RATE), state, sourceFor(sub, view));
    const painted = await sub.getFBOData();
    expect(firstDifference(painted, seeded, view.texels * 4)).not.toBe(-1);

    // A view lays its bands end to end in file band order, so its texels are
    // already the compact values of its file ranges.
    cache.patch(view.ranges, painted.slice(0, view.texels * 4));
    const target = new WebGLRenderTarget(view.textureWidth, view.textureHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    disposers.push(() => target.dispose());
    cache.compose(view, viewBlocks, target);
    const roundTripped = new Float32Array(target.width * target.height * 4);
    gl.readRenderTargetPixels(target, 0, 0, target.width, target.height, roundTripped);
    expect(firstDifference(roundTripped, painted, view.texels * 4)).toBe(-1);
  });

  it("cuts the same display pyramid bins and ring tiles through a sub-view", () => {
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    // Pyramid level 0: every bin whose tap lies inside the view matches.
    const level = whole.getDisplayPyramid()!.levels[0];
    const wholeLevel = readDisplayTexture(
      whole.getDisplayPyramid()!.texture(0)!,
      level.textureWidth,
      level.textureHeight,
    );
    const subLevel = readDisplayTexture(sub.getDisplayPyramid()!.texture(0)!, level.textureWidth, level.textureHeight);
    let compared = 0;
    let nonzero = 0;
    let mismatchAt = -1;
    for (let band = 0; band < view.layout.numBands && mismatchAt === -1; band++) {
      const decimation = levelDecimation(level, data.metadata[band * 4 + 2], band);
      const first = view.bandK0[band];
      const start = Math.ceil(first / decimation);
      const end = Math.ceil((first + view.layout.metadata[band * 4 + 1]) / decimation);
      for (let bin = start; bin < end; bin++) {
        const at = (level.metadata[band * 4] + bin) * 4;
        if (subLevel[at] !== wholeLevel[at] || subLevel[at + 1] !== wholeLevel[at + 1]) {
          mismatchAt = at;
          break;
        }
        compared++;
        if (wholeLevel[at] !== 0) nonzero++;
      }
    }
    expect(mismatchAt, `first pyramid difference at float ${mismatchAt}`).toBe(-1);
    expect(compared).toBeGreaterThan(1000);
    expect(nonzero).toBeGreaterThan(0);

    // The tile ring cut over the view span: identical tiles from both sources.
    const fileLayout = { numBands: data.numBands, metadata: data.metadata };
    const ringTexels = 1 << 16;
    const wholeRing = new DisplayTileRing(fileLayout, data.numFrames, { maxTexels: ringTexels });
    const subRing = new DisplayTileRing(fileLayout, data.numFrames, { maxTexels: ringTexels });
    disposers.push(() => {
      wholeRing.dispose();
      subRing.dispose();
    });
    const mid = Math.round((view.startFrame + view.endFrame) / 2);
    const ringView = { framesPerPixel: 1, startFrame: mid - 128, endFrame: mid + 128, viewportPixels: 256 };
    wholeRing.update(gl, whole.committedSource(), ringView, 30);
    subRing.update(gl, sub.committedSource(), ringView, 30);
    const bound = wholeRing.uniforms();
    expect(bound.tileCount).toBeGreaterThan(0);
    expect(subRing.uniforms()).toEqual(bound);
    const width = Math.min(8192, ringTexels);
    const height = Math.ceil(ringTexels / width);
    const wholePixels = readDisplayTexture(wholeRing.texture()!, width, height);
    const subPixels = readDisplayTexture(subRing.texture()!, width, height);
    expect(firstDifference(subPixels, wholePixels, wholePixels.length)).toBe(-1);
    expect(wholePixels.some((value) => value !== 0)).toBe(true);
  });

  it("slides the view mid-stroke and keeps parity with the whole-file stroke", async () => {
    // A real pitch shift, so a dab's output differs from its blend base and a
    // wrong mask or snapshot after the slide shows up in the picture.
    const state = createMockStateWithSteps([
      {
        name: "Slide",
        overrides: {
          transformShiftSemis: 3,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());

    const viewA = canvasViewOf(grid, 1, 4);
    const viewB = canvasViewOf(grid, 3, 6);
    expect(viewB.textureWidth).toBe(viewA.textureWidth);
    expect(viewB.textureHeight).toBe(viewA.textureHeight);

    const sub = new StrokeRenderer(gl, data, strokeTextures, "parity", effects, viewA);
    sub.initialize();
    disposers.push(() => sub.dispose());
    sub.setFBOData(composeViewContent(viewA, data.packedData));

    const cache = new BlockSlotCache(gl, grid, grid.blockCount * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL);
    disposers.push(() => cache.dispose());
    for (let block = 0; block < grid.blockCount; block++) {
      const list = blockPixelRanges(grid, block);
      cache.upload(block, gatherPixelRanges(data.packedData, list.ranges.subarray(0, list.count * 2)));
    }

    const cursorFor = (v: CanvasView, fileX: number): Vector2 =>
      new Vector2((fileX * data.numFrames - v.startFrame) / (v.endFrame - v.startFrame), fileCursor.y);
    const durationFor = (v: CanvasView): number => (v.endFrame - v.startFrame) / SAMPLE_RATE;
    const x1 = 0.4;
    const x2 = 0.45;
    // The third dab reaches into the span that entered with the slide, at an
    // intensity below the earlier dabs', so a stale mask would raise it.
    const x3 = 0.55;
    const lightState = createMockStateWithSteps([
      {
        name: "Slide",
        overrides: {
          transformShiftSemis: 3,
          brushIntensity: 30,
          effects: [{ id: "transform", effect: "transform", enabled: true, params: { transformShiftSemis: 3 } }],
        },
      },
    ]);

    whole.beginStroke();
    whole.renderStroke(
      strokeParams(new Vector2(x1, fileCursor.y), data.numFrames / SAMPLE_RATE),
      state,
      sourceFor(whole),
    );
    whole.renderStroke(
      strokeParams(new Vector2(x2, fileCursor.y), data.numFrames / SAMPLE_RATE),
      state,
      sourceFor(whole),
    );
    whole.renderStroke(
      strokeParams(new Vector2(x3, fileCursor.y), data.numFrames / SAMPLE_RATE),
      lightState,
      sourceFor(whole),
    );
    const wholeData = await whole.getFBOData();

    sub.beginStroke();
    sub.renderStroke(strokeParams(cursorFor(viewA, x1), durationFor(viewA)), state, sourceFor(sub, viewA));
    sub.slideView(viewB, (target, blocks) => cache.compose(viewB, blocks, target), { midStroke: true });
    sub.renderStroke(strokeParams(cursorFor(viewB, x2), durationFor(viewB)), state, sourceFor(sub, viewB));
    sub.renderStroke(strokeParams(cursorFor(viewB, x3), durationFor(viewB)), lightState, sourceFor(sub, viewB));
    const subData = await sub.getFBOData();

    const inView = composeViewContent(viewB, wholeData);
    let maxMagnitude = 0;
    let maxPhase = 0;
    for (let i = 0; i < viewB.texels * 4; i++) {
      const diff = Math.abs(subData[i] - inView[i]);
      if (i % 2 === 0) maxMagnitude = Math.max(maxMagnitude, diff);
      else maxPhase = Math.max(maxPhase, diff);
    }
    expect(maxMagnitude, `largest magnitude difference ${maxMagnitude}`).toBeLessThan(1e-5);
    expect(maxPhase, `largest phase difference ${maxPhase}`).toBeLessThan(1e-3);

    // Both dabs really painted: the slid view differs from the committed seed.
    expect(firstDifference(subData, composeViewContent(viewB, data.packedData), viewB.texels * 4)).not.toBe(-1);
  });

  it("shows the same canvas picture through a sub-view", () => {
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    whole.setFBOData(data.packedData);
    disposers.push(() => whole.dispose());
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));

    const material = createDisplayTestMaterial();
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const width = 96;
    const height = 48;
    const target = new WebGLRenderTarget(width, height, { depthBuffer: false, stencilBuffer: false });
    disposers.push(() => {
      target.dispose();
      material.dispose();
    });

    // Zoomed to the view's span alone, so both canvases cover every pixel.
    const zoomPower = Math.log2(data.numFrames / viewFrames);
    const offset = view.startFrame / (data.numFrames - viewFrames);

    const renderCanvas = (renderer: StrokeRenderer): Uint8Array => {
      const source = renderer.committedSource();
      const u = material.uniforms;
      u.sourceSpectrogramTex.value = source.texture;
      u.sourceMetadataTex.value = strokeTextures.metadataTex;
      u.sourceInverseMapTex.value = strokeTextures.inverseMapTex;
      u.sourceMinFreq.value = data.minFreq;
      u.sourceBandsPerOctave.value = data.bandsPerOctave;
      u.sourceFrameCount.value = data.numFrames;
      u.sourceBandCount.value = data.numBands;
      u.sourceChannelCount.value = data.numChannels;
      u.sourceSampleRate.value = data.sampleRate;
      u.sourceSpectrogramTextureSize.value = data.packedTextureSize;
      u.canvasMetadataTex.value = renderer.getTextures().metadata;
      u.canvasFrameCount.value = source.view.endFrame - source.view.startFrame;
      u.canvasStartFrame.value = source.view.startFrame;
      u.viewZoomPower.value = zoomPower;
      u.viewOffset.value = offset;
      gl.setRenderTarget(target);
      gl.render(scene, camera);
      gl.setRenderTarget(null);
      const pixels = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      return pixels;
    };

    const wholePixels = renderCanvas(whole);
    const subPixels = renderCanvas(sub);

    // The two paths read the same bins from different texture bases, so the
    // pictures agree except where a pixel sits on a bin edge and float
    // rounding picks the neighbouring bin.
    let lit = 0;
    let apart = 0;
    for (let i = 0; i < wholePixels.length; i++) {
      if (wholePixels[i] > 8) lit++;
      if (Math.abs(wholePixels[i] - subPixels[i]) > 2) apart++;
    }
    expect(lit).toBeGreaterThan(wholePixels.length / 16);
    expect(apart).toBeLessThan(wholePixels.length / 100);
  });

  it("keeps the whole file in the display pyramid while the canvas holds a sub-view", () => {
    const whole = new StrokeRenderer(gl, data, strokeTextures, "parity", effects);
    whole.initialize();
    disposers.push(() => whole.dispose());
    whole.seedDisplayFromPacked(data.packedData);

    const sub = subViewRenderer();
    sub.seedDisplayFromPacked(data.packedData);

    const level = whole.getDisplayPyramid()!.levels[0];
    const readLevel = (renderer: StrokeRenderer): Float32Array =>
      readDisplayTexture(renderer.getDisplayPyramid()!.texture(0)!, level.textureWidth, level.textureHeight);
    const seeded = readLevel(whole);
    expect(firstDifference(readLevel(sub), seeded, seeded.length)).toBe(-1);

    // The canvas re-encodes what it holds; the rest of the picture stays as
    // it was seeded rather than falling back to silence.
    const louder = Float32Array.from(data.packedData);
    for (let i = 0; i < louder.length / 4; i++) {
      louder[i * 4] *= 2;
      louder[i * 4 + 2] *= 2;
    }
    sub.setFBOData(composeViewContent(view, louder));
    const afterCanvas = readLevel(sub);
    let outside = 0;
    let insideChanged = 0;
    for (let band = 0; band < view.layout.numBands; band++) {
      const decimation = levelDecimation(level, data.metadata[band * 4 + 2], band);
      const inFirst = Math.ceil(view.bandK0[band] / decimation);
      const inEnd = Math.ceil((view.bandK0[band] + view.layout.metadata[band * 4 + 1]) / decimation);
      for (let bin = 0; bin < level.metadata[band * 4 + 1]; bin++) {
        const at = (level.metadata[band * 4] + bin) * 4;
        if (bin >= inFirst && bin < inEnd) {
          if (afterCanvas[at] !== seeded[at]) insideChanged++;
          continue;
        }
        expect(afterCanvas[at], `band ${band} bin ${bin} outside the view`).toBe(seeded[at]);
        if (seeded[at] > -100) outside++;
      }
    }
    expect(outside).toBeGreaterThan(1000);
    expect(insideChanged).toBeGreaterThan(1000);

    whole.seedDisplayFromPacked(louder);
    sub.seedDisplayFromPacked(louder);
    const reseeded = readLevel(whole);
    expect(firstDifference(reseeded, seeded, seeded.length)).not.toBe(-1);
    expect(firstDifference(readLevel(sub), reseeded, reseeded.length)).toBe(-1);
  });

  it("refuses to cut ring tiles the source view does not cover", () => {
    const sub = subViewRenderer();
    sub.setFBOData(composeViewContent(view, data.packedData));
    const ring = new DisplayTileRing({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, {
      maxTexels: 1 << 16,
    });
    disposers.push(() => ring.dispose());
    expect(() =>
      ring.update(
        gl,
        sub.committedSource(),
        { framesPerPixel: 1, startFrame: 0, endFrame: 256, viewportPixels: 256 },
        30,
      ),
    ).toThrow("does not cover");
  });
});
