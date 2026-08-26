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
import { DecimateDraw, type DecimateInstance } from "./display-decimate";
import { sourceBinRanges, type BandLayout } from "./display-pyramid";
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
  update(gl: WebGLRenderer, canvas: Texture, canvasWidth: number, view: RingView, pyramidStepLog2: number): void {
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
    }
    if (slots === 0) return;

    this.window = ringWindow(this.grid, slots, view.startFrame, view.endFrame, this.window);

    const instances: DecimateInstance[] = [];
    for (let tile = this.window.first; tile < this.window.first + this.window.count; tile++) {
      const slot = tile % slots;
      if (this.residency[slot] === tile) continue;
      this.appendTile(instances, tile);
      this.residency[slot] = tile;
    }
    this.draw.run(gl, this.target, canvas, canvasWidth, "canvas", instances);
  }

  /**
   * Re-cuts the bins `changed` covers in every tile the ring holds. Tiles the
   * change misses are left alone.
   */
  refreshFromCanvas(gl: WebGLRenderer, canvas: Texture, canvasWidth: number, changed: PixelRangeList): void {
    if (!this.grid || this.window.count === 0) return;
    const spans = sourceBinRanges(this.layout, changed.ranges.subarray(0, changed.count * 2));
    const instances: DecimateInstance[] = [];
    for (let tile = this.window.first; tile < this.window.first + this.window.count; tile++) {
      if (this.residency[tile % this.slots] !== tile) continue;
      this.appendTile(instances, tile, spans);
    }
    this.draw.run(gl, this.target, canvas, canvasWidth, "canvas", instances);
  }

  /**
   * Adds the instances filling one tile's slot from the canvas, restricted to
   * the source bin spans `spans` names when it is given.
   */
  private appendTile(instances: DecimateInstance[], tile: number, spans?: Uint32Array): void {
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
      if (end <= start) continue;

      instances.push({
        destStart: slot * grid.tileTexels + grid.metadata[band * 4] + (start - base),
        destCount: end - start,
        srcStart: this.layout.metadata[band * 4] + start * decimation,
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
