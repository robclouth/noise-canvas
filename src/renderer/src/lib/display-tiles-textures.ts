import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  HalfFloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";
import type { CanvasView } from "./canvas-view";
import { clampToSourceBins, DecimateDraw, type CommittedSource, type DecimateInstance } from "./display-decimate";
import type { BandLayout } from "./band-layout";
import { sourceBinRanges } from "./display-pyramid";
import {
  DISPLAY_TILES_MAX_TEXELS,
  ringLevelChoice,
  ringSlotCount,
  ringWindow,
  tileGrid,
  type TileGrid,
} from "./display-tiles";
import type { PixelRangeList } from "./range-quads";

/** The view the ring must cover, in the file's own frames. */
export type RingView = {
  framesPerPixel: number;
  startFrame: number;
  endFrame: number;
  viewportPixels: number;
};

/** What the display shader needs to address the ring. */
export type RingUniforms = {
  firstTile: number;
  tileCount: number;
  slotCount: number;
  tileTexels: number;
  blend: number;
  level: number;
};

const EMPTY_UNIFORMS: RingUniforms = {
  firstTile: 0,
  tileCount: 0,
  slotCount: 1,
  tileTexels: 0,
  blend: 0,
  level: 0,
};

/**
 * A ring of fixed-size tiles holding the committed picture around the view, in
 * dB, at a level fine enough for the screen. Slot `tileIndex mod slotCount`
 * holds a tile, so a pan re-cuts one tile rather than the window. The ring's
 * size is fixed, so a longer file pans through it rather than costing more.
 */
export class DisplayTileRing {
  private readonly layout: BandLayout;
  private readonly numFrames: number;
  private readonly maxTexels: number;
  private readonly target: WebGLRenderTarget;
  private readonly metadata: Float32Array;
  private readonly metadataTex: DataTexture;
  private readonly draw = new DecimateDraw();
  private grid: TileGrid | null = null;
  private slots = 0;
  private window = { first: 0, count: 0 };
  private residency = new Int32Array(0);
  private blend = 0;

  constructor(layout: BandLayout, numFrames: number, opts?: { maxTexels?: number }) {
    this.layout = layout;
    this.numFrames = numFrames;
    this.maxTexels = opts?.maxTexels ?? DISPLAY_TILES_MAX_TEXELS;

    const width = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, Math.max(1, this.maxTexels));
    const height = Math.max(1, Math.ceil(this.maxTexels / width));
    this.target = new WebGLRenderTarget(width, height, {
      format: RGFormat,
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.metadata = new Float32Array(layout.numBands * 4);
    this.metadataTex = new DataTexture(this.metadata, layout.numBands, 1, RGBAFormat, FloatType);
    this.metadataTex.internalFormat = "RGBA32F";
    this.metadataTex.minFilter = NearestFilter;
    this.metadataTex.magFilter = NearestFilter;
    this.metadataTex.wrapS = ClampToEdgeWrapping;
    this.metadataTex.wrapT = ClampToEdgeWrapping;
    this.metadataTex.needsUpdate = true;
  }

  /** The ring's dB magnitudes; null while it holds no tile. */
  texture(): Texture | null {
    return this.window.count > 0 ? this.target.texture : null;
  }

  /** The per-band layout of a tile, for the display's metadata sampler. */
  metadataTexture(): DataTexture {
    return this.metadataTex;
  }

  /** Texels the ring's texture holds. */
  texelCount(): number {
    return this.target.width * this.target.height;
  }

  uniforms(): RingUniforms {
    if (!this.grid || this.window.count === 0) return EMPTY_UNIFORMS;
    return {
      firstTile: this.window.first,
      tileCount: this.window.count,
      slotCount: this.slots,
      tileTexels: this.grid.tileTexels,
      blend: this.blend,
      level: this.grid.level,
    };
  }

  /**
   * Holds the tiles `view` needs at a level fine enough for it, cutting only
   * the ones the ring does not already hold. Levels the pyramid holds at or
   * below `pyramidStepLog2` are left to it, and the ring empties.
   */
  update(gl: WebGLRenderer, source: CommittedSource, view: RingView, pyramidStepLog2: number): void {
    const choice = ringLevelChoice(view.framesPerPixel);
    if (choice.level >= pyramidStepLog2) {
      this.window = { first: 0, count: 0 };
      return;
    }
    this.blend = choice.blend;

    if (!this.grid || this.grid.level !== choice.level) {
      this.grid = tileGrid(this.layout, this.numFrames, choice.level);
      this.metadata.set(this.grid.metadata);
      this.metadataTex.needsUpdate = true;
      this.slots = 0;
    }
    const slots = ringSlotCount(this.grid, view.viewportPixels, this.maxTexels);
    if (slots !== this.slots) {
      this.slots = slots;
      this.residency = new Int32Array(Math.max(slots, 1)).fill(-1);
      this.window = { first: 0, count: 0 };
      this.draw.reserve(slots * this.layout.numBands);
    }
    if (slots === 0) return;

    this.window = ringWindow(this.grid, slots, view.startFrame, view.endFrame, this.window);

    const instances: DecimateInstance[] = [];
    for (let tile = this.window.first; tile < this.window.first + this.window.count; tile++) {
      const slot = tile % slots;
      if (this.residency[slot] === tile) continue;
      this.appendTile(instances, tile, source.view);
      this.residency[slot] = tile;
    }
    this.draw.run(gl, this.target, source.texture, source.view.textureWidth, "canvas", instances);
  }

  /**
   * Aims the ring at `view` without a covering canvas: picks the level, slots
   * and window the way `update` does, and returns the wanted tiles that are
   * not yet resident, for the caller to cut from packed values. The bound
   * window empties when a wanted tile's slot still shows a different tile,
   * and switches to the wanted window once every tile in it is resident.
   */
  aim(view: RingView, pyramidStepLog2: number): number[] {
    const choice = ringLevelChoice(view.framesPerPixel);
    if (choice.level >= pyramidStepLog2) {
      this.window = { first: 0, count: 0 };
      return [];
    }
    this.blend = choice.blend;

    if (!this.grid || this.grid.level !== choice.level) {
      this.grid = tileGrid(this.layout, this.numFrames, choice.level);
      this.metadata.set(this.grid.metadata);
      this.metadataTex.needsUpdate = true;
      this.slots = 0;
    }
    const slots = ringSlotCount(this.grid, view.viewportPixels, this.maxTexels);
    if (slots !== this.slots) {
      this.slots = slots;
      this.residency = new Int32Array(Math.max(slots, 1)).fill(-1);
      this.window = { first: 0, count: 0 };
      this.draw.reserve(slots * this.layout.numBands);
    }
    if (slots === 0) return [];

    const wanted = ringWindow(this.grid, slots, view.startFrame, view.endFrame, this.window);
    const missing: number[] = [];
    let conflict = false;
    for (let tile = wanted.first; tile < wanted.first + wanted.count; tile++) {
      const held = this.residency[tile % slots];
      if (held === tile) continue;
      missing.push(tile);
      if (held >= this.window.first && held < this.window.first + this.window.count && this.window.count > 0) {
        conflict = true;
      }
    }
    if (conflict) this.window = { first: 0, count: 0 };
    else if (missing.length === 0) this.window = wanted;
    return missing;
  }

  /**
   * The file pixel ranges holding one tile's source bins, as [start, count]
   * per band, in the order `cutTileFromPacked` reads their values.
   */
  tileSourcePixelRanges(tile: number): Uint32Array {
    const grid = this.grid;
    if (!grid) throw new Error("the ring has no grid");
    const ranges: number[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      const run = this.tileSourceRun(grid, tile, band);
      if (!run) continue;
      ranges.push(this.layout.metadata[band * 4] + run.srcStart, run.srcCount);
    }
    return Uint32Array.from(ranges);
  }

  /**
   * Cuts one tile's slot from `values`, the compact packed pixels of
   * `tileSourcePixelRanges(tile)`. Cutting into a slot the bound window
   * still shows as another tile would corrupt the picture, so that throws;
   * `aim` empties the window first when a pan retargets its slots.
   */
  cutTileFromPacked(gl: WebGLRenderer, tile: number, values: Float32Array): void {
    const grid = this.grid;
    if (!grid || this.slots === 0) throw new Error("the ring has no grid to cut into");
    const slot = tile % this.slots;
    const held = this.residency[slot];
    if (
      held !== tile &&
      held >= this.window.first &&
      held < this.window.first + this.window.count &&
      this.window.count > 0
    ) {
      throw new Error("the tile's slot still shows another tile");
    }

    const instances: DecimateInstance[] = [];
    let texels = 0;
    for (let band = 0; band < this.layout.numBands; band++) {
      const run = this.tileSourceRun(grid, tile, band);
      if (!run) continue;
      instances.push({
        destStart: slot * grid.tileTexels + grid.metadata[band * 4],
        destCount: run.destCount,
        srcStart: texels,
        decimation: run.decimation,
      });
      texels += run.srcCount;
    }
    if (values.length !== texels * 4) throw new Error("the values do not match the tile's source pixels");
    if (texels === 0) return;

    const width = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, texels);
    const height = Math.ceil(texels / width);
    let padded = values;
    if (values.length !== width * height * 4) {
      padded = new Float32Array(width * height * 4);
      padded.set(values);
    }
    const chunk = new DataTexture(padded, width, height, RGBAFormat, FloatType);
    chunk.internalFormat = "RGBA32F";
    chunk.needsUpdate = true;
    gl.initTexture(chunk);
    this.draw.run(gl, this.target, chunk, width, "canvas", instances);
    chunk.dispose();
    this.residency[slot] = tile;
  }

  /** One band's ring-bin and source-bin runs inside a tile, or null when the band has none. */
  private tileSourceRun(
    grid: TileGrid,
    tile: number,
    band: number,
  ): { destCount: number; srcStart: number; srcCount: number; decimation: number } | null {
    const sourceStep = this.layout.metadata[band * 4 + 2];
    const ringStep = grid.metadata[band * 4 + 2];
    const decimation = 2 ** (ringStep - sourceStep);
    const totalBins = grid.metadata[band * 4 + 1];
    const binsPerTile = grid.metadata[band * 4 + 3];
    const base = tile * binsPerTile;
    const end = Math.min(base + binsPerTile, totalBins);
    if (end <= base) return null;
    const srcStart = base * decimation;
    const srcEnd = Math.min(end * decimation, this.layout.metadata[band * 4 + 1]);
    return { destCount: end - base, srcStart, srcCount: srcEnd - srcStart, decimation };
  }

  /**
   * Re-cuts the bins `changed` covers in every tile the ring holds, with
   * `changed` in the source view's own pixel space. Tiles the change misses
   * are left alone. While no window is held the change cannot be cut, so
   * every slot is marked stale instead.
   */
  refreshFromCanvas(gl: WebGLRenderer, source: CommittedSource, changed: PixelRangeList): void {
    if (!this.grid) return;
    if (this.window.count === 0) {
      this.residency.fill(-1);
      return;
    }
    const viewSpans = sourceBinRanges(source.view.layout, changed.ranges.subarray(0, changed.count * 2));
    const spans = new Uint32Array(this.layout.numBands * 2);
    for (let band = 0; band < this.layout.numBands; band++) {
      if (viewSpans[band * 2 + 1] <= viewSpans[band * 2]) continue;
      spans[band * 2] = source.view.bandK0[band] + viewSpans[band * 2];
      spans[band * 2 + 1] = source.view.bandK0[band] + viewSpans[band * 2 + 1];
    }
    const instances: DecimateInstance[] = [];
    for (let tile = this.window.first; tile < this.window.first + this.window.count; tile++) {
      if (this.residency[tile % this.slots] !== tile) continue;
      this.appendTile(instances, tile, source.view, spans);
    }
    this.draw.run(gl, this.target, source.texture, source.view.textureWidth, "canvas", instances);
  }

  /**
   * Adds the instances filling one tile's slot from the committed source,
   * restricted to the source bin spans `spans` names when it is given.
   * Cutting a whole tile the source view does not fully cover would leave
   * part of its slot stale, so that throws; a refresh clamps instead — a tap
   * outside the view was never painted, so its encoded value stands.
   */
  private appendTile(instances: DecimateInstance[], tile: number, source: CanvasView, spans?: Uint32Array): void {
    const grid = this.grid;
    if (!grid) return;
    const slot = tile % this.slots;
    for (let band = 0; band < this.layout.numBands; band++) {
      const sourceStep = this.layout.metadata[band * 4 + 2];
      const ringStep = grid.metadata[band * 4 + 2];
      const decimation = 2 ** (ringStep - sourceStep);
      const totalBins = grid.metadata[band * 4 + 1];
      const binsPerTile = grid.metadata[band * 4 + 3];
      const base = tile * binsPerTile;

      let start = base;
      let end = Math.min(base + binsPerTile, totalBins);
      if (spans) {
        // A ring bin reads the source bin at its own stride, so the bins a
        // source span touches start at the first stride step inside it.
        start = Math.max(start, Math.ceil(spans[band * 2] / decimation));
        end = Math.min(end, Math.ceil(spans[band * 2 + 1] / decimation));
      }
      const first = source.bandK0[band];
      const clamped = clampToSourceBins(start, end, decimation, first, first + source.layout.metadata[band * 4 + 1]);
      if (!spans && end > start && (clamped.start !== start || clamped.end !== end)) {
        throw new Error("the committed source does not cover the ring window");
      }
      start = clamped.start;
      end = clamped.end;
      if (end <= start) continue;

      instances.push({
        destStart: slot * grid.tileTexels + grid.metadata[band * 4] + (start - base),
        destCount: end - start,
        srcStart: source.layout.metadata[band * 4] + start * decimation - first,
        decimation,
      });
    }
  }

  dispose(): void {
    this.target.dispose();
    this.metadataTex.dispose();
    this.draw.dispose();
  }
}
