import type { SpectrogramData } from "../store/types";

// The analyser's packed texture dimension limit (gaborator-addon.cpp).
// Window textures are sized by the same rule, so a window and a whole file of
// equal coefficient count get identical dimensions.
const MAX_TEXTURE_SIZE = 8192;

/**
 * The dyadic packed layout of a frame span: per band, where its bins start in
 * the packed array, how many bins it holds, and how many frames one bin covers
 * (`2^bandStepLog2`). A whole file and a window into one share this shape.
 */
export interface PackedLayout {
  /** Frames the layout spans. For a window this is its own span, not the file's. */
  numFrames: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandLengths: Uint32Array;
  bandStepLog2s: Int32Array;
  textureWidth: number;
  textureHeight: number;
}

/**
 * A `PackedLayout` holding `[startFrame, endFrame)` of `file`.
 *
 * Unpacked UV stays in file space everywhere outside the addressing helpers,
 * so a shader reading a window still forms `uv.x * fileNumFrames` and only then
 * subtracts `startFrame`.
 */
export interface WindowLayout extends PackedLayout {
  /** First file frame held. A multiple of `windowAlignment(file)`. */
  startFrame: number;
  /** One past the last file frame held. A multiple of `windowAlignment(file)`. */
  endFrame: number;
  file: PackedLayout;
  /** Per band, the file bin index the window's bin 0 corresponds to. */
  firstBins: Uint32Array;
}

/** The packed layout of an analysed file. */
export function fileLayoutOf(data: SpectrogramData): PackedLayout {
  return {
    numFrames: data.numFrames,
    numBands: data.numBands,
    bandOffsets: data.synthesisMetadata.bandOffsets,
    bandLengths: data.synthesisMetadata.bandLengths,
    bandStepLog2s: data.synthesisMetadata.bandStepLog2s,
    textureWidth: data.textureWidth,
    textureHeight: data.textureHeight,
  };
}

/**
 * Frames a window's edges must be a multiple of: the coarsest band's bin width.
 * At that alignment every band's first window bin is exactly
 * `startFrame >> bandStepLog2`, so no two bands disagree about where the window
 * begins.
 */
export function windowAlignment(file: PackedLayout): number {
  let maxStep = 0;
  for (let b = 0; b < file.numBands; b++) {
    if (file.bandStepLog2s[b] > maxStep) maxStep = file.bandStepLog2s[b];
  }
  return 2 ** maxStep;
}

/**
 * Widens `[startFrame, endFrame)` to the alignment and clamps it into the file.
 * The result always spans at least one alignment block, which is what
 * guarantees every band at least one bin.
 */
export function alignWindow(
  file: PackedLayout,
  startFrame: number,
  endFrame: number,
): { startFrame: number; endFrame: number } {
  const align = windowAlignment(file);
  const limit = Math.max(align, Math.ceil(file.numFrames / align) * align);
  const start = Math.min(Math.max(0, Math.floor(startFrame / align) * align), limit - align);
  const end = Math.min(Math.max(Math.ceil(endFrame / align) * align, start + align), limit);
  return { startFrame: start, endFrame: end };
}

/** The layout of the window covering `[startFrame, endFrame)`, after alignment. */
export function buildWindowLayout(file: PackedLayout, startFrame: number, endFrame: number): WindowLayout {
  const span = alignWindow(file, startFrame, endFrame);
  const bandOffsets = new Uint32Array(file.numBands);
  const bandLengths = new Uint32Array(file.numBands);
  const firstBins = new Uint32Array(file.numBands);

  let total = 0;
  for (let b = 0; b < file.numBands; b++) {
    const step = 2 ** file.bandStepLog2s[b];
    const fileLength = file.bandLengths[b];
    const k0 = Math.min(Math.floor(span.startFrame / step), fileLength);
    const k1 = Math.min(Math.ceil(span.endFrame / step), fileLength);
    firstBins[b] = k0;
    bandOffsets[b] = total;
    bandLengths[b] = Math.max(0, k1 - k0);
    total += bandLengths[b];
  }

  // A window that holds every bin is the file, and must keep the file's own
  // packing: the analyser's texture may be padded or shaped differently from
  // what this rule would pick, and the two must address the same texels.
  const wholeFile = total === layoutPixelCount(file) && firstBins.every((first) => first === 0);
  const textureWidth = wholeFile ? file.textureWidth : Math.min(MAX_TEXTURE_SIZE, total);
  const textureHeight = wholeFile ? file.textureHeight : total > 0 ? Math.ceil(total / textureWidth) : 0;

  return {
    numFrames: span.endFrame - span.startFrame,
    numBands: file.numBands,
    bandOffsets: wholeFile ? file.bandOffsets : bandOffsets,
    bandLengths,
    bandStepLog2s: file.bandStepLog2s,
    textureWidth,
    textureHeight,
    startFrame: span.startFrame,
    endFrame: span.endFrame,
    file,
    firstBins,
  };
}

/** True when the window holds every bin the file has. */
export function isWholeFileWindow(window: WindowLayout): boolean {
  for (let b = 0; b < window.numBands; b++) {
    if (window.firstBins[b] !== 0 || window.bandLengths[b] !== window.file.bandLengths[b]) return false;
  }
  return true;
}

/** Packed pixels a layout spans. */
export function layoutPixelCount(layout: PackedLayout): number {
  let total = 0;
  for (let b = 0; b < layout.numBands; b++) total += layout.bandLengths[b];
  return total;
}

/**
 * The window's metadata texture, `numBands` wide and 2 rows tall.
 *
 * Row 0 is what a whole-file metadata texture holds today
 * (bandOffset, bandLength, stepLog2, centreFreqHz); row 1 carries the window's
 * origin and the file's own band geometry (startFrame, fileBandLength,
 * fileBandOffset, unused). The origin travels with the texture because a source,
 * Attract field or Convolve IR texture belongs to another file's window, whose
 * origin no global uniform can name.
 */
export function buildWindowMetadata(window: WindowLayout, fileMetadata: Float32Array): Float32Array {
  const bands = window.numBands;
  const out = new Float32Array(bands * 2 * 4);
  for (let b = 0; b < bands; b++) {
    out[b * 4 + 0] = window.bandOffsets[b];
    out[b * 4 + 1] = window.bandLengths[b];
    out[b * 4 + 2] = window.bandStepLog2s[b];
    out[b * 4 + 3] = fileMetadata[b * 4 + 3];

    const row1 = (bands + b) * 4;
    out[row1 + 0] = window.startFrame;
    out[row1 + 1] = window.file.bandLengths[b];
    out[row1 + 2] = window.file.bandOffsets[b];
    out[row1 + 3] = 0;
  }
  return out;
}

/**
 * The window's inverse map (frame, band) per packed pixel.
 *
 * Frames stay in **file** space: Sort reads the map's frame raw and divides by
 * the file's frame count, so window-relative frames would push its
 * brush-membership guard permanently false.
 */
export function buildWindowInverseMap(window: WindowLayout): Float32Array {
  const out = new Float32Array(window.textureWidth * window.textureHeight * 2);
  for (let b = 0; b < window.numBands; b++) {
    const step = 2 ** window.bandStepLog2s[b];
    const offset = window.bandOffsets[b];
    const first = window.firstBins[b];
    for (let i = 0; i < window.bandLengths[b]; i++) {
      out[(offset + i) * 2 + 0] = (first + i) * step;
      out[(offset + i) * 2 + 1] = b;
    }
  }
  return out;
}

/** Flat [start, count, ...] file packed ranges the window holds, band by band. */
export function windowFileRanges(window: WindowLayout): Uint32Array {
  const ranges: number[] = [];
  for (let b = 0; b < window.numBands; b++) {
    const length = window.bandLengths[b];
    if (length === 0) continue;
    ranges.push(window.file.bandOffsets[b] + window.firstBins[b], length);
  }
  return Uint32Array.from(ranges);
}

/** The band a file packed pixel belongs to, or -1 when it is padding. */
export function bandOfFilePixel(file: PackedLayout, pixel: number): number {
  let lo = 0;
  let hi = file.numBands - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = file.bandOffsets[mid];
    if (pixel < start) hi = mid - 1;
    else if (pixel >= start + file.bandLengths[mid]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** File ranges split by whether the window holds them. */
export interface MappedRanges {
  /** Flat [fileStart, windowStart, count, ...] for the parts the window holds. */
  mapped: Uint32Array;
  /** Flat [fileStart, count, ...] for the parts it does not. */
  outside: Uint32Array;
  /**
   * Per mapped piece, where it starts in the block a read of the whole range
   * list returns — the pixels of `ranges` that precede it, misses included, so
   * a caller can key the result to the file ranges it asked for.
   */
  blockOffsets: Uint32Array;
  /** Pixels of `ranges` the window does not hold. */
  missingPixels: number;
}

/**
 * Splits file packed ranges into the parts the window holds — paired with where
 * they sit in it — and the parts it misses. A miss is the caller's to handle;
 * clamping it into the window would substitute edge data silently.
 */
export function mapFileRangesToWindow(window: WindowLayout, ranges: Uint32Array): MappedRanges {
  const mapped: number[] = [];
  const outside: number[] = [];
  const blockOffsets: number[] = [];
  const file = window.file;
  let missingPixels = 0;
  let blockBase = 0;

  for (let i = 0; i < ranges.length; i += 2) {
    const rangeStart = ranges[i];
    let start = rangeStart;
    const end = start + ranges[i + 1];
    while (start < end) {
      const band = bandOfFilePixel(file, start);
      if (band < 0) {
        outside.push(start, end - start);
        missingPixels += end - start;
        break;
      }
      const bandStart = file.bandOffsets[band];
      const bandEnd = bandStart + file.bandLengths[band];
      const chunkEnd = Math.min(end, bandEnd);

      const heldStart = bandStart + window.firstBins[band];
      const heldEnd = heldStart + window.bandLengths[band];

      const beforeEnd = Math.min(chunkEnd, heldStart);
      if (beforeEnd > start) {
        outside.push(start, beforeEnd - start);
        missingPixels += beforeEnd - start;
      }

      const inStart = Math.max(start, heldStart);
      const inEnd = Math.min(chunkEnd, heldEnd);
      if (inEnd > inStart) {
        mapped.push(inStart, window.bandOffsets[band] + (inStart - heldStart), inEnd - inStart);
        blockOffsets.push(blockBase + (inStart - rangeStart));
      }

      const afterStart = Math.max(start, heldEnd);
      if (chunkEnd > afterStart) {
        outside.push(afterStart, chunkEnd - afterStart);
        missingPixels += chunkEnd - afterStart;
      }

      start = chunkEnd;
    }
    blockBase += ranges[i + 1];
  }

  return {
    mapped: Uint32Array.from(mapped),
    outside: Uint32Array.from(outside),
    blockOffsets: Uint32Array.from(blockOffsets),
    missingPixels,
  };
}

/**
 * The file frame span file packed ranges reach, by the same edge arithmetic the
 * patch extent uses: bin `k` of a band covers frames `[k·2^s, (k+1)·2^s)`.
 * Empty ranges give an empty span.
 */
export function frameSpanOfRanges(file: PackedLayout, ranges: Uint32Array): { startFrame: number; endFrame: number } {
  let startFrame = Infinity;
  let endFrame = -Infinity;

  for (let i = 0; i < ranges.length; i += 2) {
    let start = ranges[i];
    const end = start + ranges[i + 1];
    while (start < end) {
      const band = bandOfFilePixel(file, start);
      if (band < 0) break;
      const bandEnd = file.bandOffsets[band] + file.bandLengths[band];
      const chunkEnd = Math.min(end, bandEnd);
      const step = 2 ** file.bandStepLog2s[band];
      const k0 = start - file.bandOffsets[band];
      const k1 = chunkEnd - file.bandOffsets[band];
      startFrame = Math.min(startFrame, k0 * step);
      endFrame = Math.max(endFrame, k1 * step);
      start = chunkEnd;
    }
  }

  if (startFrame === Infinity) return { startFrame: 0, endFrame: 0 };
  return { startFrame, endFrame: Math.min(endFrame, file.numFrames) };
}

/**
 * Metadata presenting `window` as the resident part of a **whole-file** packed
 * texture. Row 0's offsets address the file's own texels, so a read inside the
 * window lands exactly where it would with whole-file metadata, while a read
 * outside it reports a miss instead of returning the data that is still there.
 */
export function buildInPlaceWindowMetadata(window: WindowLayout, fileMetadata: Float32Array): Float32Array {
  const out = buildWindowMetadata(window, fileMetadata);
  for (let b = 0; b < window.numBands; b++) {
    out[b * 4 + 0] = window.file.bandOffsets[b] + window.firstBins[b];
  }
  return out;
}
