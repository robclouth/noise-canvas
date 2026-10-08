import { openFiles } from "../store/files";
import { getBlockStore } from "./block-stores";

/** A point of a file: `f` its time as a fraction of the file, `p` its pitch UV (y-up, as the shaders read it). */
export interface TruthPoint {
  f: number;
  p: number;
}

/** The louder channel's magnitude at one point, as the store, the seed and the canvas hold it. */
export interface TruthReading {
  pixel: number;
  store: number;
  original: number;
  canvas: number | null;
}

function louder(values: Float32Array, index: number): number {
  return Math.max(Math.abs(values[index * 4]), Math.abs(values[index * 4 + 2]));
}

/**
 * Reads each point's coefficient from the committed store, the seeded
 * original, and the canvas with its carry, so a driver can tell a stroke that
 * never reached the store from one the display shows wrongly.
 */
export async function readTruth(fileId: string, points: TruthPoint[]): Promise<TruthReading[]> {
  const file = openFiles[fileId];
  const spec = file?.spectrogramData;
  const storePromise = getBlockStore(fileId);
  if (!spec || !storePromise) throw new Error(`no open file ${fileId}`);
  const store = await storePromise;
  const { metadata, numBands, numFrames } = spec;
  const pixels = points.map(({ f, p }) => {
    const band = Math.max(0, Math.min(numBands - 1, Math.floor((1 - p) * numBands)));
    const offset = metadata[band * 4];
    const bins = metadata[band * 4 + 1];
    const step = Math.pow(2, metadata[band * 4 + 2]);
    const bin = Math.max(0, Math.min(bins - 1, Math.floor((f * numFrames) / step)));
    return offset + bin;
  });
  const unique = [...new Set(pixels)].sort((a, b) => a - b);
  const ranges = new Uint32Array(unique.length * 2);
  unique.forEach((pixel, i) => {
    ranges[i * 2] = pixel;
    ranges[i * 2 + 1] = 1;
  });
  const [current, original, canvas] = await Promise.all([
    store.readRanges(ranges),
    store.readRootRanges(ranges),
    // The canvas serves only what its window and carry hold.
    (file.rendererRef?.current?.readPixelRanges(ranges) ?? Promise.resolve(null)).catch(() => null),
  ]);
  const at = new Map(unique.map((pixel, i) => [pixel, i]));
  return pixels.map((pixel) => {
    const i = at.get(pixel)!;
    return {
      pixel,
      store: louder(current, i),
      original: louder(original, i),
      canvas: canvas ? louder(canvas, i) : null,
    };
  });
}

/** The sum of squared samples of every channel of a file's audio over each [start, end) span in seconds. */
export function readAudioEnergy(fileId: string, spans: [number, number][]): number[] {
  const buffer = openFiles[fileId]?.audioBuffer;
  if (!buffer) throw new Error(`no audio for ${fileId}`);
  return spans.map(([start, end]) => {
    const from = Math.max(0, Math.floor(start * buffer.sampleRate));
    const to = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
    let sum = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const samples = buffer.getChannelData(ch);
      for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    }
    return sum;
  });
}
