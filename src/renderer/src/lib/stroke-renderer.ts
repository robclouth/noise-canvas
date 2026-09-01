import { createNoise2D } from "simplex-noise";
import {
  BufferAttribute,
  Camera,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  RGFormat,
  Scene,
  Texture,
  UnsignedByteType,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { copyMaterial } from "../components/copy-material";
import { gatherMaterial } from "../components/gather-material";
import { patchMaterial } from "../components/patch-material";
import { phaseTurnMaterial } from "../components/phase-turn-material";
import { rangeCopyMaterial } from "../components/range-copy-material";
import { BaseEffect, CommonUniforms, createDefaultUniforms } from "../effects/base-effect";
import maskUpdateFrag from "../glsl/mask-update.frag";
import modulatorPrecomputeFrag from "../glsl/modulator-precompute.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { createEffectStateView, createStepStateView } from "../store";
import { hasActiveModulatorRouting, hasNestedModulatorRouting, paramsRouteModulators } from "../store/modulators";
import type { ParameterKey, SpectrogramData, State } from "../store/types";
import type { ParameterUniform } from "../types";
import { readRenderTargetPixelsAsync } from "./async-readpixels";
import { footprintAimToBlUv } from "./brush-anchor";
import { ATTRACT_MODULATOR_MAP_START } from "./constants";
import { getFileOnsets } from "./file-onsets";
import { getQuantizeLutTexture } from "./quantize-lut";
import { selectionBandRange, selectionFrameRange, selectionUvRect, type Selection } from "./selection";
import { buildModulatorUniforms } from "./modulator-utils";
import {
  brushFootprintRanges,
  fullTextureRange,
  FrameWindow,
  PixelRangeList,
  RangeQuadGeometry,
  rowRange,
} from "./range-quads";
import {
  createModContext,
  defaultParameterUniform,
  ModContext,
  parameterUniform,
  ShaderRange,
  staticModulation,
  StrokeContext,
  writeParameterUniform,
} from "./static-modulation";
import { getStrokeScratchPool, StrokeScratch, StrokeScratchPool } from "./stroke-scratch-pool";
import {
  pitchUvToBandIndex,
  resolveBrushAnchor,
  resolveBrushFootprint,
  sourceBandUvSlope,
  swungGridCellWidthUv,
} from "./utils";

// Import EffectType from the dependency-free types module
import type { EffectType } from "../effects/types";
export type { EffectType };

// Effects registry type
export type EffectsRegistry = Record<string, BaseEffect>;

const noise2D = createNoise2D();

// Unit quad in [0,1]², stretched per instance to a pixel range's bounding box
// by patchMaterial's vertex shader.
const PATCH_QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const PATCH_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const createParameterUniform = defaultParameterUniform;

// Bins of margin around the brush's time window in the final-pass footprint,
// covering the sub-bin fallback and the float32 rounding of band offsets.
const FOOTPRINT_MARGIN_BINS = 4;

// Fraction of the texture above which a stroke's footprint is written by a
// whole-texture draw and a buffer swap, rather than folded back by a copy.
const SWAP_FOOTPRINT_FRACTION = 0.5;

/** Thrown when the graphics device refuses the memory a stroke needs. */
export class GpuMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuMemoryError";
  }
}

/** The packed pixels a stroke's final pass writes, and the bins they hold per band. */
export interface StrokeFootprint extends PixelRangeList {
  binRanges: Float32Array;
  pixels: number;
}

/** Shader-unit ranges of the brush-level parameters, whose sliders run in percent. */
const BRUSH_SHADER_RANGES = {
  brushCurveTime: (step: State): ShaderRange => ({ value: (step.brushCurveTime as number) / 100, min: -1, max: 1 }),
  brushSkewTime: (step: State): ShaderRange => ({
    value: ((step.brushSkewTime as number) + 100) / 200,
    min: 0,
    max: 1,
  }),
  brushCurvePitch: (step: State): ShaderRange => ({ value: (step.brushCurvePitch as number) / 100, min: -1, max: 1 }),
  brushSkewPitch: (step: State): ShaderRange => ({
    value: ((step.brushSkewPitch as number) + 100) / 200,
    min: 0,
    max: 1,
  }),
  brushIntensity: (step: State): ShaderRange => ({ value: step.brushIntensity / 100, min: 0, max: 1 }),
  brushPan: (step: State): ShaderRange => ({ value: step.brushPan / 100, min: -1, max: 1 }),
} satisfies Partial<Record<ParameterKey, (step: State) => ShaderRange>>;

type BrushRangeKey = keyof typeof BRUSH_SHADER_RANGES;

// Source offsets read relative to the brush and carry no modulation in follow mode.
function sourceOffsetUniform(
  step: State,
  key: "sourceTimeOffset" | "sourcePitchOffset",
  ctx: ModContext,
): ParameterUniform {
  if (step.sourcePositionMode === "follow") return defaultParameterUniform(0, -1, 1);
  return parameterUniform(step, key, ctx, { value: (step[key] as number) / 100, min: -1, max: 1 });
}

function brushParamUniform(step: State, key: BrushRangeKey, ctx: ModContext): ParameterUniform {
  return parameterUniform(step, key, ctx, BRUSH_SHADER_RANGES[key](step));
}

// Brush-level modulatable uniforms whose static term is refreshed per iteration.
// Source offsets carry no modulation in follow mode.
const BRUSH_PARAM_UNIFORMS: Array<{ uniform: keyof CommonUniforms; key: ParameterKey; followZero: boolean }> = [
  { uniform: "brushCurveTime", key: "brushCurveTime", followZero: false },
  { uniform: "brushSkewTime", key: "brushSkewTime", followZero: false },
  { uniform: "brushCurvePitch", key: "brushCurvePitch", followZero: false },
  { uniform: "brushSkewPitch", key: "brushSkewPitch", followZero: false },
  { uniform: "brushIntensity", key: "brushIntensity", followZero: false },
  { uniform: "brushPan", key: "brushPan", followZero: false },
  { uniform: "sourceTimeOffset", key: "sourceTimeOffset", followZero: true },
  { uniform: "sourcePitchOffset", key: "sourcePitchOffset", followZero: true },
];

function writeBrushParamStatics(uniforms: CommonUniforms, step: State, ctx: ModContext): void {
  const follow = step.sourcePositionMode === "follow";
  for (const { uniform, key, followZero } of BRUSH_PARAM_UNIFORMS) {
    const target = (uniforms[uniform] as { value: ParameterUniform }).value;
    if (followZero && follow) {
      target.staticSum = 0;
      target.staticWeight = 0;
      continue;
    }
    const { staticSum, staticWeight } = staticModulation(step, key, target.minValue, target.maxValue, ctx);
    target.staticSum = staticSum;
    target.staticWeight = staticWeight;
  }
}

/**
 * Textures required for stroke rendering
 */
export interface StrokeTextures {
  originalPackedDataTex: DataTexture;
  inverseMapTex: DataTexture;
  metadataTex: DataTexture;
  placeholderTexture: Texture;
  modulatorScaleLut: Texture | null;
  modulator1Texture: Texture | null;
  modulator2Texture: Texture | null;
  modulator3Texture: Texture | null;
}

/**
 * Source file information for cross-file strokes
 */
export interface SourceFileInfo {
  id: string;
  filePath: string;
  displayName: string;
  spectrogramData: SpectrogramData;
  textures: {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  };
  // Nearest-onset lookup row for this file at the current sensitivity, baked by
  // lib/onset-map.ts. Null when the file has no onsets yet.
  onsetTexture?: Texture | null;
}

/**
 * Parameters for a single stroke operation
 */
export interface StrokeParams {
  // Where the user is aiming, in pitch UV. Brush size and anchor mode are
  // per-step, so each step turns this into its own bottom-left origin.
  cursorPos: Vector2;
  preview: boolean;
  bpm: number;
  totalDuration: number;
  viewZoomPower: number;
  viewOffset: number;
  viewZoomPowerY: number;
  viewOffsetY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  // The painted file's own onset map, read by passes after the first, which
  // sample the destination rather than the source file.
  destOnsetTexture?: Texture | null;
  // The file each step samples from, indexed by step. A step with no entry
  // names no source file of its own, so it reads what the steps before it
  // produced (or, for the first step, the `sourceFile` argument).
  stepSources?: readonly (SourceFileInfo | undefined)[];
  // The file's selection rectangle, which the stroke cannot paint outside.
  selection?: Selection | null;
}

/** The selection clip as the shader reads it. `active` is 0 when there is none. */
interface SelectionClip {
  active: number;
  frames: Vector2;
  bands: Vector2;
  maskActive: number;
  maskTexture: Texture | null;
}

function selectionClipFor(
  selection: Selection | null,
  data: SpectrogramData,
  maskTexture: Texture | null,
): SelectionClip {
  if (!selection) return { active: 0, frames: new Vector2(), bands: new Vector2(), maskActive: 0, maskTexture: null };
  const { startFrame, endFrame } = selectionFrameRange(selection, data.sampleRate);
  const { lowBand, highBand } = selectionBandRange(selection, data.numBands);
  return {
    active: 1,
    frames: new Vector2(startFrame, endFrame),
    bands: new Vector2(lowBand, highBand),
    maskActive: maskTexture ? 1 : 0,
    maskTexture,
  };
}

/** Where one step's brush lands, from that step's own size and anchor mode. */
interface StepGeometry {
  state: State;
  sizeUv: Vector2;
  /** Bottom-left origin in pitch UV, after Full-axis anchoring. */
  anchor: Vector2;
  fullTime: boolean;
  fullPitch: boolean;
}

/**
 * StrokeRenderer - Handles all WebGL-based stroke rendering logic.
 * Extracted from FileRenderer to enable unit testing.
 */
export class StrokeRenderer {
  private gl: WebGLRenderer;
  private spectrogramData: SpectrogramData;
  private textures: StrokeTextures;
  private fileId: string;
  private effects: EffectsRegistry;

  // FBOs for ping-pong rendering
  private fbo1: WebGLRenderTarget;
  private fbo2: WebGLRenderTarget;
  // Per-stroke scratch targets, shared across all files through the pool.
  // Bound (and refreshed if another file painted since) by acquireScratch().
  private pool: StrokeScratchPool;
  private scratch: StrokeScratch | null = null;

  // Scene objects
  private fboScene: Scene;
  private fboMesh: Mesh;
  // Instanced range quads: every effect, mask and modulator pass draws only
  // the packed pixel ranges set on it.
  private rangeScene: Scene;
  private rangeMesh: Mesh;
  private rangeGeometry: RangeQuadGeometry;
  private camera: Camera;

  // Materials
  private maskMaterial: RawShaderMaterial;
  private modulatorMaterial: RawShaderMaterial;

  // State
  // The spectrogram as it was before a preview run of committed strokes.
  // Allocated only while a preview is up.
  private rollbackFbo: WebGLRenderTarget | null = null;
  private pingPong = 0;
  private maskPingPong = 0;
  private isInitialized = false;
  // The footprint of the stroke being rendered. Its ranges and bin ranges are
  // reused across dabs.
  private footprint: StrokeFootprint;
  // Per-band bin ranges the ping-pong partner holds a preview for, as the
  // display's lookup texture. Cleared (and previewActive dropped) on commit.
  private previewRangeTex: DataTexture;
  private previewActive = false;
  // Union of the packed rows [rowStart, rowEnd) every dab since the masks were
  // last cleared has written. Outside it both mask buffers are still zero, so a
  // mask update drawn over it alone loses nothing across the ping-pong.
  private maskRows: { rowStart: number; rowEnd: number } | null = null;
  // Set when the scratch targets were (re)allocated and no stroke has yet
  // confirmed the driver accepted them.
  private scratchUnverified = false;

  // Test seam: forces every stroke onto the legacy full-texture render +
  // ping-pong-swap path instead of the footprint draw and copy-back, and the
  // stroke mask onto a full-texture update, so equivalence between the two
  // can be asserted.
  disableScissorCopyBack = false;

  // The current selection mask as a GPU texture, keyed by the mask's cell
  // array; selections change rarely, so one live texture is enough.
  private selectionMaskCache: { cells: Uint8Array; texture: DataTexture } | null = null;

  // FBO data cache
  private fboDataCache: Float32Array | null = null;
  private fboDataDirty = true;
  // Bumped on every change to the FBO contents. getFBOData() captures it before
  // its readback and keeps the result only if it still matches, so paint that
  // lands mid-read cannot leave a snapshot taken before it marked clean.
  private fboDataEpoch = 0;

  // Dirty region tracking for partial synthesis
  private dirtyRegion: { startX: number; endX: number; startY: number; endY: number } | null = null;

  // UV bounds of the committed dabs of the current stroke, accumulated across
  // its dabs and reset per stroke in beginStroke(). getDirtyPixelRanges() turns
  // these into the packed-pixel footprint the history delta stores. Kept
  // separate from dirtyRegion (which synthesis clears) so a mid-stroke clear
  // can't drop earlier dabs.
  private committedTimeMin = Infinity;
  private committedTimeMax = -Infinity;
  private committedPitchMin = Infinity;
  private committedPitchMax = -Infinity;
  // Monotonic count of stroke starts. Commit-time work that runs async after a
  // stroke (boundary conditioning) captures this before awaiting and drops its
  // result if a new stroke began meanwhile, so it never writes over new dabs.
  private strokeGeneration = 0;

  constructor(
    gl: WebGLRenderer,
    spectrogramData: SpectrogramData,
    textures: StrokeTextures,
    fileId: string,
    effects: EffectsRegistry,
  ) {
    this.gl = gl;
    this.spectrogramData = spectrogramData;
    this.textures = textures;
    this.fileId = fileId;
    this.effects = effects;

    // Create camera
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    // Create FBO scene
    this.fboScene = new Scene();
    this.fboMesh = new Mesh(new PlaneGeometry(2, 2));
    this.fboScene.add(this.fboMesh);

    const { textureWidth, textureHeight, numBands } = spectrogramData;

    this.rangeScene = new Scene();
    this.rangeGeometry = new RangeQuadGeometry(numBands * 3);
    this.rangeMesh = new Mesh(this.rangeGeometry.geometry);
    this.rangeMesh.frustumCulled = false;
    this.rangeScene.add(this.rangeMesh);

    this.footprint = {
      ranges: new Uint32Array(numBands * 6),
      count: 0,
      binRanges: new Float32Array(numBands * 4),
      pixels: 0,
    };
    this.previewRangeTex = new DataTexture(this.footprint.binRanges, numBands, 1, RGBAFormat, FloatType);
    this.previewRangeTex.minFilter = NearestFilter;
    this.previewRangeTex.magFilter = NearestFilter;
    this.previewRangeTex.needsUpdate = true;

    // Create FBOs

    this.fbo1 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.fbo2 = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.pool = getStrokeScratchPool(gl);

    // Modulator precompute material — evaluates all modulators per pixel into
    // the scratch modulatorFbo's two targets. Reuses the common-uniform set so
    // the same modulator/source/dest uniforms drive it as the effects.
    this.modulatorMaterial = new RawShaderMaterial({
      uniforms: { ...createDefaultUniforms(), nestedModulationActive: { value: false } },
      vertexShader: rangeQuadVert,
      fragmentShader: modulatorPrecomputeFrag,
      glslVersion: GLSL3,
    });

    // Create mask material
    this.maskMaterial = new RawShaderMaterial({
      uniforms: {
        ...createDefaultUniforms(),
        currentMaskTex: { value: null },
        destMetadataTex: { value: null },
        destInverseMapTex: { value: null },
        destSpectrogramTextureSize: { value: new Vector2(1, 1) },
        destFrameCount: { value: 0 },
        destBandCount: { value: 0 },
        brushBottomLeftUv: { value: new Vector2(0, 0) },
        brushSizeUv: { value: new Vector2(0, 0) },
      },
      vertexShader: rangeQuadVert,
      fragmentShader: maskUpdateFrag,
      glslVersion: GLSL3,
    });

    // The mask material mutates these ParameterUniform objects in place on the hot
    // path, so it holds its own rather than the per-step objects the effects get.
    const mu = this.maskMaterial.uniforms;
    mu.brushIntensity = { value: createParameterUniform(1, 0, 1) };
    mu.brushCurveTime = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewTime = { value: createParameterUniform(0.5, 0, 1) };
    mu.brushCurvePitch = { value: createParameterUniform(0, -1, 1) };
    mu.brushSkewPitch = { value: createParameterUniform(0.5, 0, 1) };
  }

  /**
   * Draws `material` over the packed pixel ranges of `list` into `target`,
   * leaving every other pixel of the target as it was.
   */
  private drawRanges(material: RawShaderMaterial, target: WebGLRenderTarget, list: PixelRangeList): void {
    if (list.count === 0) return;
    this.rangeGeometry.setRanges(list);
    const size = this.spectrogramData.packedTextureSize;
    if (material.uniforms.destSpectrogramTextureSize) {
      material.uniforms.destSpectrogramTextureSize.value = size;
    } else {
      material.uniforms.destSpectrogramTextureSize = { value: size };
    }
    this.rangeMesh.material = material;
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    this.gl.setRenderTarget(target);
    this.gl.render(this.rangeScene, this.camera);
    this.gl.autoClear = prevAutoClear;
  }

  /** The whole packed texture as one range. */
  private fullRange(): PixelRangeList {
    const { textureWidth, textureHeight } = this.spectrogramData;
    return fullTextureRange(textureWidth, textureHeight);
  }

  /** Marks every bin of every band as holding a preview. */
  private markWholeTexturePreview(): void {
    const { numBands, metadata } = this.spectrogramData;
    const binRanges = this.footprint.binRanges;
    for (let band = 0; band < numBands; band++) {
      binRanges[band * 4] = 0;
      binRanges[band * 4 + 1] = metadata[band * 4 + 1];
    }
  }

  /**
   * Hardware blit between two FBOs using WebGL2 blitFramebuffer (GPU DMA copy).
   */
  private blitFBO(src: WebGLRenderTarget, dst: WebGLRenderTarget): void {
    const gl2 = this.gl.getContext() as WebGL2RenderingContext;
    // Force Three.js to initialize the framebuffers by binding them
    this.gl.setRenderTarget(src);
    this.gl.setRenderTarget(dst);
    // Access internal framebuffer handles

    const props = (this.gl as any).properties as { get(obj: unknown): Record<string, unknown> };
    const srcFb = props.get(src).__webglFramebuffer as WebGLFramebuffer;
    const dstFb = props.get(dst).__webglFramebuffer as WebGLFramebuffer;
    const w = src.width;
    const h = src.height;
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, srcFb);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, dstFb);
    gl2.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
    this.gl.setRenderTarget(null);
  }

  private createFBO(width: number, height: number, format: typeof RGBAFormat | typeof RedFormat): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      format,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  /**
   * Evaluates every modulator's stereo output per pixel into the scratch
   * modulator MRT's two targets, using the step's common uniforms, over
   * `ranges`. Effects then sample these textures instead of
   * evaluating the modulators inline. Runs once per step. Returns the target.
   */
  private renderModulatorTextures(commonUniforms: CommonUniforms, ranges: PixelRangeList): WebGLRenderTarget {
    const m = this.modulatorMaterial;
    for (const key in commonUniforms) {
      const src = (commonUniforms as Record<string, { value: unknown } | undefined>)[key];
      if (!src) continue;
      if (key in m.uniforms) {
        m.uniforms[key].value = src.value;
      } else {
        m.uniforms[key] = { value: src.value };
      }
    }
    const fresh = this.scratch !== null && this.scratch.modulatorFbo === null;
    const target = this.pool.modulatorFbo();
    if (fresh) this.scratchUnverified = true;
    this.drawRanges(m, target, ranges);
    return target;
  }

  /**
   * Update the modulator image textures. They load asynchronously (and change
   * when the user picks a different image), so the values captured at
   * construction go stale; the owner re-syncs them here whenever they change.
   */
  updateModulatorTextures(
    modulator1Texture: Texture | null,
    modulator2Texture: Texture | null,
    modulator3Texture: Texture | null,
  ): void {
    this.textures.modulator1Texture = modulator1Texture;
    this.textures.modulator2Texture = modulator2Texture;
    this.textures.modulator3Texture = modulator3Texture;
  }

  /**
   * Initialize the renderer with the spectrogram data.
   * Must be called before rendering strokes.
   */
  initialize(): void {
    if (this.isInitialized) return;

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = this.textures.originalPackedDataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    this.pingPong = 0;

    // The stroke-start snapshot no longer matches the reset canvas; force the
    // next acquireScratch to rebuild it.
    this.pool.disown(this);

    this.invalidateFboData();
    this.isInitialized = true;
  }

  /**
   * Binds the shared scratch targets to this renderer. When another file
   * painted since the last call (or the texture size changed), the masks are
   * cleared and the stroke-start snapshot is rebuilt from the committed state,
   * restoring the between-strokes invariants the paint path relies on.
   */
  private acquireScratch(): StrokeScratch {
    const { textureWidth, textureHeight } = this.spectrogramData;
    const { scratch, refreshed } = this.pool.acquire(this, textureWidth, textureHeight);
    this.scratch = scratch;
    if (refreshed) {
      this.clearMasks(scratch);
      this.maskPingPong = 0;
      const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
      this.snapshotToStrokeStart(scratch, currentReadFBO.texture);
      this.scratchUnverified = true;
    }
    return scratch;
  }

  /**
   * Throws when the driver refused the scratch allocations. The targets are
   * created lazily on first bind, so the refusal only shows up as a GL error
   * after the first stroke that uses them; the check runs once per refresh.
   */
  private verifyScratchAllocation(): void {
    if (!this.scratchUnverified) return;
    this.scratchUnverified = false;
    const context = this.gl.getContext();
    // Several error flags can be latched at once and getError returns one per
    // call, so drain them all rather than trusting the first.
    let outOfMemory = false;
    for (let error = context.getError(); error !== context.NO_ERROR; error = context.getError()) {
      if (error === context.OUT_OF_MEMORY) outOfMemory = true;
    }
    if (outOfMemory) {
      throw new GpuMemoryError("The graphics device ran out of memory allocating the stroke buffers.");
    }
  }

  private clearMasks(scratch: StrokeScratch): void {
    const targets: WebGLRenderTarget[] = [];
    for (const pair of scratch.strokeMaskFbos) {
      if (pair) targets.push(pair[0], pair[1]);
    }
    this.clearMaskTargets(targets);
    this.maskRows = null;
  }

  private clearMaskTargets(targets: WebGLRenderTarget[]): void {
    if (targets.length === 0) return;
    const oldClearColor = new Color();
    this.gl.getClearColor(oldClearColor);
    const oldClearAlpha = this.gl.getClearAlpha();
    this.gl.setClearColor(0x000000, 0);
    for (const target of targets) {
      this.gl.setRenderTarget(target);
      this.gl.clear(true, false, false);
    }
    this.gl.setRenderTarget(null);
    this.gl.setClearColor(oldClearColor, oldClearAlpha);
  }

  /**
   * Snapshot the current FBO state to the strokeStartFbo.
   */
  private snapshotToStrokeStart(scratch: StrokeScratch, sourceTexture: Texture): void {
    const prevMaterial = this.fboMesh.material;

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = sourceTexture;

    const oldTarget = this.gl.getRenderTarget();
    this.gl.setRenderTarget(scratch.strokeStartFbo);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(oldTarget);

    this.fboMesh.material = prevMaterial;
  }

  /**
   * Resolve brush footprint for a given step state, taking Grid/Full sentinel
   * values on brushSizeTime/brushSizePitch into account. When `anchorTimeUv` is
   * given (the brush's BL time), a Grid-mode time brush under time-snap is sized
   * to the swung grid cell it lands in so snapped strokes tile without gaps.
   */
  resolveBrushFootprint(state: State, bpm: number, totalDuration: number, anchorTimeUv?: number) {
    const footprint = resolveBrushFootprint({
      brushSizeTime: state.brushSizeTime,
      brushSizePitch: state.brushSizePitch,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      bpm,
      totalDuration,
      bandsPerOctave: this.spectrogramData.bandsPerOctave,
      numBands: this.spectrogramData.numBands,
    });
    if (anchorTimeUv !== undefined && !footprint.fullTime) {
      const swungTimeUv = swungGridCellWidthUv(
        anchorTimeUv,
        {
          brushSizeTime: state.brushSizeTime,
          gridSizeBeats: state.gridSizeBeats,
          gridSwing: state.gridSwing,
          snapTime: state.snapTime,
          onsets: getFileOnsets(this.fileId),
        },
        bpm,
        totalDuration,
      );
      if (swungTimeUv !== null) footprint.sizeUv.x = swungTimeUv;
    }
    return footprint;
  }

  /**
   * Calculate brush size in UV coordinates from state size parameters.
   */
  calculateBrushSizeUv(state: State, bpm: number, totalDuration: number): Vector2 {
    return this.resolveBrushFootprint(state, bpm, totalDuration).sizeUv;
  }

  /**
   * Where every step of the active brush lands for one aim point. Size and
   * anchor mode are per-step parameters, so each step gets its own origin.
   */
  private resolveStepGeometries(state: State, aim: Vector2, bpm: number, totalDuration: number): StepGeometry[] {
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    const geometries: StepGeometry[] = [];
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const stepState = createStepStateView(state, stepIndex);
      const footprint = this.resolveBrushFootprint(stepState, bpm, totalDuration, aim.x);
      const { blX, blY } = footprintAimToBlUv(aim.x, aim.y, footprint, {
        anchorMode: stepState.brushAnchorMode as number,
        brushSizeTime: stepState.brushSizeTime as number,
        gridSizeBeats: stepState.gridSizeBeats,
        snapTime: stepState.snapTime,
      });
      geometries.push({
        state: stepState,
        sizeUv: footprint.sizeUv,
        anchor: resolveBrushAnchor(new Vector2(blX, blY), footprint.fullTime, footprint.fullPitch),
        fullTime: footprint.fullTime,
        fullPitch: footprint.fullPitch,
      });
    }
    return geometries;
  }

  /**
   * Points the source half of a step's uniforms at the painted file, for a step
   * that reads what the steps before it produced rather than a source file.
   */
  private pointSourceAtDest(uniforms: CommonUniforms, destOnsetTexture: Texture | null | undefined): void {
    uniforms.sourceInverseMapTex = uniforms.destInverseMapTex;
    uniforms.sourceMetadataTex = uniforms.destMetadataTex;
    uniforms.sourceMinFreq = uniforms.destMinFreq;
    uniforms.sourceBandsPerOctave = uniforms.destBandsPerOctave;
    uniforms.sourceFrameCount = uniforms.destFrameCount;
    uniforms.sourceBandCount = uniforms.destBandCount;
    uniforms.sourceChannelCount = uniforms.destChannelCount;
    uniforms.sourceSampleRate = uniforms.destSampleRate;
    uniforms.sourceSpectrogramTextureSize = uniforms.destSpectrogramTextureSize;
    uniforms.sourceOnsetTex = { value: destOnsetTexture ?? this.textures.placeholderTexture };
    uniforms.sourceTimeScale = { value: 1 };
    uniforms.sourceBandScale = { value: 1 };
  }

  /**
   * Calculate clone-stamp offset from the cursor position, scaled to source UV space.
   * The base source position lives in sourceTimeOffset/sourcePitchOffset params and is
   * added (with modulation) inside the shader, so this helper must not include it.
   */
  calculateSourceOffset(
    lockedOffset: { beats: number; pitch: number } | null | undefined,
    mode: string,
    mousePos: Vector2 | null,
    timeScale: number,
    bandScale: number,
  ): Vector2 {
    if (!mousePos) {
      return new Vector2(0, 0);
    }

    const scaledMouse = new Vector2(mousePos.x * timeScale, mousePos.y * bandScale);

    if (mode === "follow") {
      return new Vector2(0, 0);
    } else if (mode === "fixed") {
      return scaledMouse.clone().negate();
    } else if (mode === "anchored") {
      if (lockedOffset) {
        return new Vector2(lockedOffset.beats, lockedOffset.pitch);
      } else {
        return scaledMouse.clone().negate();
      }
    }

    return new Vector2(0, 0);
  }

  /**
   * Build common uniforms for a specific step.
   */
  buildStepUniforms(
    stepState: State,
    ctx: ModContext,
    brushSizeUv: Vector2,
    sourceOffsetUv: Vector2,
    destTexture: WebGLRenderTarget | { texture: DataTexture | Texture },
    cursorPos: Vector2,
    sourceFile: SourceFileInfo,
    bpm: number,
    totalDuration: number,
    sourceBpm: number,
    viewZoomPower: number,
    viewOffset: number,
    viewZoomPowerY: number,
    viewOffsetY: number,
    magnitudeLimit: number,
    selectionClip: SelectionClip,
  ): CommonUniforms {
    const { placeholderTexture, modulatorScaleLut, modulator1Texture, modulator2Texture, modulator3Texture } =
      this.textures;

    const modulatorUniforms = buildModulatorUniforms(
      bpm,
      totalDuration,
      this.spectrogramData.bandsPerOctave,
      this.spectrogramData.numBands,
      stepState,
      ctx,
    );

    return {
      // Filled in per step after the modulator precompute pass.
      modulatorTex0: { value: null },
      modulatorTex1: { value: null },
      sourceSpectrogramTex: { value: sourceFile.textures.packed.texture || placeholderTexture },
      sourceSpectrogramTextureSize: { value: sourceFile.spectrogramData.packedTextureSize },
      sourceInverseMapTex: { value: sourceFile.textures.inverse || placeholderTexture },
      sourceMetadataTex: { value: sourceFile.textures.metadata || placeholderTexture },
      sourceMinFreq: { value: sourceFile.spectrogramData.minFreq },
      sourceBandsPerOctave: { value: sourceFile.spectrogramData.bandsPerOctave },
      sourceFrameCount: { value: sourceFile.spectrogramData.numFrames },
      sourceBandCount: { value: sourceFile.spectrogramData.numBands },
      sourceChannelCount: { value: sourceFile.spectrogramData.numChannels },
      sourceSampleRate: { value: sourceFile.spectrogramData.sampleRate },
      sourceOnsetTex: { value: sourceFile.onsetTexture ?? placeholderTexture },
      destSpectrogramTex: { value: destTexture.texture || placeholderTexture },
      destSpectrogramTextureSize: { value: this.spectrogramData.packedTextureSize },
      destInverseMapTex: { value: this.textures.inverseMapTex || placeholderTexture },
      destMetadataTex: { value: this.textures.metadataTex || placeholderTexture },
      destMinFreq: { value: this.spectrogramData.minFreq },
      destBandsPerOctave: { value: this.spectrogramData.bandsPerOctave },
      destFrameCount: { value: this.spectrogramData.numFrames },
      destBandCount: { value: this.spectrogramData.numBands },
      destChannelCount: { value: this.spectrogramData.numChannels },
      destSampleRate: { value: this.spectrogramData.sampleRate },
      originalSpectrogramTex: { value: this.textures.originalPackedDataTex || placeholderTexture },
      viewZoomPower: { value: viewZoomPower },
      viewOffset: { value: viewOffset },
      viewZoomPowerY: { value: viewZoomPowerY },
      viewOffsetY: { value: viewOffsetY },
      brushBottomLeftUv: { value: cursorPos },
      selectionActive: { value: selectionClip.active },
      selectionFrames: { value: selectionClip.frames },
      selectionBands: { value: selectionClip.bands },
      selectionMaskActive: { value: selectionClip.maskActive },
      selectionMaskTex: { value: selectionClip.maskTexture || placeholderTexture },
      brushCurveTime: { value: brushParamUniform(stepState, "brushCurveTime", ctx) },
      brushSkewTime: { value: brushParamUniform(stepState, "brushSkewTime", ctx) },
      brushCurvePitch: { value: brushParamUniform(stepState, "brushCurvePitch", ctx) },
      brushSkewPitch: { value: brushParamUniform(stepState, "brushSkewPitch", ctx) },
      brushSizeUv: { value: brushSizeUv },
      brushIntensity: { value: brushParamUniform(stepState, "brushIntensity", ctx) },
      brushPan: { value: brushParamUniform(stepState, "brushPan", ctx) },
      bpm: { value: bpm },
      sourceOffsetX: { value: sourceOffsetUv.x },
      sourceOffsetY: { value: sourceOffsetUv.y },
      // Beat-based scale: 1 beat in dest UV = 1 beat in source UV
      sourceTimeScale: {
        value: (() => {
          const sourceDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;
          const divisor = sourceBpm * sourceDuration;
          return divisor > 0 ? (bpm * totalDuration) / divisor : 1;
        })(),
      },
      sourceBandScale: {
        value:
          sourceFile.spectrogramData.numBands > 0
            ? this.spectrogramData.numBands / sourceFile.spectrogramData.numBands
            : 1,
      },
      sourceTimeOffset: { value: sourceOffsetUniform(stepState, "sourceTimeOffset", ctx) },
      sourcePitchOffset: { value: sourceOffsetUniform(stepState, "sourcePitchOffset", ctx) },
      blendMode: { value: stepState.blendMode },
      algorithm: { value: stepState.algorithm },
      magnitudeLimit: { value: magnitudeLimit },
      wrapMode: { value: stepState.brushWrapMode },
      modulators: { value: modulatorUniforms },
      gainLut: { value: modulatorScaleLut || placeholderTexture },
      quantizeLutTex: { value: getQuantizeLutTexture() },
      modulator1ImageTex: { value: modulator1Texture || placeholderTexture },
      modulator2ImageTex: { value: modulator2Texture || placeholderTexture },
      modulator3ImageTex: { value: modulator3Texture || placeholderTexture },
      modulator1SeqDataTex: { value: modulatorUniforms[0]?.seqDataTex || placeholderTexture },
      modulator2SeqDataTex: { value: modulatorUniforms[1]?.seqDataTex || placeholderTexture },
      modulator3SeqDataTex: { value: modulatorUniforms[2]?.seqDataTex || placeholderTexture },
    };
  }

  /**
   * The packed band indices [lowBand, highBand] a brush of the given UV extent
   * can paint, widened by the neighbouring bands effects sample.
   */
  brushBandRange(brushBottomLeftUv: Vector2, brushSizeUv: Vector2): { lowBand: number; highBand: number } {
    const { numBands } = this.spectrogramData;

    // Band indices count down in frequency, so the brush's low pitch edge is
    // the highest index.
    const brushLowPitchY = brushBottomLeftUv.y;
    const brushHighPitchY = brushBottomLeftUv.y + brushSizeUv.y;

    const margin = 4;
    const highBand = Math.min(numBands - 1, Math.floor(pitchUvToBandIndex(brushLowPitchY, numBands)) + margin);
    const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(brushHighPitchY, numBands)) - margin);
    return { lowBand, highBand };
  }

  /**
   * Calculate the scissor row range in the packed texture for a given brush UV extent.
   * Returns null if scissoring wouldn't help (brush covers most of the texture).
   */
  calculateScissorRows(
    brushBottomLeftUv: Vector2,
    brushSizeUv: Vector2,
  ): { rowStart: number; rowCount: number } | null {
    const { numBands, textureWidth, textureHeight, metadata } = this.spectrogramData;
    const { lowBand, highBand } = this.brushBandRange(brushBottomLeftUv, brushSizeUv);

    // If brush covers most of the bands, don't bother with scissor
    const bandSpan = highBand - lowBand + 1;
    if (bandSpan >= numBands * 0.8) {
      return null;
    }

    // Get pixel range from metadata (bandStartOffset is at metadata[band * 4])
    const firstPixel = metadata[lowBand * 4];
    const lastBandOffset = metadata[highBand * 4];
    const lastBandLength = metadata[highBand * 4 + 1];
    const lastPixel = lastBandOffset + lastBandLength;

    const rowStart = Math.max(0, Math.floor(firstPixel / textureWidth));
    const rowEnd = Math.min(textureHeight, Math.ceil(lastPixel / textureWidth));

    return { rowStart, rowCount: rowEnd - rowStart };
  }

  /**
   * The packed pixels a stroke's final pass writes: the bins of every band in
   * the brush's pitch extent that fall in its time window, with margins.
   * `wholeBands` spreads it over every band and a null `window` over every
   * bin. Returns null when the whole texture is to be drawn instead.
   */
  calculateFootprint(
    brushBottomLeftUv: Vector2,
    brushSizeUv: Vector2,
    window: FrameWindow,
    wholeBands: boolean,
    rows: { rowStart: number; rowCount: number } | null,
  ): StrokeFootprint | null {
    const { numBands, textureWidth } = this.spectrogramData;
    const bands = wholeBands
      ? { lowBand: 0, highBand: numBands - 1 }
      : this.brushBandRange(brushBottomLeftUv, brushSizeUv);
    const footprint = this.footprint;
    footprint.count = brushFootprintRanges(
      this.spectrogramData,
      bands.lowBand,
      bands.highBand,
      window,
      FOOTPRINT_MARGIN_BINS,
      footprint.ranges,
      footprint.binRanges,
      rows ? { start: rows.rowStart * textureWidth, end: (rows.rowStart + rows.rowCount) * textureWidth } : undefined,
    );
    footprint.pixels = 0;
    for (let i = 0; i < footprint.count; i++) footprint.pixels += footprint.ranges[i * 2 + 1];
    return footprint;
  }

  /**
   * Render a brush stroke.
   */
  renderStroke(params: StrokeParams, state: State, sourceFile: SourceFileInfo): void {
    if (!this.isInitialized) {
      this.initialize();
    }
    const scratch = this.acquireScratch();

    const {
      cursorPos,
      preview,
      bpm,
      totalDuration,
      viewZoomPower,
      viewOffset,
      viewZoomPowerY,
      viewOffsetY,
      pressure,
      tiltX,
      tiltY,
    } = params;

    if (cursorPos.x < 0) return;

    // Every source-space conversion below divides by the source's duration and
    // band count, so an empty source would put NaN coordinates into the shaders
    // and write corrupted coefficients over the destination.
    const sourceSpec = sourceFile.spectrogramData;
    if (!(sourceSpec.numFrames > 0) || !(sourceSpec.numBands > 0) || !(sourceSpec.sampleRate > 0)) return;

    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    const stepGeometries = this.resolveStepGeometries(state, cursorPos, bpm, totalDuration);
    const numSteps = stepGeometries.length;
    if (numSteps === 0) return;

    const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const destinationFbo = this.pingPong === 0 ? this.fbo2 : this.fbo1;

    // What the first step reads when it names no source file of its own. A
    // non-cumulative stroke reads the stroke-start snapshot so its dabs cannot
    // feed back into themselves.
    const isSameFile = sourceFile.id === this.fileId;
    const firstStepState = stepGeometries[0].state;
    let selfInputFbo: WebGLRenderTarget | { texture: DataTexture } = isSameFile
      ? currentReadFBO
      : sourceFile.textures.packed;
    if (!firstStepState.accumulate && isSameFile && firstStepState.sourceDataMode !== "original") {
      selfInputFbo = scratch.strokeStartFbo;
    }

    // The previous step's output: what the next step blends over, and what it
    // reads when it names no source file of its own.
    let chainFbo: WebGLRenderTarget | { texture: DataTexture } = selfInputFbo;

    // The brush extent across all steps, in pitch and in time. Each step brings
    // its own origin, so the extent is the union of the steps' rectangles. A
    // step that wraps an axis with its brush crossing the [0,1] boundary paints
    // at both ends of that axis, so the extent becomes the whole axis.
    const unionMin = new Vector2(Infinity, Infinity);
    const unionMax = new Vector2(-Infinity, -Infinity);
    let yWrapsOutOfBounds = false;
    let wholeTime = false;
    for (const geometry of stepGeometries) {
      const { anchor, sizeUv } = geometry;
      unionMin.x = Math.min(unionMin.x, anchor.x);
      unionMin.y = Math.min(unionMin.y, anchor.y);
      unionMax.x = Math.max(unionMax.x, anchor.x + sizeUv.x);
      unionMax.y = Math.max(unionMax.y, anchor.y + sizeUv.y);
      if (geometry.fullTime) wholeTime = true;
      const wrapMode = geometry.state.brushWrapMode as number;
      const wrapsY = wrapMode === 2 || wrapMode === 3;
      const wrapsX = wrapMode === 1 || wrapMode === 3;
      if (wrapsY && (anchor.y < 0 || anchor.y + sizeUv.y > 1)) {
        yWrapsOutOfBounds = true;
      }
      if (wrapsX && (anchor.x < 0 || anchor.x + sizeUv.x > 1)) {
        wholeTime = true;
      }
    }
    // The shader rejects everything outside the selection, so the rows and bins
    // a dab has to touch are the brush's extent clipped to it. A wrapping or
    // Full-axis step reaches the whole axis, and the selection bounds it there
    // too. With no overlap the extent collapses, which leaves an empty
    // footprint: the passes draw nothing and no preview is composited.
    const selection = params.selection ?? null;
    const selectionClip = selectionClipFor(selection, this.spectrogramData, this.selectionMaskTexture(selection));
    if (selection) {
      const rect = selectionUvRect(selection, totalDuration);
      const selMaxX = rect.anchor.x + rect.size.x;
      const selMaxY = rect.anchor.y + rect.size.y;
      const clipMinX = wholeTime ? rect.anchor.x : Math.max(unionMin.x, rect.anchor.x);
      const clipMaxX = wholeTime ? selMaxX : Math.min(unionMax.x, selMaxX);
      const clipMinY = yWrapsOutOfBounds ? rect.anchor.y : Math.max(unionMin.y, rect.anchor.y);
      const clipMaxY = yWrapsOutOfBounds ? selMaxY : Math.min(unionMax.y, selMaxY);
      const empty = clipMaxX <= clipMinX || clipMaxY <= clipMinY;
      unionMin.set(clipMinX, clipMinY);
      unionMax.set(empty ? clipMinX : clipMaxX, empty ? clipMinY : clipMaxY);
      wholeTime = false;
      yWrapsOutOfBounds = false;
    }

    const unionAnchor = unionMin;
    const maxBrushSizeUv = new Vector2(unionMax.x - unionMin.x, unionMax.y - unionMin.y);

    // Every pass but the last is read by the passes after it, with whatever
    // reach in time their effect has, so those passes write the brush's full
    // packed rows. The last pass is only ever read at the pixels it paints, so
    // it writes the brush footprint alone. The brush's time window is rounded
    // to frames the way the brush shader rounds it.
    const scissorRows = yWrapsOutOfBounds ? null : this.calculateScissorRows(unionAnchor, maxBrushSizeUv);
    const { textureWidth, numFrames } = this.spectrogramData;
    const window: FrameWindow = wholeTime
      ? null
      : {
          frameStart: Math.floor(unionAnchor.x * numFrames + 0.5),
          frameEnd: Math.floor((unionAnchor.x + maxBrushSizeUv.x) * numFrames + 0.5),
        };
    const footprint = this.disableScissorCopyBack
      ? null
      : this.calculateFootprint(unionAnchor, maxBrushSizeUv, window, yWrapsOutOfBounds, scissorRows);
    const passRanges = scissorRows
      ? rowRange(textureWidth, scissorRows.rowStart, scissorRows.rowCount)
      : this.fullRange();
    // A footprint that covers most of the texture is cheaper to write with a
    // whole-texture draw and a buffer swap than to copy back, and with no
    // rows every pass has written the whole texture, so the swap is sound.
    const { textureHeight } = this.spectrogramData;
    const swapWhole =
      footprint !== null &&
      scissorRows === null &&
      footprint.pixels >= SWAP_FOOTPRINT_FRACTION * textureWidth * textureHeight;
    const copyBack = footprint !== null && !swapWhole;
    // On the legacy path the partner buffer is swapped (or shown) in whole, so
    // the rows the passes leave alone are copied over first.
    const finalRanges = copyBack ? footprint : passRanges;
    if (!footprint && scissorRows) {
      this.blitFBO(currentReadFBO, destinationFbo);
    }

    // Generate random value seeded by position using Perlin noise
    const strokeRandom = (noise2D(cursorPos.x * 50, cursorPos.y * 50) + 1) / 2;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const geometry = stepGeometries[stepIndex];
      const stepState = geometry.state;
      const stepBrushSizeUv = geometry.sizeUv;
      const stepAnchor = geometry.anchor;

      // The step's own Source control names the file it samples. A step with no
      // source of its own reads what the steps before it produced, so its
      // effects work on the running result rather than on another file.
      const namedSource = params.stepSources?.[stepIndex];
      const namedSpec = namedSource?.spectrogramData;
      const hasOwnSource = Boolean(
        namedSource && namedSpec && namedSpec.numFrames > 0 && namedSpec.numBands > 0 && namedSpec.sampleRate > 0,
      );
      const stepSource = hasOwnSource && namedSource ? namedSource : sourceFile;
      const readsNamedFile = hasOwnSource ? stepSource.id !== this.fileId : stepIndex === 0 && !isSameFile;

      let stepInputFbo: WebGLRenderTarget | { texture: DataTexture };
      let readsSourceFile = true;
      if (stepState.sourceDataMode === "original") {
        stepInputFbo = { texture: stepSource.textures.original };
      } else if (readsNamedFile) {
        stepInputFbo = stepSource.textures.packed;
      } else {
        stepInputFbo = stepIndex === 0 ? selfInputFbo : chainFbo;
        readsSourceFile = false;
      }

      // Determine the blend destination for this step
      const blendDestFbo = stepIndex === 0 ? currentReadFBO : chainFbo;

      // The Time/Pitch sources track the painted aim. On a full-size axis the
      // footprint anchors to 0, so the aim is read straight from the cursor.
      const stepContext: StrokeContext = {
        iteration: 0,
        time: geometry.fullTime ? cursorPos.x : stepAnchor.x + stepBrushSizeUv.x / 2,
        pitch: geometry.fullPitch ? cursorPos.y : stepAnchor.y + stepBrushSizeUv.y / 2,
        random: strokeRandom,
        step: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
        pressure,
        tiltX: (tiltX + 90) / 180,
        tiltY: (tiltY + 90) / 180,
      };
      const stepModContext = createModContext(stepState, stepContext);

      // Tracking is per step too, so the clone offset is measured against this
      // step's own origin and its own source file's timeline. A step reading the
      // running result stays in this file's space, where both scales are 1.
      const sourceBpm = state.filepathsBpm?.[stepSource.filePath] || bpm;
      const stepSourceDuration = stepSource.spectrogramData.numFrames / stepSource.spectrogramData.sampleRate;
      const sourceOffsetUv = this.calculateSourceOffset(
        state.isStroking ? steps[stepIndex]?.lockedOffset : null,
        stepState.sourcePositionMode as string,
        stepAnchor,
        readsSourceFile ? (bpm * totalDuration) / (sourceBpm * stepSourceDuration) : 1,
        readsSourceFile ? sourceBandUvSlope(this.spectrogramData, stepSource.spectrogramData) : 1,
      );

      // Build common uniforms for this step
      const commonUniforms = this.buildStepUniforms(
        stepState,
        stepModContext,
        stepBrushSizeUv,
        sourceOffsetUv,
        blendDestFbo,
        stepAnchor,
        stepSource,
        bpm,
        totalDuration,
        sourceBpm,
        viewZoomPower,
        viewOffset,
        viewZoomPowerY,
        viewOffsetY,
        state.magnitudeLimit,
        selectionClip,
      );

      // The source half of the uniforms has to describe whatever texture the
      // step reads, or the shader samples this file's layout as another file's.
      if (!readsSourceFile) this.pointSourceAtDest(commonUniforms, params.destOnsetTexture);
      commonUniforms.sourceSpectrogramTex.value = stepInputFbo.texture;

      // Get enabled effects in order for this step
      const stepEffects = stepState.effects as {
        id: string;
        effect: EffectType;
        enabled: boolean;
        params: Record<string, unknown>;
      }[];
      const enabledEffectItems = stepEffects.filter(({ enabled }) => enabled);

      // Precompute this step's modulator outputs into modulatorFbo, then point
      // the effect uniforms at the resulting textures. Done once per step before
      // any effect pass, so the expensive modulator evaluation happens once. When
      // nothing routes to a modulator, every consumer multiplies its output by
      // zero, so skip the pass and bind the zero placeholder instead. Effect
      // parameter amounts live on the effect item, not on the step, and
      // Attract's modulator maps read the textures with no amounts routed.
      const attractReadsModulators = enabledEffectItems.some(
        (item) =>
          item.effect === "attract" &&
          createEffectStateView(state, stepIndex, item).attractMap >= ATTRACT_MODULATOR_MAP_START,
      );
      const effectItemsRouteModulators = enabledEffectItems.some((item) => paramsRouteModulators(item.params));
      if (hasActiveModulatorRouting(stepState) || effectItemsRouteModulators || attractReadsModulators) {
        // Nested-modulation routing lives on the step (modulator amounts are
        // per-step parameters), so resolve the gate from the step state, not the
        // global state, before rendering this step's modulators.
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        const modulatorFbo = this.renderModulatorTextures(commonUniforms, passRanges);
        commonUniforms.modulatorTex0 = { value: modulatorFbo.textures[0] };
        commonUniforms.modulatorTex1 = { value: modulatorFbo.textures[1] };
      } else {
        commonUniforms.modulatorTex0 = { value: this.textures.placeholderTexture };
        commonUniforms.modulatorTex1 = { value: this.textures.placeholderTexture };
      }

      // If no effects are enabled, add a passthrough effect
      if (enabledEffectItems.length === 0) {
        enabledEffectItems.push({ id: "passthrough", effect: "passthrough", enabled: true, params: {} });
      }

      // Create the iterative uniforms set for subsequent passes
      const iterativeUniforms = {
        ...commonUniforms,
        sourceInverseMapTex: commonUniforms.destInverseMapTex,
        sourceMetadataTex: commonUniforms.destMetadataTex,
        sourceMinFreq: commonUniforms.destMinFreq,
        sourceBandsPerOctave: commonUniforms.destBandsPerOctave,
        sourceFrameCount: commonUniforms.destFrameCount,
        sourceBandCount: commonUniforms.destBandCount,
        sourceChannelCount: commonUniforms.destChannelCount,
        sourceSampleRate: commonUniforms.destSampleRate,
        sourceSpectrogramTextureSize: commonUniforms.destSpectrogramTextureSize,
        sourceOnsetTex: { value: params.destOnsetTexture ?? this.textures.placeholderTexture },
        sourceOffsetX: { value: 0 },
        sourceOffsetY: { value: 0 },
        sourceTimeScale: { value: 1.0 },
        sourceBandScale: { value: 1.0 },
        sourceTimeOffset: { value: defaultParameterUniform(0, -1, 1) },
        sourcePitchOffset: { value: defaultParameterUniform(0, -1, 1) },
      };

      // Reset currentReadFbo to the step's input for effect processing
      let currentReadFbo: WebGLRenderTarget | { texture: DataTexture } = stepInputFbo;

      const isLastStep = stepIndex === numSteps - 1;

      const brushIterations = stepState.brushIterations as number;

      // Flatten every (effect, iteration, pass) the step will render. Effects
      // drop passes that would be a no-op at the current settings, so first/last
      // pass bookkeeping has to count what actually renders, not what exists.
      const plannedPasses: {
        effect: BaseEffect;
        effectState: State;
        passIndex: number;
        iteration: number;
        inSwappedDomain: boolean;
      }[] = [];
      // A pass that moves the pair out of magnitude and phase leaves every pass
      // after it reading that domain, until one moves it back.
      let swapped = false;
      for (const effectItem of enabledEffectItems) {
        const effect = this.effects[effectItem.effect];
        if (!effect) continue;
        const effectState = createEffectStateView(state, stepIndex, effectItem);
        const activePasses = effect.getActivePasses?.(effectState) ?? effect.materials.map((_, index) => index);
        if (activePasses.length === 0) continue;
        for (let i = 0; i < brushIterations; i++) {
          for (const passIndex of activePasses) {
            plannedPasses.push({ effect, effectState, passIndex, iteration: i, inSwappedDomain: swapped });
            swapped = effect.domainAfter?.(effectState, swapped) ?? swapped;
          }
        }
      }

      // Every pass dropped out. One passthrough still has to run: it carries the
      // source offset, the brush blend, and the write into destinationFbo.
      if (plannedPasses.length === 0) {
        const passthrough = this.effects.passthrough;
        if (passthrough) {
          plannedPasses.push({
            effect: passthrough,
            effectState: createStepStateView(state, stepIndex),
            passIndex: 0,
            iteration: 0,
            inSwappedDomain: false,
          });
        }
      }

      const iterationContexts = Array.from({ length: brushIterations }, (_, i) =>
        createModContext(stepState, { ...stepContext, iteration: brushIterations > 1 ? i / (brushIterations - 1) : 0 }),
      );
      let staticsIteration = -1;

      // Every pass of a step reads the step's input as its blend base, so no
      // pass may write into that buffer. The stroke's last pass writes the
      // partner; an earlier step ends in a pass buffer so the next step can
      // still reach the partner. Working back from that end, each pass writes
      // a buffer its successor does not, which is also the one it reads.
      const passBuffers = isLastStep && plannedPasses.length === 1 ? [] : this.pool.passFbos(2);
      const writable = [...passBuffers, destinationFbo].filter((t) => t !== stepInputFbo && t !== chainFbo);
      const endTarget = isLastStep ? destinationFbo : writable.find((t) => t !== destinationFbo);
      if (!endTarget) throw new Error("No pass buffer is free for the step's output.");
      const passTargets: WebGLRenderTarget[] = new Array(plannedPasses.length);
      passTargets[plannedPasses.length - 1] = endTarget;
      for (let k = plannedPasses.length - 2; k >= 0; k--) {
        const next = passTargets[k + 1];
        const target = writable.find((t) => t !== next);
        if (!target) throw new Error("No pass buffer is free for an intermediate pass.");
        passTargets[k] = target;
      }

      // Apply each planned pass in order
      for (let passOrdinal = 0; passOrdinal < plannedPasses.length; passOrdinal++) {
        const { effect, effectState, passIndex: p, iteration: i, inSwappedDomain } = plannedPasses[passOrdinal];
        const isFirstOfStep = passOrdinal === 0;
        const uniformsForThisIteration = isFirstOfStep ? { ...commonUniforms } : { ...iterativeUniforms };

        uniformsForThisIteration.inSwappedDomain = { value: inSwappedDomain };

        // The Iteration source moves between passes, so the static terms that
        // depend on it are refreshed when it changes. The brush-level uniforms
        // are shared across the pass copies, so writing them in place reaches
        // every pass.
        const iterationContext = iterationContexts[i];
        if (i !== staticsIteration) {
          writeBrushParamStatics(commonUniforms, stepState, iterationContext);
          staticsIteration = i;
        }

        const material = effect.materials[p];

        const isFinalPassOfStep = passOrdinal === plannedPasses.length - 1;
        const isFinalPass = isFinalPassOfStep && isLastStep;
        const currentWriteFbo = passTargets[passOrdinal];

        const inputTexture = currentReadFbo.texture;

        // The "source" on the first pass of the step is already set correctly in commonUniforms
        if (!isFirstOfStep) {
          uniformsForThisIteration.sourceSpectrogramTex = { value: inputTexture };
        }

        // The "destination" (for blending) is the original target only on the very first pass
        uniformsForThisIteration.destSpectrogramTex = {
          value: isFirstOfStep ? commonUniforms.destSpectrogramTex.value : inputTexture,
        };

        // Pass the mask if enabled (non-cumulative mode). The step reads its own
        // mask, so a step with a different envelope cannot raise its weight. No
        // pair exists until this step first commits, and the zero placeholder is
        // what a cleared mask holds.
        if (!stepState.accumulate) {
          const maskPair = scratch.strokeMaskFbos[stepIndex];
          (uniformsForThisIteration as any).useStrokeMask = { value: true };
          (uniformsForThisIteration as any).strokeMaskTex = {
            value: maskPair ? maskPair[this.maskPingPong].texture : this.textures.placeholderTexture,
          };
        } else {
          (uniformsForThisIteration as any).useStrokeMask = { value: false };
          (uniformsForThisIteration as any).strokeMaskTex = { value: this.textures.placeholderTexture };
        }
        // The blend path reads this only for non-cumulative strokes, but an
        // effect undoing a domain swap needs the same snapshot either way.
        (uniformsForThisIteration as any).blendOriginalTex = { value: scratch.strokeStartFbo.texture };
        // An accumulating step blends out of the live canvas whatever its
        // position, so its dabs pile up; it still processes its own input, which
        // for a later step is the previous step's output. A non-cumulative step 0
        // blends out of the stroke-start snapshot, so dabs over the same area
        // cannot pile up, and a later one blends out of its own input —
        // blending those out of the snapshot instead would discard everything
        // the earlier steps wrote.
        uniformsForThisIteration.blendBaseTex = {
          value: stepState.accumulate
            ? currentReadFBO.texture
            : stepIndex === 0
              ? scratch.strokeStartFbo.texture
              : chainFbo.texture,
        };

        effect.updateEffectUniforms({
          commonUniforms: uniformsForThisIteration,
          passIndex: p,
          file: stepSource,
          state: effectState,
          modContext: iterationContext,
        });

        this.drawRanges(material, currentWriteFbo, isFinalPass ? finalRanges : passRanges);

        currentReadFbo = currentWriteFbo;
      }

      // The output of this step becomes the input for the next step
      chainFbo = currentReadFbo;
    }

    // A committed stroke folds its footprint back into the canonical buffer,
    // which keeps currentReadFBO canonical; a preview leaves it in the partner
    // for the display to composite. On the legacy full-texture path the
    // partner holds the whole result, so the buffers swap instead.
    if (!preview && copyBack) {
      rangeCopyMaterial.uniforms.inputTex.value = destinationFbo.texture;
      this.drawRanges(rangeCopyMaterial, currentReadFBO, footprint);
      rangeCopyMaterial.uniforms.inputTex.value = null;
    }
    this.gl.setRenderTarget(null);

    this.previewActive = preview;
    if (preview) {
      if (!footprint) this.markWholeTexturePreview();
      this.previewRangeTex.needsUpdate = true;
    }

    // If the stroke is not a preview, commit the changes
    if (!preview) {
      if (!copyBack) {
        this.pingPong = 1 - this.pingPong;
      }

      // Update stroke mask for non-cumulative mode. Any step being non-accumulate
      // means the per-step gate in the render loop will sample the mask for that
      // step, so we need a fresh composite covering every non-accumulate step.
      // updateStrokeMask is a no-op when every step is accumulate.
      let anyNonAccumulate = false;
      for (const geometry of stepGeometries) {
        if (!geometry.state.accumulate) {
          anyNonAccumulate = true;
          break;
        }
      }
      if (anyNonAccumulate) {
        const dabRowStart = scissorRows ? scissorRows.rowStart : 0;
        const dabRowEnd = scissorRows
          ? scissorRows.rowStart + scissorRows.rowCount
          : this.spectrogramData.textureHeight;
        this.maskRows = this.maskRows
          ? {
              rowStart: Math.min(this.maskRows.rowStart, dabRowStart),
              rowEnd: Math.max(this.maskRows.rowEnd, dabRowEnd),
            }
          : { rowStart: dabRowStart, rowEnd: dabRowEnd };
        this.updateStrokeMask(
          stepGeometries,
          cursorPos,
          bpm,
          totalDuration,
          strokeRandom,
          pressure,
          tiltX,
          tiltY,
          selectionClip,
        );
      }

      // Update dirty region to include this stroke's bounds. Every step of
      // the brush painted, so the bounds are the union of the steps' extents,
      // not the active step's alone.
      const strokeStartX = unionAnchor.x;
      const strokeEndX = unionAnchor.x + maxBrushSizeUv.x;
      const strokeStartY = unionAnchor.y;
      const strokeEndY = unionAnchor.y + maxBrushSizeUv.y;

      if (this.dirtyRegion) {
        this.dirtyRegion.startX = Math.min(this.dirtyRegion.startX, strokeStartX);
        this.dirtyRegion.endX = Math.max(this.dirtyRegion.endX, strokeEndX);
        this.dirtyRegion.startY = Math.min(this.dirtyRegion.startY, strokeStartY);
        this.dirtyRegion.endY = Math.max(this.dirtyRegion.endY, strokeEndY);
      } else {
        this.dirtyRegion = {
          startX: strokeStartX,
          endX: strokeEndX,
          startY: strokeStartY,
          endY: strokeEndY,
        };
      }

      // A dab changes pixels only within its brush footprint, so accumulate the
      // footprint for the history delta regardless of whether the GPU scissored
      // the render (a full-band dab still has a bounded time window).
      this.committedTimeMin = Math.min(this.committedTimeMin, strokeStartX);
      this.committedTimeMax = Math.max(this.committedTimeMax, strokeEndX);
      this.committedPitchMin = Math.min(this.committedPitchMin, strokeStartY);
      this.committedPitchMax = Math.max(this.committedPitchMax, strokeEndY);

      this.invalidateFboData();
    }

    this.verifyScratchAllocation();
  }

  /**
   * Update the stroke masks for non-cumulative mode.
   * Iterates every non-accumulate step so each step's envelope/intensity
   * contribution is composited into that step's own mask (via max in the
   * shader). A pure no-op when every step is set to accumulate.
   */
  private updateStrokeMask(
    stepGeometries: StepGeometry[],
    cursorPos: Vector2,
    bpm: number,
    totalDuration: number,
    strokeRandom: number,
    pressure: number,
    tiltX: number,
    tiltY: number,
    selectionClip: SelectionClip,
  ): void {
    const numSteps = stepGeometries.length;
    if (numSteps === 0) return;

    const { placeholderTexture, modulator1Texture, modulator2Texture, modulator3Texture, modulatorScaleLut } =
      this.textures;

    const uniforms = this.maskMaterial.uniforms;

    // Bind invariants (same for every step) once.
    uniforms.destMetadataTex.value = this.textures.metadataTex;
    uniforms.destInverseMapTex.value = this.textures.inverseMapTex;
    uniforms.destSpectrogramTextureSize.value = this.spectrogramData.packedTextureSize;
    uniforms.destFrameCount.value = this.spectrogramData.numFrames;
    uniforms.destBandCount.value = this.spectrogramData.numBands;
    uniforms.selectionActive.value = selectionClip.active;
    uniforms.selectionFrames.value = selectionClip.frames;
    uniforms.selectionBands.value = selectionClip.bands;
    uniforms.selectionMaskActive.value = selectionClip.maskActive;
    uniforms.selectionMaskTex.value = selectionClip.maskTexture || placeholderTexture;
    uniforms.gainLut.value = modulatorScaleLut || placeholderTexture;
    uniforms.quantizeLutTex.value = getQuantizeLutTexture();
    uniforms.modulator1ImageTex.value = modulator1Texture || placeholderTexture;
    uniforms.modulator2ImageTex.value = modulator2Texture || placeholderTexture;
    uniforms.modulator3ImageTex.value = modulator3Texture || placeholderTexture;

    const rows = this.maskRows;
    const maskRanges =
      rows !== null && !this.disableScissorCopyBack && rows.rowEnd - rows.rowStart < this.spectrogramData.textureHeight
        ? rowRange(this.spectrogramData.textureWidth, rows.rowStart, rows.rowEnd - rows.rowStart)
        : this.fullRange();

    let renderedAny = false;

    for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
      const geometry = stepGeometries[stepIndex];
      const stepState = geometry.state;
      if (stepState.accumulate) continue;

      const brushSizeUv = geometry.sizeUv;
      const brushAnchor = geometry.anchor;

      // The mask is the envelope of the whole stroke, so it reads the last iteration.
      const maskContext = createModContext(stepState, {
        iteration: 1,
        time: geometry.fullTime ? cursorPos.x : brushAnchor.x + brushSizeUv.x / 2,
        pitch: geometry.fullPitch ? cursorPos.y : brushAnchor.y + brushSizeUv.y / 2,
        random: strokeRandom,
        step: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
        pressure,
        tiltX: (tiltX + 90) / 180,
        tiltY: (tiltY + 90) / 180,
      });

      // Modulator params are per-step; rebuild for each step.
      const modulatorUniforms = buildModulatorUniforms(
        bpm,
        totalDuration,
        this.spectrogramData.bandsPerOctave,
        this.spectrogramData.numBands,
        stepState,
        maskContext,
      );
      uniforms.modulators.value = modulatorUniforms;
      uniforms.modulator1SeqDataTex.value = modulatorUniforms[0]?.seqDataTex || placeholderTexture;
      uniforms.modulator2SeqDataTex.value = modulatorUniforms[1]?.seqDataTex || placeholderTexture;
      uniforms.modulator3SeqDataTex.value = modulatorUniforms[2]?.seqDataTex || placeholderTexture;

      (uniforms.brushBottomLeftUv.value as Vector2).copy(brushAnchor);
      (uniforms.brushSizeUv.value as Vector2).copy(brushSizeUv);

      writeParameterUniform(
        uniforms.brushIntensity.value as ParameterUniform,
        stepState,
        "brushIntensity",
        maskContext,
        BRUSH_SHADER_RANGES.brushIntensity(stepState),
      );
      writeParameterUniform(
        uniforms.brushCurveTime.value as ParameterUniform,
        stepState,
        "brushCurveTime",
        maskContext,
        BRUSH_SHADER_RANGES.brushCurveTime(stepState),
      );
      writeParameterUniform(
        uniforms.brushSkewTime.value as ParameterUniform,
        stepState,
        "brushSkewTime",
        maskContext,
        BRUSH_SHADER_RANGES.brushSkewTime(stepState),
      );
      writeParameterUniform(
        uniforms.brushCurvePitch.value as ParameterUniform,
        stepState,
        "brushCurvePitch",
        maskContext,
        BRUSH_SHADER_RANGES.brushCurvePitch(stepState),
      );
      writeParameterUniform(
        uniforms.brushSkewPitch.value as ParameterUniform,
        stepState,
        "brushSkewPitch",
        maskContext,
        BRUSH_SHADER_RANGES.brushSkewPitch(stepState),
      );

      // The mask shader samples the precomputed modulator textures (via
      // getBrushWeight / applyModulation), so render them for this step first,
      // then restore the mask material as the active program. Skip the pass when
      // nothing routes to a modulator (zero placeholder yields the same result).
      if (hasActiveModulatorRouting(stepState)) {
        this.modulatorMaterial.uniforms.nestedModulationActive.value = hasNestedModulatorRouting(stepState);
        const modulatorFbo = this.renderModulatorTextures(uniforms as unknown as CommonUniforms, maskRanges);
        uniforms.modulatorTex0.value = modulatorFbo.textures[0];
        uniforms.modulatorTex1.value = modulatorFbo.textures[1];
      } else {
        uniforms.modulatorTex0.value = this.textures.placeholderTexture;
        uniforms.modulatorTex1.value = this.textures.placeholderTexture;
      }
      const { fbos, created } = this.pool.maskFbos(stepIndex);
      if (created) this.clearMaskTargets([fbos[0], fbos[1]]);
      uniforms.currentMaskTex.value = fbos[this.maskPingPong].texture;

      this.drawRanges(this.maskMaterial, fbos[1 - this.maskPingPong], maskRanges);

      renderedAny = true;
    }

    // Every step wrote the same side of its own pair, so one flip switches them
    // all over together.
    if (renderedAny) {
      this.maskPingPong = 1 - this.maskPingPong;
      this.gl.setRenderTarget(null);
    }
  }

  /** Marks the cached packed state stale, so the next read goes to the GPU. */
  private invalidateFboData(): void {
    this.fboDataDirty = true;
    this.fboDataEpoch++;
  }

  /**
   * Get the current FBO data asynchronously. The readback is issued against the
   * FBO as it stands at the call, so the resolved array is that caller's
   * snapshot even when later paint lands before it resolves.
   */
  async getFBOData(): Promise<Float32Array> {
    if (this.fboDataCache && !this.fboDataDirty) {
      return this.fboDataCache;
    }

    const { packedTextureSize } = this.spectrogramData;
    const fboToRead = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const epoch = this.fboDataEpoch;
    const data = await readRenderTargetPixelsAsync(this.gl, fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y);

    // Paint that landed while the read was in flight is absent from `data`, so
    // it stands in for nothing later: leave the cache stale for the next read.
    if (epoch === this.fboDataEpoch) {
      this.fboDataCache = data;
      this.fboDataDirty = false;
    }

    return data;
  }

  /**
   * Reads just the pixels of `pixelRanges` (a flat [pixelStart, pixelCount, ...]
   * list) from the committed FBO as it stands at the call, as one block in
   * range order. The ranges are gathered on the GPU into a compact target and
   * only that is read back, so the cost follows the footprint, not the file.
   */
  async readPixelRanges(pixelRanges: Uint32Array): Promise<Float32Array> {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;

    let patchPixels = 0;
    let numRanges = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      if (pixelRanges[i + 1] === 0) continue;
      patchPixels += pixelRanges[i + 1];
      numRanges++;
    }
    if (patchPixels === 0) return new Float32Array(0);

    const instances = new Uint32Array(numRanges * 3);
    let dstPixel = 0;
    let inst = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      const count = pixelRanges[i + 1];
      if (count === 0) continue;
      instances[inst * 3] = pixelRanges[i];
      instances[inst * 3 + 1] = count;
      instances[inst * 3 + 2] = dstPixel;
      dstPixel += count;
      inst++;
    }

    const blockWidth = Math.min(width, patchPixels);
    const blockHeight = Math.ceil(patchPixels / blockWidth);
    const block = new WebGLRenderTarget(blockWidth, blockHeight, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
    geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
    geometry.setAttribute("aRange", new InstancedBufferAttribute(instances, 3));
    geometry.instanceCount = numRanges;

    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    gatherMaterial.uniforms.sourceTex.value = committed.texture;
    gatherMaterial.uniforms.sourceWidth.value = width;
    gatherMaterial.uniforms.destWidth.value = blockWidth;
    gatherMaterial.uniforms.destHeight.value = blockHeight;

    const mesh = new Mesh(geometry, gatherMaterial);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);

    this.gl.setRenderTarget(block);
    this.gl.render(scene, this.camera);
    this.gl.setRenderTarget(null);
    gatherMaterial.uniforms.sourceTex.value = null;
    geometry.dispose();

    try {
      const padded = await readRenderTargetPixelsAsync(this.gl, block, 0, 0, blockWidth, blockHeight);
      return padded.length === patchPixels * 4 ? padded : padded.slice(0, patchPixels * 4);
    } finally {
      block.dispose();
    }
  }

  /**
   * Adds a phase offset per channel to the pixels of each range in the
   * committed FBO (and the stroke-start snapshot), as a projection's whole-turn
   * re-branch of a band's tail. `turns` is a flat list of
   * [pixelStart, pixelCount, offsetLeft, offsetRight, ...] with the offsets
   * already signed for the direction wanted. The turned pixels go through the
   * other ping-pong buffer and are copied back, so nothing is uploaded.
   */
  applyPhaseTurns(turns: ArrayLike<number>): void {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;
    const height = packedTextureSize.y;

    let numRanges = 0;
    for (let i = 0; i + 3 < turns.length; i += 4) if (turns[i + 1] > 0) numRanges++;
    if (numRanges === 0) return;

    const ranges = new Uint32Array(numRanges * 2);
    const offsets = new Float32Array(numRanges * 2);
    const zeros = new Float32Array(numRanges * 2);
    let inst = 0;
    for (let i = 0; i + 3 < turns.length; i += 4) {
      if (turns[i + 1] <= 0) continue;
      ranges[inst * 2] = turns[i];
      ranges[inst * 2 + 1] = turns[i + 1];
      offsets[inst * 2] = turns[i + 2];
      offsets[inst * 2 + 1] = turns[i + 3];
      inst++;
    }

    const draw = (source: WebGLRenderTarget, targets: WebGLRenderTarget[], offs: Float32Array): void => {
      const geometry = new InstancedBufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
      geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
      geometry.setAttribute("aRange", new InstancedBufferAttribute(ranges, 2));
      geometry.setAttribute("aOffset", new InstancedBufferAttribute(offs, 2));
      geometry.instanceCount = numRanges;
      phaseTurnMaterial.uniforms.sourceTex.value = source.texture;
      phaseTurnMaterial.uniforms.width.value = width;
      phaseTurnMaterial.uniforms.height.value = height;
      const mesh = new Mesh(geometry, phaseTurnMaterial);
      mesh.frustumCulled = false;
      const scene = new Scene();
      scene.add(mesh);
      for (const target of targets) {
        this.gl.setRenderTarget(target);
        this.gl.render(scene, this.camera);
      }
      this.gl.setRenderTarget(null);
      phaseTurnMaterial.uniforms.sourceTex.value = null;
      geometry.dispose();
    };

    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const other = this.pingPong === 0 ? this.fbo2 : this.fbo1;
    draw(committed, [other], offsets);
    const back = [committed];
    if (this.pool.ownedBy(this) && this.scratch) back.push(this.scratch.strokeStartFbo);
    draw(other, back, zeros);
    this.gl.autoClear = prevAutoClear;

    this.invalidateFboData();
  }

  /**
   * Set the FBO data from an external source (e.g., for undo/redo).
   */
  setFBOData(data: Float32Array): void {
    const { packedTextureSize } = this.spectrogramData;

    this.releaseRollback();
    this.pingPong = 0;

    const dataTex = new DataTexture(data, packedTextureSize.x, packedTextureSize.y, RGBAFormat, FloatType);
    dataTex.needsUpdate = true;

    this.gl.initTexture(dataTex);

    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);

    // The stroke-start snapshot only exists while this renderer holds the
    // scratch pool; when it does not, the next acquireScratch rebuilds it
    // from fbo1 anyway.
    if (this.pool.ownedBy(this) && this.scratch) {
      this.snapshotToStrokeStart(this.scratch, this.fbo1.texture);
    }

    dataTex.dispose();

    this.invalidateFboData();
  }

  /**
   * Update only the texture rows covered by `pixelRanges` (a flat
   * [pixelStart, pixelCount, ...] list in packed-pixel indices) from `data`,
   * which must hold the full packed state. Both the committed FBO and the
   * stroke-start snapshot receive the rows, so when every pixel outside the
   * ranges already matches the FBO this is equivalent to setFBOData at a
   * fraction of the upload cost. Falls back to setFBOData when the ranges
   * span most of the texture.
   */
  patchFBOData(data: Float32Array, pixelRanges: Uint32Array): void {
    const { packedTextureSize } = this.spectrogramData;
    const width = packedTextureSize.x;
    const height = packedTextureSize.y;

    let patchPixels = 0;
    let numRanges = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      if (pixelRanges[i + 1] === 0) continue;
      patchPixels += pixelRanges[i + 1];
      numRanges++;
    }
    if (patchPixels === 0) return;
    // Past roughly half the texture the gather plus scatter costs more than
    // just re-uploading everything.
    if (patchPixels >= width * height * 0.5) {
      this.setFBOData(data);
      return;
    }

    // Gather the ranges into one compact block, and record where each range
    // landed so the shader can scatter it back.
    const patch = new Float32Array(patchPixels * 4);
    const instances = new Uint32Array(numRanges * 3);
    let srcPixel = 0;
    let inst = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      const start = pixelRanges[i];
      const count = pixelRanges[i + 1];
      if (count === 0) continue;
      patch.set(data.subarray(start * 4, (start + count) * 4), srcPixel * 4);
      instances[inst * 3] = start;
      instances[inst * 3 + 1] = count;
      instances[inst * 3 + 2] = srcPixel;
      srcPixel += count;
      inst++;
    }

    const patchWidth = Math.min(width, patchPixels);
    const patchHeight = Math.ceil(patchPixels / patchWidth);
    const padded =
      patch.length === patchWidth * patchHeight * 4
        ? patch
        : (() => {
            const p = new Float32Array(patchWidth * patchHeight * 4);
            p.set(patch);
            return p;
          })();
    const patchTex = new DataTexture(padded, patchWidth, patchHeight, RGBAFormat, FloatType);
    patchTex.needsUpdate = true;
    this.gl.initTexture(patchTex);

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
    geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
    geometry.setAttribute("aRange", new InstancedBufferAttribute(instances, 3));
    geometry.instanceCount = numRanges;

    patchMaterial.uniforms.patchTex.value = patchTex;
    patchMaterial.uniforms.destWidth.value = width;
    patchMaterial.uniforms.destHeight.value = height;
    patchMaterial.uniforms.patchWidth.value = patchWidth;

    const mesh = new Mesh(geometry, patchMaterial);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);

    // Only the patched pixels are drawn, so the rest of the target must survive
    // the render — no clear.
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    const committed = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const targets = [committed];
    // The stroke-start snapshot must receive the same rows, but only while
    // this renderer holds it; otherwise the next acquireScratch rebuilds it
    // from the patched committed buffer.
    if (this.pool.ownedBy(this) && this.scratch) {
      targets.push(this.scratch.strokeStartFbo);
    }
    for (const target of targets) {
      this.gl.setRenderTarget(target);
      this.gl.render(scene, this.camera);
    }
    this.gl.setRenderTarget(null);
    this.gl.autoClear = prevAutoClear;

    geometry.dispose();
    patchTex.dispose();
    this.invalidateFboData();
  }

  /**
   * Get the current textures for reading.
   */
  /**
   * Textures for a spectrogram that is not an open file — a clipboard region,
   * say — so a stroke can sample it the way it samples another file. The caller
   * owns what comes back and disposes it.
   */
  createDetachedTextures(spec: SpectrogramData): {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  } {
    const { textureWidth, textureHeight } = spec;

    const packedTex = new DataTexture(spec.packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
    packedTex.internalFormat = "RGBA32F";
    packedTex.minFilter = NearestFilter;
    packedTex.magFilter = NearestFilter;
    packedTex.needsUpdate = true;

    const inverse = new DataTexture(spec.inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
    inverse.internalFormat = "RG32F";
    inverse.minFilter = NearestFilter;
    inverse.magFilter = NearestFilter;
    inverse.needsUpdate = true;

    const metadata = new DataTexture(spec.metadata, spec.numBands, 1, RGBAFormat, FloatType);
    metadata.internalFormat = "RGBA32F";
    metadata.minFilter = NearestFilter;
    metadata.magFilter = NearestFilter;
    metadata.needsUpdate = true;

    // The sampler wants a render target, so the data goes through one draw.
    const packed = this.createFBO(textureWidth, textureHeight, RGBAFormat);
    this.gl.initTexture(packedTex);
    this.fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = packedTex;
    this.gl.setRenderTarget(packed);
    this.gl.render(this.fboScene, this.camera);
    this.gl.setRenderTarget(null);
    copyMaterial.uniforms.inputTex.value = null;

    return { packed, inverse, metadata, original: packedTex };
  }

  getTextures(): {
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  } {
    return {
      packed: this.pingPong === 0 ? this.fbo1 : this.fbo2,
      inverse: this.textures.inverseMapTex,
      metadata: this.textures.metadataTex,
      original: this.textures.originalPackedDataTex,
    };
  }

  /** The committed spectrogram texture. */
  getDisplayTexture(): Texture {
    return (this.pingPong === 0 ? this.fbo1 : this.fbo2).texture;
  }

  /**
   * The textures the display composites when a preview is up: the committed
   * spectrogram, the preview, and the per-band bin ranges [start, end) the
   * preview is valid in, as a numBands×1 texture. `active` is false when there
   * is no preview to show.
   */
  getPreviewDisplay(): { committed: Texture; preview: Texture; binRanges: Texture; active: boolean } {
    const currentFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const nextFBO = this.pingPong === 0 ? this.fbo2 : this.fbo1;
    return {
      committed: currentFBO.texture,
      preview: nextFBO.texture,
      binRanges: this.previewRangeTex,
      active: this.previewActive,
    };
  }

  // Blocks until all GPU work submitted so far has finished. Lets opt-in paint
  // timing attribute true GPU cost to a stroke instead of just the JS dispatch.
  finishGpu(): void {
    this.gl.getContext().finish();
  }

  /**
   * Saves the current spectrogram so a run of committed strokes can be taken
   * back without touching history — what a grid fill paints onto.
   * Calling it again while a snapshot is held restores that snapshot instead of
   * replacing it, so repeated previews always start from the same pixels.
   */
  captureRollback(): void {
    if (this.rollbackFbo) {
      this.blitFBO(this.rollbackFbo, this.pingPong === 0 ? this.fbo1 : this.fbo2);
    } else {
      this.rollbackFbo = this.createFBO(
        this.spectrogramData.textureWidth,
        this.spectrogramData.textureHeight,
        RGBAFormat,
      );
      this.blitFBO(this.pingPong === 0 ? this.fbo1 : this.fbo2, this.rollbackFbo);
    }
    this.invalidateFboData();
  }

  /** Whether a rollback snapshot is currently held. */
  hasRollback(): boolean {
    return this.rollbackFbo !== null;
  }

  /**
   * Puts the saved spectrogram back and drops the snapshot. Returns false when
   * there was nothing to restore.
   */
  restoreRollback(): boolean {
    if (!this.rollbackFbo) return false;
    this.blitFBO(this.rollbackFbo, this.pingPong === 0 ? this.fbo1 : this.fbo2);
    this.releaseRollback();
    this.dirtyRegion = null;
    this.invalidateFboData();
    return true;
  }

  /** Drops the snapshot, keeping whatever is currently painted. */
  releaseRollback(): void {
    this.rollbackFbo?.dispose();
    this.rollbackFbo = null;
  }

  /**
   * Begin a new stroke (snapshot current state).
   */
  beginStroke(): void {
    // Reset the committed footprint for the new stroke. Tied to the stroke
    // boundary (not dirtyRegion's clear) so every dab of this stroke folds into
    // one footprint that history reads at commit.
    this.committedTimeMin = Infinity;
    this.committedTimeMax = -Infinity;
    this.committedPitchMin = Infinity;
    this.committedPitchMax = -Infinity;
    this.strokeGeneration++;
  }

  getStrokeGeneration(): number {
    return this.strokeGeneration;
  }

  /**
   * The stroke's committed footprint in unpacked UV, or null when nothing was
   * committed. Time is [timeMin, timeMax]; pitch follows the same UV axis the
   * dirty region uses (0 = top of the texture).
   */
  getCommittedFootprintUv(): { timeMin: number; timeMax: number; pitchMin: number; pitchMax: number } | null {
    if (this.committedTimeMax <= this.committedTimeMin) return null;
    return {
      timeMin: Math.max(0, this.committedTimeMin),
      timeMax: Math.min(1, this.committedTimeMax),
      pitchMin: Math.max(0, this.committedPitchMin),
      pitchMax: Math.min(1, this.committedPitchMax),
    };
  }

  /**
   * Widens the dirty region so the next synthesis covers pixels changed
   * outside the painted rect — boundary conditioning writes into a margin
   * around the stroke's time edges.
   */
  expandDirtyRegion(startX: number, endX: number, startY: number, endY: number): void {
    if (this.dirtyRegion) {
      this.dirtyRegion.startX = Math.min(this.dirtyRegion.startX, startX);
      this.dirtyRegion.endX = Math.max(this.dirtyRegion.endX, endX);
      this.dirtyRegion.startY = Math.min(this.dirtyRegion.startY, startY);
      this.dirtyRegion.endY = Math.max(this.dirtyRegion.endY, endY);
    } else {
      this.dirtyRegion = { startX, endX, startY, endY };
    }
  }

  /**
   * Packed-pixel ranges the current stroke's committed footprint covers, as a
   * flat [pixelStart, pixelCount, ...] list — one range per band, mapping the
   * footprint's time window into each band's packed segment. Returns null when
   * nothing was committed, so history stores a full snapshot.
   */
  getDirtyPixelRanges(): Uint32Array | null {
    if (this.committedTimeMax <= this.committedTimeMin) return null;

    const { numBands, metadata } = this.spectrogramData;
    const pitchMargin = 4;
    const highBand = Math.min(
      numBands - 1,
      Math.floor(pitchUvToBandIndex(this.committedPitchMin, numBands)) + pitchMargin,
    );
    const lowBand = Math.max(0, Math.floor(pitchUvToBandIndex(this.committedPitchMax, numBands)) - pitchMargin);
    const t0 = Math.max(0, this.committedTimeMin);
    const t1 = Math.min(1, this.committedTimeMax);
    const timeMargin = 4;

    const ranges: number[] = [];
    for (let b = lowBand; b <= highBand; b++) {
      const offset = Math.round(metadata[b * 4]);
      const length = Math.round(metadata[b * 4 + 1]);
      const start = Math.max(offset, offset + Math.floor(t0 * length) - timeMargin);
      const end = Math.min(offset + length, offset + Math.ceil(t1 * length) + timeMargin);
      if (end > start) ranges.push(start, end - start);
    }
    return ranges.length ? new Uint32Array(ranges) : null;
  }

  /**
   * End the current stroke (prepare for next stroke).
   */
  endStroke(): void {
    // Without the scratch pool there is nothing to reset; the next
    // acquireScratch establishes the same state.
    if (!this.pool.ownedBy(this) || !this.scratch) return;

    // Snapshot the result of the stroke to strokeStartFbo
    const currentReadFBO = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    this.snapshotToStrokeStart(this.scratch, currentReadFBO.texture);

    // Clear both Mask FBOs and reset ping-pong
    this.clearMasks(this.scratch);
    this.maskPingPong = 0;
  }

  /**
   * Restore to original state.
   */
  restoreOriginal(): void {
    this.isInitialized = false;
    this.invalidateFboData();
    this.dirtyRegion = null;
  }

  /**
   * Check if the renderer is initialized.
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the dirty region (bounding box of all strokes since last clear).
   * Returns UV coordinates (0-1 range).
   */
  getDirtyRegion(): { startX: number; endX: number; startY: number; endY: number } | null {
    return this.dirtyRegion;
  }

  /**
   * Clear the dirty region tracking.
   */
  clearDirtyRegion(): void {
    this.dirtyRegion = null;
  }

  /**
   * Take the dirty region and clear it in one step. The commit that owns the
   * returned region is the only one that synthesizes it; dabs painted after
   * this call accumulate into a fresh region for the next commit.
   */
  consumeDirtyRegion(): { startX: number; endX: number; startY: number; endY: number } | null {
    const region = this.dirtyRegion;
    this.dirtyRegion = null;
    return region;
  }

  /**
   * Dispose of all WebGL resources.
   */
  private selectionMaskTexture(selection: Selection | null): Texture | null {
    const mask = selection?.mask;
    if (!mask) return null;
    if (this.selectionMaskCache?.cells === mask.cells) return this.selectionMaskCache.texture;
    this.selectionMaskCache?.texture.dispose();
    const texture = new DataTexture(mask.cells, mask.cols, mask.rows, RedFormat, UnsignedByteType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    this.selectionMaskCache = { cells: mask.cells, texture };
    return texture;
  }

  dispose(): void {
    this.releaseRollback();
    this.selectionMaskCache?.texture.dispose();
    this.selectionMaskCache = null;
    this.pool.release(this);
    this.scratch = null;
    this.fbo1.dispose();
    this.fbo2.dispose();
    this.maskMaterial.dispose();
    this.modulatorMaterial.dispose();
    this.fboMesh.geometry.dispose();
    this.fboScene.remove(this.fboMesh);
    this.rangeGeometry.dispose();
    this.rangeScene.remove(this.rangeMesh);
    this.previewRangeTex.dispose();
  }
}
