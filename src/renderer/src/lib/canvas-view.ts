import { bandAtPixel, type BandLayout } from "./band-layout";
import { blockGrid, frameRangeOfBlock, type BlockGrid } from "./block-grid";
import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";

/**
 * A block-aligned span of a file as its own packed layout. The view's
 * metadata has the same shape a file's has, so the stroke shaders render
 * over a view exactly as they render over a whole file; only the frame
 * origin moves.
 */
export type CanvasView = {
  firstBlock: number;
  lastBlock: number;
  /** Absolute frame span the view holds; both edges sit on every band's bin grid. */
  startFrame: number;
  endFrame: number;
  /** The view's packed pixels in the file, as [absolute start, count] per band. */
  ranges: Uint32Array;
  /** The view's own band layout, offsets counted inside the view. */
  layout: BandLayout;
  /** Absolute bin index of each band's first view bin. */
  bandK0: Uint32Array;
  texels: number;
  textureWidth: number;
  textureHeight: number;
};

/** The view spanning the blocks [firstBlock, lastBlock] of `grid`. */
export function canvasViewOf(grid: BlockGrid, firstBlock: number, lastBlock: number): CanvasView {
  const { layout, numFrames } = grid;
  const startFrame = frameRangeOfBlock(grid, firstBlock).start;
  const endFrame = frameRangeOfBlock(grid, lastBlock).end;
  const ranges = new Uint32Array(layout.numBands * 2);
  const metadata = new Float32Array(layout.numBands * 4);
  const bandK0 = new Uint32Array(layout.numBands);
  let texels = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const offset = layout.metadata[band * 4];
    const length = layout.metadata[band * 4 + 1];
    const step = layout.metadata[band * 4 + 2];
    const k0 = Math.min(length, startFrame / 2 ** step);
    const kEnd = endFrame >= numFrames ? length : Math.min(length, endFrame / 2 ** step);
    const count = Math.max(0, kEnd - k0);
    ranges[band * 2] = offset + k0;
    ranges[band * 2 + 1] = count;
    metadata[band * 4] = texels;
    metadata[band * 4 + 1] = count;
    metadata[band * 4 + 2] = step;
    metadata[band * 4 + 3] = layout.metadata[band * 4 + 3];
    bandK0[band] = k0;
    texels += count;
  }
  const textureWidth = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, Math.max(1, texels));
  const textureHeight = Math.max(1, Math.ceil(texels / textureWidth));
  return {
    firstBlock,
    lastBlock,
    startFrame,
    endFrame,
    ranges,
    layout: { numBands: layout.numBands, metadata },
    bandK0,
    texels,
    textureWidth,
    textureHeight,
  };
}

/**
 * The view spanning the whole file, keeping the file's own texture fold —
 * not every analysis sizes its packed texture by the view width convention.
 */
export function wholeFileCanvasView(data: {
  numBands: number;
  metadata: Float32Array;
  numFrames: number;
  sampleRate: number;
  textureWidth: number;
  textureHeight: number;
}): CanvasView {
  const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate);
  return {
    ...canvasViewOf(grid, 0, grid.blockCount - 1),
    textureWidth: data.textureWidth,
    textureHeight: data.textureHeight,
  };
}

/**
 * File-absolute pixel ranges as the view's own pixel indices, split at band
 * edges. Null when any pixel falls outside the view, which would leave it
 * without a place in the view's textures.
 */
export function fileRangesToView(view: CanvasView, fileLayout: BandLayout, ranges: Uint32Array): Uint32Array | null {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    let start = ranges[i];
    let left = ranges[i + 1];
    while (left > 0) {
      const band = bandAtPixel(fileLayout, start);
      const bandStart = fileLayout.metadata[band * 4];
      const bandEnd = bandStart + fileLayout.metadata[band * 4 + 1];
      const count = Math.min(left, bandEnd - start);
      if (count <= 0) return null;
      const viewStart = view.ranges[band * 2];
      const viewCount = view.ranges[band * 2 + 1];
      if (start < viewStart || start + count > viewStart + viewCount) return null;
      out.push(view.layout.metadata[band * 4] + (start - viewStart), count);
      start += count;
      left -= count;
    }
  }
  return Uint32Array.from(out);
}

/** The view's own pixel ranges as file-absolute ranges, split at band edges. */
export function viewRangesToFile(view: CanvasView, ranges: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    let start = ranges[i];
    let left = ranges[i + 1];
    while (left > 0) {
      const band = bandAtPixel(view.layout, start);
      const bandStart = view.layout.metadata[band * 4];
      const bandEnd = bandStart + view.layout.metadata[band * 4 + 1];
      const count = Math.min(left, Math.max(0, bandEnd - start));
      if (count <= 0) throw new Error("view range reaches outside the view's bands");
      out.push(view.ranges[band * 2] + (start - bandStart), count);
      start += count;
      left -= count;
    }
  }
  return Uint32Array.from(out);
}
