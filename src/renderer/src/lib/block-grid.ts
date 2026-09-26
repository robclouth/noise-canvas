import { bandAtPixel, coarsestStepLog2, type BandLayout } from "./band-layout";
import type { PixelRangeList } from "./range-quads";

/** Seconds of audio one block covers, before rounding up to the band grid. */
export const BLOCK_TARGET_SECONDS = 2;

/** Bytes one packed coefficient holds: RGBA32F, magnitude and phase per channel. */
export const PACKED_BYTES_PER_TEXEL = 16;

/**
 * The file cut into fixed spans of time. A block's span is a whole, even
 * number of every band's bins, so no bin straddles a block edge, a block can
 * be read, written and encoded on its own, and a bin's index in a view has the
 * parity of its index in the file.
 */
export type BlockGrid = {
  layout: BandLayout;
  numFrames: number;
  blockFrames: number;
  blockCount: number;
  /** Bins one block holds, per band. */
  binsPerBlock: Float32Array;
};

/** The block grid for a band layout, with blocks close to `targetSeconds` long. */
export function blockGrid(
  layout: BandLayout,
  numFrames: number,
  sampleRate: number,
  targetSeconds = BLOCK_TARGET_SECONDS,
): BlockGrid {
  const quantum = 2 ** (coarsestStepLog2(layout) + 1);
  const blockFrames = quantum * Math.max(1, Math.round((targetSeconds * sampleRate) / quantum));
  const binsPerBlock = new Float32Array(layout.numBands);
  for (let band = 0; band < layout.numBands; band++) {
    binsPerBlock[band] = blockFrames / 2 ** layout.metadata[band * 4 + 2];
  }
  return {
    layout,
    numFrames,
    blockFrames,
    blockCount: Math.max(1, Math.ceil(numFrames / blockFrames)),
    binsPerBlock,
  };
}

/** Frames in one bin of the coarsest band: how far past a cut a pixel beside it interpolates. */
export function coarsestBinFrames(grid: BlockGrid): number {
  return grid.blockFrames / Math.min(...grid.binsPerBlock);
}

/** The block holding a frame, clamped to the file. */
export function blockOfFrame(grid: BlockGrid, frame: number): number {
  const index = Math.floor(frame / grid.blockFrames);
  return Math.min(Math.max(index, 0), grid.blockCount - 1);
}

/** The frames one block covers, clipped to the file's length. */
export function frameRangeOfBlock(grid: BlockGrid, index: number): { start: number; end: number } {
  const start = index * grid.blockFrames;
  return { start, end: Math.min(start + grid.blockFrames, grid.numFrames) };
}

/** Every block a frame range [startFrame, endFrame) touches, in order. */
export function blocksForFrameRange(grid: BlockGrid, startFrame: number, endFrame: number): number[] {
  if (endFrame <= startFrame) return [];
  const first = blockOfFrame(grid, startFrame);
  const last = blockOfFrame(grid, endFrame - 1);
  const blocks: number[] = [];
  for (let index = first; index <= last; index++) blocks.push(index);
  return blocks;
}

/**
 * The packed pixels one block holds, one range per band it reaches. Offsets
 * come from the layout's float32 metadata, the same numbers the shaders
 * address with, so a block's pixels are the ones the GPU calls its own.
 */
export function blockPixelRanges(grid: BlockGrid, index: number): PixelRangeList {
  const { layout } = grid;
  const ranges = new Uint32Array(layout.numBands * 2);
  let count = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const bins = grid.binsPerBlock[band];
    const first = index * bins;
    const length = layout.metadata[band * 4 + 1];
    if (first >= length) continue;
    ranges[count * 2] = layout.metadata[band * 4] + first;
    ranges[count * 2 + 1] = Math.min(bins, length - first);
    count++;
  }
  return { ranges, count };
}

/**
 * One block's own packed layout: each band's run of the block, laid out back to
 * back in band order — the order `blockPixelRanges` gathers them in. A pass
 * over one block reads this where a pass over the file reads the file's.
 */
export function blockBandLayout(
  grid: BlockGrid,
  index: number,
): { numBands: number; bandOffsets: Uint32Array; bandLengths: Uint32Array } {
  const { layout } = grid;
  const bandOffsets = new Uint32Array(layout.numBands);
  const bandLengths = new Uint32Array(layout.numBands);
  let at = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const bins = grid.binsPerBlock[band];
    const first = index * bins;
    const length = layout.metadata[band * 4 + 1];
    bandOffsets[band] = at;
    bandLengths[band] = first >= length ? 0 : Math.min(bins, length - first);
    at += bandLengths[band];
  }
  return { numBands: layout.numBands, bandOffsets, bandLengths };
}

/** Packed texels one block holds. */
export function blockTexels(grid: BlockGrid, index: number): number {
  const list = blockPixelRanges(grid, index);
  let texels = 0;
  for (let i = 0; i < list.count; i++) texels += list.ranges[i * 2 + 1];
  return texels;
}

/** Every block the packed pixel ranges reach, in order and without repeats. */
export function blocksForPixelRanges(grid: BlockGrid, pixelRanges: Uint32Array): number[] {
  const { layout } = grid;
  const touched = new Uint8Array(grid.blockCount);
  for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
    const start = pixelRanges[i];
    const end = start + pixelRanges[i + 1];
    if (end <= start) continue;
    for (let band = bandAtPixel(layout, start); band < layout.numBands; band++) {
      const offset = layout.metadata[band * 4];
      if (offset >= end) break;
      const length = layout.metadata[band * 4 + 1];
      const low = Math.max(start, offset);
      const high = Math.min(end, offset + length);
      if (high <= low) continue;
      const bins = grid.binsPerBlock[band];
      const first = Math.min(Math.floor((low - offset) / bins), grid.blockCount - 1);
      const last = Math.min(Math.floor((high - 1 - offset) / bins), grid.blockCount - 1);
      for (let index = first; index <= last; index++) touched[index] = 1;
    }
  }
  const blocks: number[] = [];
  for (let index = 0; index < grid.blockCount; index++) if (touched[index]) blocks.push(index);
  return blocks;
}
