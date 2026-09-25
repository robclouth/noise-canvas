import type { SpectrogramData } from "../store/types";
import { FULL_SCALE_DB_OFFSET } from "./constants";
import type { PackedSpan } from "./packed-span";
import { maskColsFor } from "./selection-mask";
import { bandIndexToPitchUv, pitchUvToBandIndex } from "./utils";
import type { Selection } from "./selection";

/** The default level window a wand click reaches down from its seed, in dB. */
export const WAND_DEFAULT_TOLERANCE_DB = 18;
export const WAND_MIN_TOLERANCE_DB = 3;
export const WAND_MAX_TOLERANCE_DB = 60;

/** Seconds of the file the wand reads at a time as its region grows. */
export const WAND_CHUNK_SECONDS = 60;

/** Reads the committed state over [startFrame, endFrame), or null when the store cannot serve it. */
export type WandReader = (startFrame: number, endFrame: number) => Promise<PackedSpan | null>;

const UNREAD = 0;
const BELOW = 1;
const ABOVE = 2;

// A runaway grow (clicking silence in a long file) stops here rather than
// walking every bin.
const MAX_GROWN_BINS = 2_000_000;

/** One byte a bin, kept only for the chunks of the file something touched. */
class ChunkBytes {
  private readonly chunks = new Map<number, Uint8Array>();

  constructor(
    private readonly numBands: number,
    private readonly bandStepLog2s: ArrayLike<number>,
    private readonly bandLengths: ArrayLike<number>,
    private readonly chunkFrames: number,
  ) {}

  /** The chunk `band`'s bin `bin` starts in. */
  chunkOf(band: number, bin: number): number {
    return Math.floor((bin << this.bandStepLog2s[band]) / this.chunkFrames);
  }

  get(band: number, bin: number): number {
    const chunk = this.chunkOf(band, bin);
    const bytes = this.chunks.get(chunk * this.numBands + band);
    return bytes ? bytes[bin - this.firstBin(band, chunk)] : 0;
  }

  set(band: number, bin: number, value: number): void {
    const chunk = this.chunkOf(band, bin);
    const key = chunk * this.numBands + band;
    let bytes = this.chunks.get(key);
    if (!bytes) {
      const next = Math.min(this.bandLengths[band], this.firstBin(band, chunk + 1));
      bytes = new Uint8Array(next - this.firstBin(band, chunk));
      this.chunks.set(key, bytes);
    }
    bytes[bin - this.firstBin(band, chunk)] = value;
  }

  private firstBin(band: number, chunk: number): number {
    return Math.ceil((chunk * this.chunkFrames) / (1 << this.bandStepLog2s[band]));
  }
}

/** The louder channel's level at `band`'s bin `bin`, or -Infinity where the span holds no such bin. */
const binDb = (span: PackedSpan, band: number, bin: number): number => {
  const pixel = span.pixel(band, bin);
  if (pixel < 0) return Number.NEGATIVE_INFINITY;
  const mag = Math.max(span.values[pixel * 4], span.values[pixel * 4 + 2]);
  return 20 * Math.log10(mag + 1e-7) + FULL_SCALE_DB_OFFSET;
};

/**
 * Grows a region outward from the clicked bin, over bins whose level reaches
 * within `toleranceDb` below the seed's, walking time neighbours in each band
 * and every bin the span overlaps in the bands above and below. Reads the file
 * through `read` a chunk of `chunkFrames` at a time, only where the region
 * reaches, so it grows over any length of file. Returns the region as a masked
 * selection, or null when the click lands outside the file or a read fails.
 */
export async function growWandSelection(
  read: WandReader,
  spec: SpectrogramData,
  timeSec: number,
  pitchUv: number,
  toleranceDb: number,
  chunkFrames = WAND_CHUNK_SECONDS * spec.sampleRate,
): Promise<Selection | null> {
  const { numBands, sampleRate, numFrames, synthesisMetadata } = spec;
  const { bandStepLog2s, bandLengths } = synthesisMetadata;

  const seedBand = Math.max(0, Math.min(numBands - 1, Math.floor(pitchUvToBandIndex(pitchUv, numBands))));
  const seedFrame = Math.max(0, Math.min(numFrames - 1, Math.floor(timeSec * sampleRate)));
  const seedBin = Math.min(bandLengths[seedBand] - 1, seedFrame >> bandStepLog2s[seedBand]);
  if (seedBin < 0) return null;

  // Each bin's level against the floor, UNREAD until its chunk is read.
  const levels = new ChunkBytes(numBands, bandStepLog2s, bandLengths, chunkFrames);
  const readChunks = new Set<number>();
  let floorDb = Number.NaN;
  const readChunk = async (chunk: number): Promise<boolean> => {
    readChunks.add(chunk);
    const span = await read(chunk * chunkFrames, Math.min(numFrames, (chunk + 1) * chunkFrames));
    if (!span) return false;
    if (Number.isNaN(floorDb)) floorDb = binDb(span, seedBand, seedBin) - toleranceDb;
    const { metadata } = span.view.layout;
    for (let band = 0; band < numBands; band++) {
      const k0 = span.view.bandK0[band];
      const count = Math.min(metadata[band * 4 + 1], bandLengths[band] - k0);
      for (let k = 0; k < count; k++) levels.set(band, k0 + k, binDb(span, band, k0 + k) < floorDb ? BELOW : ABOVE);
    }
    return true;
  };
  const chunkOf = (band: number, bin: number): number => levels.chunkOf(band, bin);

  if (!(await readChunk(chunkOf(seedBand, seedBin)))) return null;
  if (!Number.isFinite(floorDb)) return null;

  const visited = new ChunkBytes(numBands, bandStepLog2s, bandLengths, chunkFrames);
  const visit = (band: number, bin: number): boolean => {
    if (visited.get(band, bin)) return false;
    visited.set(band, bin, 1);
    return true;
  };

  // Grown bins per band, as bin indices; turned into the mask afterwards.
  const grown: number[][] = new Array(numBands);
  let stack: number[] = [seedBand, seedBin];
  // Bins reached in chunks not read yet, as [band, bin] pairs.
  let unread: number[] = [];
  visit(seedBand, seedBin);
  let count = 0;

  while (count < MAX_GROWN_BINS) {
    if (stack.length === 0) {
      if (unread.length === 0) break;
      if (!(await readChunk(chunkOf(unread[0], unread[1])))) return null;
      stack = unread;
      unread = [];
      continue;
    }
    const bin = stack[stack.length - 1];
    const band = stack[stack.length - 2];
    stack.length -= 2;
    const level = levels.get(band, bin);
    if (level === UNREAD && !readChunks.has(chunkOf(band, bin))) {
      unread.push(band, bin);
      continue;
    }
    if (level !== ABOVE) continue;
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
