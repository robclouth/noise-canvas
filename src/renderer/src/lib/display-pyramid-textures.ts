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

import type { BandLayout } from "./band-layout";
import { DecimateDraw, type DecimateInstance, type SourcePixels } from "./display-decimate";
import {
  displayPyramidLevels,
  levelBinSpan,
  levelDecimation,
  sourceBinRanges,
  type DisplayPyramidLevel,
} from "./display-pyramid";
import type { PixelRangeList } from "./range-quads";

// Bins one CPU upload batch may hold: 8192 wide by 512 rows is 32 MB of RG32F,
// small enough to stay transient and large enough that a whole file seeds in a
// handful of draws.
const UPLOAD_CHUNK_BINS = 8192 * 512;
const UPLOAD_CHUNK_WIDTH = 8192;

/**
 * The display's committed picture, as a stack of dB magnitude levels over the
 * packed band layout. The stack's size is capped, so a longer file starts at a
 * coarser level rather than holding more.
 */
export class DisplayPyramid {
  readonly levels: DisplayPyramidLevel[];
  private readonly targets: WebGLRenderTarget[];
  private readonly metadataTextures: DataTexture[];
  private readonly draw = new DecimateDraw();
  private readonly layout: BandLayout;
  private readonly uploadChunkBins: number;
  private seeded = false;

  constructor(layout: BandLayout, opts?: { maxTexels?: number; uploadChunkBins?: number }) {
    this.layout = layout;
    this.uploadChunkBins = opts?.uploadChunkBins ?? UPLOAD_CHUNK_BINS;
    this.levels = displayPyramidLevels(layout, opts?.maxTexels);

    this.targets = this.levels.map(
      (level) =>
        new WebGLRenderTarget(level.textureWidth, level.textureHeight, {
          format: RGFormat,
          type: HalfFloatType,
          minFilter: NearestFilter,
          magFilter: NearestFilter,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    );
    this.metadataTextures = this.levels.map((level) => {
      const texture = new DataTexture(level.metadata, layout.numBands, 1, RGBAFormat, FloatType);
      texture.internalFormat = "RGBA32F";
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
      return texture;
    });
  }

  /** The dB magnitudes of one level; null until the pyramid is seeded. */
  texture(levelIndex: number): Texture | null {
    return this.seeded ? this.targets[levelIndex].texture : null;
  }

  /** The per-band layout of one level, for the display's metadata sampler. */
  metadataTexture(levelIndex: number): DataTexture {
    return this.metadataTextures[levelIndex];
  }

  /** Texels every level holds together. */
  texelCount(): number {
    return this.levels.reduce((sum, level) => sum + level.texelCount, 0);
  }

  /**
   * Encodes the whole packed state, then decimates it up the stack. Texels
   * past the last band are left alone: no band's metadata reaches them, so
   * nothing samples them.
   */
  seedFromPacked(gl: WebGLRenderer, data: Float32Array): void {
    const instances: DecimateInstance[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      const instance = this.finestInstance(band, 0, this.layout.metadata[band * 4 + 1]);
      if (instance) instances.push(instance);
    }
    this.uploadInstances(gl, data, instances);
    this.seeded = true;
    this.decimateUpward(gl, null);
  }

  /**
   * Re-encodes the bins `pixelRanges` covers and decimates them up the stack.
   * A patch into an unseeded pyramid is skipped: the seed that must follow
   * reads the same packed state.
   */
  patchFromPacked(gl: WebGLRenderer, data: Float32Array, pixelRanges: Uint32Array): void {
    if (!this.seeded) return;
    const spans = sourceBinRanges(this.layout, pixelRanges);
    const instances = this.finestInstances(spans);
    if (instances.length === 0) return;
    this.uploadInstances(gl, data, instances);
    this.decimateUpward(gl, spans);
  }

  /**
   * Re-encodes the bins `changed` covers straight off the canvas, which holds
   * the packed layout, and carries them up the stack.
   */
  refreshFromCanvas(gl: WebGLRenderer, canvas: Texture, canvasWidth: number, changed: PixelRangeList): void {
    const spans = sourceBinRanges(this.layout, changed.ranges.subarray(0, changed.count * 2));
    const instances = this.finestInstances(spans);
    if (instances.length === 0) return;
    this.run(gl, 0, canvas, canvasWidth, "canvas", instances);
    this.seeded = true;
    this.decimateUpward(gl, spans);
  }

  /** The instances writing every band's source bin span into the finest level. */
  private finestInstances(spans: Uint32Array): DecimateInstance[] {
    const instances: DecimateInstance[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      if (spans[band * 2 + 1] <= spans[band * 2]) continue;
      const instance = this.finestInstance(band, spans[band * 2], spans[band * 2 + 1]);
      if (instance) instances.push(instance);
    }
    return instances;
  }

  /** The instance writing one band's source bins [start, end) into the finest level. */
  private finestInstance(band: number, start: number, end: number): DecimateInstance | null {
    const level = this.levels[0];
    const sourceStep = this.layout.metadata[band * 4 + 2];
    const span = levelBinSpan(level, band, sourceStep, start, end);
    if (span.end <= span.start) return null;
    const decimation = levelDecimation(level, sourceStep, band);
    return {
      destStart: level.metadata[band * 4] + span.start,
      destCount: span.end - span.start,
      srcStart: this.layout.metadata[band * 4] + span.start * decimation,
      decimation,
    };
  }

  /**
   * Rebuilds every level above the finest from the one below it, over the
   * bands `spans` names in source bins, or over all of them when it is null.
   */
  private decimateUpward(gl: WebGLRenderer, spans: Uint32Array | null): void {
    for (let index = 1; index < this.levels.length; index++) {
      const source = this.levels[index - 1];
      const dest = this.levels[index];
      const instances: DecimateInstance[] = [];
      for (let band = 0; band < this.layout.numBands; band++) {
        const sourceStep = this.layout.metadata[band * 4 + 2];
        const start = spans ? spans[band * 2] : 0;
        const end = spans ? spans[band * 2 + 1] : this.layout.metadata[band * 4 + 1];
        if (end <= start) continue;
        const span = levelBinSpan(dest, band, sourceStep, start, end);
        if (span.end <= span.start) continue;
        const decimation = 2 ** (dest.metadata[band * 4 + 2] - source.metadata[band * 4 + 2]);
        instances.push({
          destStart: dest.metadata[band * 4] + span.start,
          destCount: span.end - span.start,
          srcStart: source.metadata[band * 4] + span.start * decimation,
          decimation,
        });
      }
      this.run(gl, index, this.targets[index - 1].texture, source.textureWidth, "levelDb", instances);
    }
  }

  /**
   * Gathers the bins each instance reads out of the packed array, at the
   * instance's stride, and draws them into the finest level in batches no
   * larger than one upload chunk.
   */
  private uploadInstances(gl: WebGLRenderer, data: Float32Array, instances: DecimateInstance[]): void {
    let index = 0;
    let done = 0;
    while (index < instances.length) {
      const batch: DecimateInstance[] = [];
      const pieces: Array<{ srcStart: number; stride: number; count: number }> = [];
      let used = 0;
      while (index < instances.length && used < this.uploadChunkBins) {
        const instance = instances[index];
        const take = Math.min(instance.destCount - done, this.uploadChunkBins - used);
        pieces.push({
          srcStart: instance.srcStart + done * instance.decimation,
          stride: instance.decimation,
          count: take,
        });
        batch.push({ destStart: instance.destStart + done, destCount: take, srcStart: used, decimation: 1 });
        used += take;
        done += take;
        if (done === instance.destCount) {
          index++;
          done = 0;
        }
      }
      if (used === 0) break;

      const width = Math.min(used, UPLOAD_CHUNK_WIDTH);
      const height = Math.ceil(used / width);
      const chunk = new Float32Array(width * height * 2);
      let at = 0;
      for (const piece of pieces) {
        for (let k = 0; k < piece.count; k++) {
          const source = (piece.srcStart + k * piece.stride) * 4;
          chunk[at * 2] = data[source];
          chunk[at * 2 + 1] = data[source + 2];
          at++;
        }
      }

      const texture = new DataTexture(chunk, width, height, RGFormat, FloatType);
      texture.internalFormat = "RG32F";
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.needsUpdate = true;
      this.run(gl, 0, texture, width, "chunk", batch);
      texture.dispose();
    }
  }

  private run(
    gl: WebGLRenderer,
    levelIndex: number,
    source: Texture,
    srcWidth: number,
    mode: SourcePixels,
    instances: DecimateInstance[],
  ): void {
    this.draw.run(gl, this.targets[levelIndex], source, srcWidth, mode, instances);
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    for (const texture of this.metadataTextures) texture.dispose();
    this.draw.dispose();
  }
}
