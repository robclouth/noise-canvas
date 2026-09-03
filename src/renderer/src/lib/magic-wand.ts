import type { SpectrogramData } from "../store/types";
import { FULL_SCALE_DB_OFFSET } from "./constants";
import { maskColsFor } from "./selection-mask";
import { bandIndexToPitchUv, pitchUvToBandIndex } from "./utils";
import type { Selection } from "./selection";

/** The default level window a wand click reaches down from its seed, in dB. */
export const WAND_DEFAULT_TOLERANCE_DB = 18;
export const WAND_MIN_TOLERANCE_DB = 3;
export const WAND_MAX_TOLERANCE_DB = 60;

// A runaway grow (clicking silence in a long file) stops here rather than
// walking every bin.
const MAX_GROWN_BINS = 2_000_000;

const binDb = (packed: Float32Array, pixel: number): number => {
  const mag = Math.max(packed[pixel * 4], packed[pixel * 4 + 2]);
  return 20 * Math.log10(mag + 1e-7) + FULL_SCALE_DB_OFFSET;
};

/**
 * Grows a region outward from the clicked bin, over bins whose level reaches
 * within `toleranceDb` below the seed's, walking time neighbours in each band
 * and every bin the span overlaps in the bands above and below. Returns the
 * region as a masked selection, or null when the click lands outside the file.
 */
export function growWandSelection(
  packed: Float32Array,
  spec: SpectrogramData,
  timeSec: number,
  pitchUv: number,
  toleranceDb: number,
): Selection | null {
  const { numBands, sampleRate, numFrames, synthesisMetadata } = spec;
  const { bandOffsets, bandStepLog2s, bandLengths } = synthesisMetadata;

  const seedBand = Math.max(0, Math.min(numBands - 1, Math.floor(pitchUvToBandIndex(pitchUv, numBands))));
  const seedFrame = Math.max(0, Math.min(numFrames - 1, Math.floor(timeSec * sampleRate)));
  const seedBin = Math.min(bandLengths[seedBand] - 1, seedFrame >> bandStepLog2s[seedBand]);
  if (seedBin < 0) return null;

  const floorDb = binDb(packed, bandOffsets[seedBand] + seedBin) - toleranceDb;

  const visited: (Uint8Array | null)[] = new Array(numBands).fill(null);
  const visit = (band: number, bin: number): boolean => {
    const seen = (visited[band] ??= new Uint8Array(bandLengths[band]));
    if (seen[bin]) return false;
    seen[bin] = 1;
    return true;
  };

  // Grown bins per band, as bin indices; turned into the mask afterwards.
  const grown: number[][] = new Array(numBands);
  const stack: number[] = [seedBand, seedBin];
  visit(seedBand, seedBin);
  let count = 0;

  while (stack.length > 0 && count < MAX_GROWN_BINS) {
    const bin = stack[stack.length - 1];
    const band = stack[stack.length - 2];
    stack.length -= 2;
    if (binDb(packed, bandOffsets[band] + bin) < floorDb) continue;
    (grown[band] ??= []).push(bin);
    count++;

    if (bin > 0 && visit(band, bin - 1)) stack.push(band, bin - 1);
    if (bin + 1 < bandLengths[band] && visit(band, bin + 1)) stack.push(band, bin + 1);
    // A neighbouring band's bins are neighbours when their frame spans overlap.
    const spanFrom = bin << bandStepLog2s[band];
    const spanTo = ((bin + 1) << bandStepLog2s[band]) - 1;
    for (const other of [band - 1, band + 1]) {
      if (other < 0 || other >= numBands) continue;
      const from = spanFrom >> bandStepLog2s[other];
      const to = Math.min(bandLengths[other] - 1, spanTo >> bandStepLog2s[other]);
      for (let j = from; j <= to; j++) if (visit(other, j)) stack.push(other, j);
    }
  }
  if (count === 0) return null;

  let lowBand = numBands;
  let highBand = -1;
  let minFrame = Number.POSITIVE_INFINITY;
  let maxFrame = 0;
  for (let band = 0; band < numBands; band++) {
    const bins = grown[band];
    if (!bins?.length) continue;
    lowBand = Math.min(lowBand, band);
    highBand = Math.max(highBand, band);
    for (const bin of bins) {
      minFrame = Math.min(minFrame, bin << bandStepLog2s[band]);
      maxFrame = Math.max(maxFrame, (bin + 1) << bandStepLog2s[band]);
    }
  }
  maxFrame = Math.min(maxFrame, numFrames);
  if (highBand < lowBand || maxFrame <= minFrame) return null;

  const rows = highBand - lowBand + 1;
  const cols = maskColsFor(spec, minFrame, maxFrame, lowBand, highBand);
  const cells = new Uint8Array(rows * cols);
  const framesPerCol = (maxFrame - minFrame) / cols;
  for (let band = lowBand; band <= highBand; band++) {
    const bins = grown[band];
    if (!bins?.length) continue;
    const row = band - lowBand;
    for (const bin of bins) {
      const from = Math.max(0, Math.floor(((bin << bandStepLog2s[band]) - minFrame) / framesPerCol));
      const to = Math.min(cols - 1, Math.ceil((((bin + 1) << bandStepLog2s[band]) - minFrame) / framesPerCol) - 1);
      for (let col = from; col <= to; col++) cells[row * cols + col] = 255;
    }
  }

  return {
    start: minFrame / sampleRate,
    end: maxFrame / sampleRate,
    pitchLo: bandIndexToPitchUv(highBand + 1, numBands),
    pitchHi: bandIndexToPitchUv(lowBand, numBands),
    mask: { cols, rows, cells },
  };
}
