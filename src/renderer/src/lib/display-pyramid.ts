import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";

/** RG16F: left and right magnitude, in dB. */
export const DISPLAY_PYRAMID_BYTES_PER_TEXEL = 4;

/** Texels every resident level together may hold — 20 MB at RG16F, per open file. */
export const DISPLAY_PYRAMID_MAX_TEXELS = 5_000_000;

// A level's bins halve for every band the step has reached, and a band's own
// step doubles each octave down, which sums to three times the packed count
// over the whole stack; the fourth covers each level's row padding and the tail
// of levels holding one bin per band. Bounds the budget charge without building
// the levels.
const DISPLAY_PYRAMID_TEXEL_RATIO = 4;

/** Texels a file's level stack can reach, for the memory budget. */
export function displayPyramidBudgetTexels(packedTexels: number, maxTexels = DISPLAY_PYRAMID_MAX_TEXELS): number {
  return Math.min(maxTexels, DISPLAY_PYRAMID_TEXEL_RATIO * packedTexels);
}

/** A packed spectrogram's per-band layout, as `SpectrogramData.metadata` holds it. */
export type BandLayout = {
  numBands: number;
  /** RGBA per band: packed offset, bin count, time step log2, centre frequency. */
  metadata: Float32Array;
};

/**
 * One level of the display pyramid: the same bands in the same packed order,
 * each at a time step of at least 2^stepLog2 frames. A band whose own step is
 * already that coarse is carried unchanged, so level 0 is the source layout.
 */
export type DisplayPyramidLevel = {
  stepLog2: number;
  metadata: Float32Array;
  textureWidth: number;
  textureHeight: number;
  texelCount: number;
};

/** Which two levels a view blends, by index into the level list, and the coarser one's weight. */
export type DisplayLevelChoice = { fine: number; coarse: number; blend: number };

/** Bins band `band` keeps when the level's time step is 2^stepLog2 frames. */
export function levelBinCount(metadata: Float32Array, band: number, stepLog2: number): number {
  const length = metadata[band * 4 + 1];
  const sourceStep = metadata[band * 4 + 2];
  return Math.ceil(length / 2 ** Math.max(0, stepLog2 - sourceStep));
}

/** The level of `layout` at a time step of 2^stepLog2 frames. */
export function displayPyramidLevel(layout: BandLayout, stepLog2: number): DisplayPyramidLevel {
  const metadata = new Float32Array(layout.numBands * 4);
  let offset = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const bins = levelBinCount(layout.metadata, band, stepLog2);
    metadata[band * 4] = offset;
    metadata[band * 4 + 1] = bins;
    metadata[band * 4 + 2] = Math.max(layout.metadata[band * 4 + 2], stepLog2);
    metadata[band * 4 + 3] = layout.metadata[band * 4 + 3];
    offset += bins;
  }
  const textureWidth = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, Math.max(1, offset));
  const textureHeight = Math.max(1, Math.ceil(offset / textureWidth));
  return { stepLog2, metadata, textureWidth, textureHeight, texelCount: textureWidth * textureHeight };
}

/** The first step at which every band is down to a single bin. */
function coarsestStepLog2(layout: BandLayout): number {
  let coarsest = 0;
  for (let band = 0; band < layout.numBands; band++) {
    let step = layout.metadata[band * 4 + 2];
    while (levelBinCount(layout.metadata, band, step) > 1) step++;
    coarsest = Math.max(coarsest, step);
  }
  return coarsest;
}

/**
 * The levels to keep resident, finest first, ending at one bin per band. The
 * finest levels are dropped until the stack fits `maxTexels`, so a longer file
 * starts coarser rather than costing more.
 */
export function displayPyramidLevels(
  layout: BandLayout,
  maxTexels = DISPLAY_PYRAMID_MAX_TEXELS,
): DisplayPyramidLevel[] {
  const coarsest = coarsestStepLog2(layout);
  const levels: DisplayPyramidLevel[] = [];
  for (let step = 0; step <= coarsest; step++) levels.push(displayPyramidLevel(layout, step));

  let first = 0;
  let total = levels.reduce((sum, level) => sum + level.texelCount, 0);
  while (first < levels.length - 1 && total > maxTexels) {
    total -= levels[first].texelCount;
    first++;
  }
  return levels.slice(first);
}

/**
 * The levels to sample for a view showing `framesPerPixel` input frames in
 * each screen pixel. Blending the pair keeps a zoom from stepping visibly as
 * the choice crosses a level.
 */
export function displayLevelChoice(levels: DisplayPyramidLevel[], framesPerPixel: number): DisplayLevelChoice {
  const wanted = Math.log2(Math.max(framesPerPixel, 1)) - levels[0].stepLog2;
  const fine = Math.min(Math.max(Math.floor(wanted), 0), levels.length - 1);
  const coarse = Math.min(fine + 1, levels.length - 1);
  const blend = coarse === fine ? 0 : Math.min(Math.max(wanted - fine, 0), 1);
  return { fine, coarse, blend };
}

/** GPU bytes a level stack holds. */
export function displayPyramidBytes(levels: DisplayPyramidLevel[]): number {
  let texels = 0;
  for (const level of levels) texels += level.texelCount;
  return texels * DISPLAY_PYRAMID_BYTES_PER_TEXEL;
}

// Past 2^24 texels the float32 band offsets in metadata lose whole units, so a
// mapped range is widened rather than trusted to the bin.
const PATCH_MARGIN_BINS = 4;

/** The band holding packed pixel `pixel`, or the first band past it. */
function bandAtPixel(layout: BandLayout, pixel: number): number {
  let low = 0;
  let high = layout.numBands - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (layout.metadata[mid * 4] <= pixel) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The bins of each band that `pixelRanges` covers, as [start, end) pairs
 * widened by the margin the float32 band offsets need. Bands the ranges miss
 * get an empty pair. Holes inside a band are filled in, so a band's pair is
 * one span.
 */
export function sourceBinRanges(layout: BandLayout, pixelRanges: Uint32Array): Uint32Array {
  const spans = new Uint32Array(layout.numBands * 2);
  const touched = new Uint8Array(layout.numBands);
  for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
    const start = pixelRanges[i];
    const end = start + pixelRanges[i + 1];
    if (end <= start) continue;
    for (let band = bandAtPixel(layout, start); band < layout.numBands; band++) {
      const offset = layout.metadata[band * 4];
      const length = layout.metadata[band * 4 + 1];
      if (offset >= end) break;
      const low = Math.max(start, offset);
      const high = Math.min(end, offset + length);
      if (high <= low) continue;
      const binStart = Math.max(0, low - offset - PATCH_MARGIN_BINS);
      const binEnd = Math.min(length, high - offset + PATCH_MARGIN_BINS);
      if (touched[band]) {
        spans[band * 2] = Math.min(spans[band * 2], binStart);
        spans[band * 2 + 1] = Math.max(spans[band * 2 + 1], binEnd);
      } else {
        spans[band * 2] = binStart;
        spans[band * 2 + 1] = binEnd;
        touched[band] = 1;
      }
    }
  }
  return spans;
}

/** How many of a band's source bins one bin of `level` steps over. */
export function levelDecimation(level: DisplayPyramidLevel, sourceStepLog2: number, band: number): number {
  return 2 ** (level.metadata[band * 4 + 2] - sourceStepLog2);
}

/** The bins of `level` that a band's source bin span [start, end) reaches. */
export function levelBinSpan(
  level: DisplayPyramidLevel,
  band: number,
  sourceStepLog2: number,
  start: number,
  end: number,
): { start: number; end: number } {
  const decimation = levelDecimation(level, sourceStepLog2, band);
  const bins = level.metadata[band * 4 + 1];
  return {
    start: Math.min(bins, Math.ceil(start / decimation)),
    end: Math.min(bins, Math.ceil(end / decimation)),
  };
}
