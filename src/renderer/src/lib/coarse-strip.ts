import { bandAtPixel, type BandLayout } from "./band-layout";
import { displayPyramidLevels, type DisplayPyramidLevel } from "./display-pyramid";

/**
 * The whole file's picture at one display pyramid level: left and right
 * magnitude per bin, laid out as that level lays its bins out.
 */
export type CoarseStrip = { level: DisplayPyramidLevel; values: Float32Array };

/** Bins a strip holds at most, so it stays a few megabytes whatever the file's length. */
export const COARSE_STRIP_MAX_BINS = 1 << 21;

/** Bins the level lays out over every band. */
export function levelBins(level: DisplayPyramidLevel): number {
  let bins = 0;
  for (let i = 1; i < level.metadata.length; i += 4) bins += level.metadata[i];
  return bins;
}

/** The finest pyramid level of `layout` whose bins fit `maxBins`. */
export function coarseStripLevel(layout: BandLayout, maxBins = COARSE_STRIP_MAX_BINS): DisplayPyramidLevel {
  const levels = displayPyramidLevels(layout);
  for (const level of levels) if (levelBins(level) <= maxBins) return level;
  return levels[levels.length - 1];
}

/**
 * Builds a strip from blocks of packed pixels as they land. A level bin holds
 * the source bin at its stride, the tap the pyramid's own decimation takes,
 * so a strip seeded into the pyramid matches what the finest level would
 * decimate to.
 */
export class CoarseStripBuilder {
  private readonly values: Float32Array;

  constructor(
    private readonly layout: BandLayout,
    readonly level: DisplayPyramidLevel,
  ) {
    this.values = new Float32Array(levelBins(level) * 2);
  }

  /**
   * Takes the taps that fall in `ranges` out of `block`, which holds exactly
   * the pixels of `ranges` in range order. Each range lies inside one band.
   */
  add(ranges: Uint32Array, block: Float32Array): void {
    const { metadata } = this.layout;
    let at = 0;
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      const start = ranges[i];
      const count = ranges[i + 1];
      const band = bandAtPixel(this.layout, start);
      const firstBin = start - metadata[band * 4];
      const decimation = 2 ** (this.level.metadata[band * 4 + 2] - metadata[band * 4 + 2]);
      const levelOffset = this.level.metadata[band * 4];
      const levelBinCount = this.level.metadata[band * 4 + 1];
      for (let j = Math.ceil(firstBin / decimation); j < levelBinCount; j++) {
        const tap = j * decimation;
        if (tap >= firstBin + count) break;
        const source = (at + tap - firstBin) * 4;
        this.values[(levelOffset + j) * 2] = block[source];
        this.values[(levelOffset + j) * 2 + 1] = block[source + 2];
      }
      at += count;
    }
  }

  strip(): CoarseStrip {
    return { level: this.level, values: this.values };
  }
}
