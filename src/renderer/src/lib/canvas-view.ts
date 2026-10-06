import { Vector2 } from "three";
import { bandAtPixel, type BandLayout } from "./band-layout";
import { blockGrid, blockOfFrame, frameRangeOfBlock, gridQuantumFrames, type BlockGrid } from "./block-grid";
import { packedFold } from "./constants";

/**
 * A span of a file as its own packed layout. The view's metadata has the
 * same shape a file's has, so the stroke shaders render over a view exactly
 * as they render over a whole file; only the frame origin moves.
 */
export type CanvasView = {
  /** The blocks the view touches. */
  firstBlock: number;
  lastBlock: number;
  /** Absolute frame span the view holds; both edges sit on every band's bin grid, at an even bin. */
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

/** The texture a whole file's packed run folds into, as a shader reads its size. */
export function packedTextureSizeOf(texels: number): Vector2 {
  const { width, height } = packedFold(texels);
  return new Vector2(width, height);
}

/** A run of bands, [first, last], a view may hold on its own. */
export type BandSpan = { first: number; last: number };

/**
 * The view spanning the blocks [firstBlock, lastBlock] of `grid`, over every
 * band or only those of `bands`; the others hold no bins.
 */
export function canvasViewOf(grid: BlockGrid, firstBlock: number, lastBlock: number, bands?: BandSpan): CanvasView {
  const startFrame = frameRangeOfBlock(grid, firstBlock).start;
  return viewOver(grid, startFrame, frameRangeOfBlock(grid, lastBlock).end, firstBlock, lastBlock, bands);
}

/**
 * The view over the frames [start, end) of `grid`, its edges moved out to the
 * grid's quantum, over every band or only those of `bands`. `firstBlock` and
 * `lastBlock` are the blocks it touches.
 */
export function canvasViewOfFrames(grid: BlockGrid, start: number, end: number, bands?: BandSpan): CanvasView {
  const quantum = gridQuantumFrames(grid);
  const startFrame = Math.max(0, Math.floor(start / quantum) * quantum);
  const endFrame = Math.min(grid.numFrames, Math.max(startFrame + quantum, Math.ceil(end / quantum) * quantum));
  return viewOver(grid, startFrame, endFrame, blockOfFrame(grid, startFrame), blockOfFrame(grid, endFrame - 1), bands);
}

function viewOver(
  grid: BlockGrid,
  startFrame: number,
  endFrame: number,
  firstBlock: number,
  lastBlock: number,
  bands?: BandSpan,
): CanvasView {
  const { layout, numFrames } = grid;
  const ranges = new Uint32Array(layout.numBands * 2);
  const metadata = new Float64Array(layout.numBands * 4);
  const bandK0 = new Uint32Array(layout.numBands);
  let texels = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const offset = layout.metadata[band * 4];
    const length = layout.metadata[band * 4 + 1];
    const step = layout.metadata[band * 4 + 2];
    const k0 = Math.min(length, startFrame / 2 ** step);
    const kEnd = endFrame >= numFrames ? length : Math.min(length, endFrame / 2 ** step);
    const held = !bands || (band >= bands.first && band <= bands.last);
    const count = held ? Math.max(0, kEnd - k0) : 0;
    ranges[band * 2] = offset + k0;
    ranges[band * 2 + 1] = count;
    metadata[band * 4] = texels;
    metadata[band * 4 + 1] = count;
    metadata[band * 4 + 2] = step;
    metadata[band * 4 + 3] = layout.metadata[band * 4 + 3];
    bandK0[band] = k0;
    texels += count;
  }
  const { width: textureWidth, height: textureHeight } = packedFold(texels);
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

/** The view spanning the whole file. */
export function wholeFileCanvasView(data: {
  numBands: number;
  metadata: Float64Array;
  numFrames: number;
  sampleRate: number;
}): CanvasView {
  const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate);
  return canvasViewOf(grid, 0, grid.blockCount - 1);
}

/**
 * The view's synthesis inverse map: [view frame, band] per packed pixel,
 * padded to the view's texture. Padding pixels map to the lowest band at
 * frame 0, the same convention the file's own map uses.
 */
export function canvasViewInverseMap(view: CanvasView): Float32Array {
  const { layout, textureWidth, textureHeight } = view;
  const out = new Float32Array(textureWidth * textureHeight * 2);
  for (let i = 0; i < textureWidth * textureHeight; i++) {
    out[i * 2 + 1] = layout.numBands - 1;
  }
  for (let band = 0; band < layout.numBands; band++) {
    const offset = layout.metadata[band * 4];
    const count = layout.metadata[band * 4 + 1];
    const step = 2 ** layout.metadata[band * 4 + 2];
    for (let k = 0; k < count; k++) {
      const index = offset + k;
      out[index * 2] = k * step;
      out[index * 2 + 1] = band;
    }
  }
  return out;
}

/** The view's packed content gathered from a whole-file packed array, padded to the view's texture. */
export function composeViewContent(view: CanvasView, filePacked: Float32Array): Float32Array {
  const out = new Float32Array(view.textureWidth * view.textureHeight * 4);
  for (let band = 0; band < view.layout.numBands; band++) {
    const fileStart = view.ranges[band * 2];
    const count = view.ranges[band * 2 + 1];
    const viewStart = view.layout.metadata[band * 4];
    out.set(filePacked.subarray(fileStart * 4, (fileStart + count) * 4), viewStart * 4);
  }
  return out;
}

/** True when the view holds every frame of a file `numFrames` long. */
export function viewCoversFile(view: CanvasView, numFrames: number): boolean {
  return view.startFrame === 0 && view.endFrame >= numFrames;
}

/** A time UV on the view's span as the same position on the file's span. */
export function viewUvToFileUv(view: CanvasView, numFrames: number, x: number): number {
  return (view.startFrame + x * (view.endFrame - view.startFrame)) / numFrames;
}

/** The view frames of `clip`'s file frames [start, end), cut to the view. */
export function clipToView(
  view: CanvasView,
  clip: { start: number; end: number },
): { frameStart: number; frameEnd: number } {
  const frames = view.endFrame - view.startFrame;
  return {
    frameStart: Math.max(0, clip.start - view.startFrame),
    frameEnd: Math.min(frames, clip.end - view.startFrame),
  };
}

/** A time UV on the file's span as the same position on the view's span. */
export function fileUvToViewUv(view: CanvasView, numFrames: number, x: number): number {
  return (x * numFrames - view.startFrame) / (view.endFrame - view.startFrame);
}

/**
 * Clips file-absolute pixel ranges to the view: the covered pieces as view
 * pixel ranges and as file ranges, split at band edges in walk order, with
 * the covered pixels of `values` (the ranges' compact pixels) gathered in
 * the same order. `covered` is false when some pixel fell outside the view.
 */
export function clipRangesToView(
  view: CanvasView,
  fileLayout: BandLayout,
  ranges: Uint32Array,
  values?: Float32Array,
): { viewRanges: Uint32Array; fileRanges: Uint32Array; viewValues: Float32Array | null; covered: boolean } {
  const viewRanges: number[] = [];
  const fileRanges: number[] = [];
  const pieces: Array<{ valueStart: number; count: number }> = [];
  let covered = true;
  let keptPixels = 0;
  let valueOffset = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const rangeStart = ranges[i];
    const rangeEnd = rangeStart + ranges[i + 1];
    let at = rangeStart;
    for (let band = bandAtPixel(fileLayout, rangeStart); band < fileLayout.numBands && at < rangeEnd; band++) {
      const bandStart = fileLayout.metadata[band * 4];
      const bandEnd = bandStart + fileLayout.metadata[band * 4 + 1];
      if (bandStart >= rangeEnd) break;
      const pieceEnd = Math.min(rangeEnd, bandEnd);
      if (pieceEnd <= at) continue;
      const viewFileStart = view.ranges[band * 2];
      const viewFileEnd = viewFileStart + view.ranges[band * 2 + 1];
      const keptStart = Math.max(at, viewFileStart);
      const keptEnd = Math.min(pieceEnd, viewFileEnd);
      if (keptEnd < pieceEnd || keptStart > at) covered = false;
      if (keptEnd > keptStart) {
        viewRanges.push(view.layout.metadata[band * 4] + (keptStart - viewFileStart), keptEnd - keptStart);
        fileRanges.push(keptStart, keptEnd - keptStart);
        pieces.push({ valueStart: valueOffset + (keptStart - rangeStart), count: keptEnd - keptStart });
        keptPixels += keptEnd - keptStart;
      }
      at = pieceEnd;
    }
    valueOffset += ranges[i + 1];
  }
  let viewValues: Float32Array | null = null;
  if (values) {
    viewValues = new Float32Array(keptPixels * 4);
    let out = 0;
    for (const piece of pieces) {
      viewValues.set(values.subarray(piece.valueStart * 4, (piece.valueStart + piece.count) * 4), out * 4);
      out += piece.count;
    }
  }
  return { viewRanges: Uint32Array.from(viewRanges), fileRanges: Uint32Array.from(fileRanges), viewValues, covered };
}

/**
 * (next-view texel, count, current-view texel) triples for the frame span two
 * views of one file share, one triple per band with any overlap.
 */
export function viewOverlapTriples(current: CanvasView, next: CanvasView): Uint32Array {
  const triples: number[] = [];
  for (let band = 0; band < current.layout.numBands; band++) {
    const currentStart = current.bandK0[band];
    const nextStart = next.bandK0[band];
    const from = Math.max(currentStart, nextStart);
    const to = Math.min(
      currentStart + current.layout.metadata[band * 4 + 1],
      nextStart + next.layout.metadata[band * 4 + 1],
    );
    if (to <= from) continue;
    triples.push(
      next.layout.metadata[band * 4] + (from - nextStart),
      to - from,
      current.layout.metadata[band * 4] + (from - currentStart),
    );
  }
  return Uint32Array.from(triples);
}

/**
 * `current`'s own pixel ranges for the frames `next` does not hold, one or two
 * pieces per band, ascending.
 */
export function viewRangesLeaving(current: CanvasView, next: CanvasView): Uint32Array {
  const out: number[] = [];
  for (let band = 0; band < current.layout.numBands; band++) {
    const start = current.bandK0[band];
    const length = current.layout.metadata[band * 4 + 1];
    const base = current.layout.metadata[band * 4];
    const nextStart = next.bandK0[band];
    const from = Math.max(start, nextStart);
    const to = Math.min(start + length, nextStart + next.layout.metadata[band * 4 + 1]);
    if (to <= from) {
      if (length > 0) out.push(base, length);
      continue;
    }
    if (from > start) out.push(base, from - start);
    if (to < start + length) out.push(base + (to - start), start + length - to);
  }
  return Uint32Array.from(out);
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
