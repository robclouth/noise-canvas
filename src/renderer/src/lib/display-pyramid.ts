import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";

/** RG16F: left and right magnitude, in dB. */
export const DISPLAY_PYRAMID_BYTES_PER_TEXEL = 4;

/** Texels every resident level together may hold — about 64 MB at RG16F. */
export const DISPLAY_PYRAMID_MAX_TEXELS = 16_000_000;

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
