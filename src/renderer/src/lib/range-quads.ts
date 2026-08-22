import { BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry } from "three";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Packed-pixel ranges drawn as quads: `ranges` holds (start, count) pairs, `count` of them. */
export interface PixelRangeList {
  ranges: Uint32Array;
  count: number;
}

/**
 * Instanced unit-quad geometry whose `aRange` attribute carries one packed
 * pixel range per instance, for materials built on range-quad.vert.
 */
export class RangeQuadGeometry {
  readonly geometry = new InstancedBufferGeometry();
  private attribute: InstancedBufferAttribute;

  constructor(initialCapacity = 16) {
    this.geometry.setAttribute("position", new BufferAttribute(QUAD_POSITIONS, 3));
    this.geometry.setIndex(new BufferAttribute(QUAD_INDICES, 1));
    this.attribute = this.createAttribute(initialCapacity);
  }

  private createAttribute(capacity: number): InstancedBufferAttribute {
    const attribute = new InstancedBufferAttribute(new Uint32Array(capacity * 2), 2);
    attribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aRange", attribute);
    return attribute;
  }

  /** Makes the next draw cover exactly `list`'s ranges. */
  setRanges(list: PixelRangeList): void {
    const capacity = this.attribute.array.length / 2;
    if (list.count > capacity) {
      this.attribute = this.createAttribute(Math.max(list.count, capacity * 2));
    }
    const array = this.attribute.array as Uint32Array;
    array.set(list.ranges.subarray(0, list.count * 2));
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(0, list.count * 2);
    this.attribute.needsUpdate = true;
    this.geometry.instanceCount = list.count;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** A single range covering the whole texture. */
export function fullTextureRange(textureWidth: number, textureHeight: number): PixelRangeList {
  return { ranges: new Uint32Array([0, textureWidth * textureHeight]), count: 1 };
}

/** A single range covering packed rows [rowStart, rowStart + rowCount). */
export function rowRange(textureWidth: number, rowStart: number, rowCount: number): PixelRangeList {
  return { ranges: new Uint32Array([rowStart * textureWidth, rowCount * textureWidth]), count: 1 };
}

/** The time window of a brush in whole frames, or null when it spans every frame. */
export type FrameWindow = { frameStart: number; frameEnd: number } | null;

/** Per-band bin ranges [start, end) as a numBands×1 RGBA texture's data. */
export type BinRanges = Float32Array;

/**
 * Splits the packed pixels a brush can write into row-bounded ranges: for each
 * band in [lowBand, highBand] the bins whose frames fall in `window`, widened
 * by `marginBins` on both sides, split wherever they cross a texture row.
 * Writes (start, count) pairs into `ranges` and the per-band [binStart, binEnd)
 * into `binRanges` (bands outside the brush get an empty range). Returns the
 * range count; `ranges` needs room for three ranges per band.
 */
export function brushFootprintRanges(
  layout: { metadata: Float32Array; numBands: number; textureWidth: number },
  lowBand: number,
  highBand: number,
  window: FrameWindow,
  marginBins: number,
  ranges: Uint32Array,
  binRanges: BinRanges,
): number {
  const { metadata, numBands, textureWidth } = layout;
  binRanges.fill(0);
  let count = 0;
  for (let band = Math.max(0, lowBand); band <= Math.min(numBands - 1, highBand); band++) {
    const offset = metadata[band * 4];
    const length = metadata[band * 4 + 1];
    const cell = 2 ** metadata[band * 4 + 2];
    let binStart = 0;
    let binEnd = length;
    if (window) {
      binStart = Math.max(0, Math.floor(window.frameStart / cell) - marginBins);
      binEnd = Math.min(length, Math.ceil(window.frameEnd / cell) + marginBins + 1);
    }
    if (binEnd <= binStart) continue;
    binRanges[band * 4] = binStart;
    binRanges[band * 4 + 1] = binEnd;

    const start = offset + binStart;
    const end = offset + binEnd;
    const firstRow = Math.floor(start / textureWidth);
    const lastRow = Math.floor((end - 1) / textureWidth);
    if (firstRow === lastRow) {
      ranges[count * 2] = start;
      ranges[count * 2 + 1] = end - start;
      count++;
      continue;
    }
    const firstRowEnd = (firstRow + 1) * textureWidth;
    ranges[count * 2] = start;
    ranges[count * 2 + 1] = firstRowEnd - start;
    count++;
    const lastRowStart = lastRow * textureWidth;
    if (lastRowStart > firstRowEnd) {
      ranges[count * 2] = firstRowEnd;
      ranges[count * 2 + 1] = lastRowStart - firstRowEnd;
      count++;
    }
    ranges[count * 2] = lastRowStart;
    ranges[count * 2 + 1] = end - lastRowStart;
    count++;
  }
  return count;
}
