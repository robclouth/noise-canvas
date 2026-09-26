import { existsSync } from "fs";
import { copyFile } from "fs/promises";
import { availableParallelism, totalmem } from "os";
import { extname, join } from "path";
import { promisify } from "util";
import { constants as zlibConstants, zstdCompress, zstdDecompress } from "zlib";
import { decodeAudioFile, encodeBufferToAudioFile, probeAudioFile } from "./ffmpeg";
import { parseHistoryDeltaTurns } from "./history-delta";
import type {
  AnalysisParams,
  CommitStroke,
  CommitStrokeResult,
  CommitWindow,
  GaboratorAnalysisResult,
  OnsetReference,
  OnsetResult,
  PackedLayout,
  PackedOnsets,
  PhaseTurns,
  SplicePiece,
} from "./types";
import { getModelPath } from "./ai-separation";
import { loadNativeAddon } from "./native-addon";
import {
  finishOnsets,
  ONSET_CHUNK_SECONDS,
  onsetCurvesOfSpan,
  onsetPassesInFlight,
  scanOnsetChunk,
  scanOnsets,
  type OnsetCurvesSlice,
  type OnsetDetection,
  type OnsetPasses,
  type PackedView,
} from "./onset-scan";
export { isModelDownloaded, downloadModel } from "./ai-separation";
export type { FourStemName, TwoStemName } from "./ai-separation";

// Only 4-stem is available as a public ONNX — no clean 2-stem ONNX exists yet.
// Stem order matches htdemucs output: drums(0), bass(1), other(2), vocals(3)
const AI_MODEL = {
  file: "htdemucs.onnx",
  stems: ["drums", "bass", "other", "vocals"],
} as const;

let gaborator: any = null;

import { allowedExtensions } from "./audio-extensions";

export { allowedExtensions };

export function getGaboratorPath(): string {
  // Check if we're running from an asar archive (packaged app)
  const isPackaged = __dirname.includes("app.asar");

  if (isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node");
  }
  // The Ableton extension ships the addon beside its bundled host entry, which
  // is the only copy a packaged .ablx has.
  const beside = join(__dirname, "gaborator_addon.node");
  if (existsSync(beside)) return beside;
  // In development, __dirname will be something like .../out/preload or .../out/main
  // We need to go up to the project root and then to build/Release. Tests run
  // this file from its source directory instead, which is one level deeper.
  const bundled = join(__dirname, "../../build/Release/gaborator_addon.node");
  if (existsSync(bundled)) return bundled;
  return join(__dirname, "../../../build/Release/gaborator_addon.node");
}

export function init() {
  if (!gaborator) {
    const path = getGaboratorPath();
    console.log("Loading gaborator from:", path);
    console.log("__dirname is:", __dirname);
    gaborator = loadNativeAddon(path);
    console.log("Gaborator loaded successfully");
  }
  return gaborator;
}

/** Why the native addon cannot load, or null once it has. */
export function nativeAddonLoadError(): string | null {
  try {
    init();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Budget for a GPU no query covers: enough for a few minutes of audio, never
// a multi-gigabyte figure taken from system RAM.
const UNKNOWN_GPU_BYTES = 2 * 1024 ** 3;

/**
 * GPU memory available to textures, in bytes, from the native query. `unified`
 * is true when the GPU shares system RAM, so CPU-side copies of the spectrogram
 * compete with the textures for the same pool. `name` is empty when unknown.
 */
export function getGpuMemoryInfo(): { bytes: number; unified: boolean; name: string } {
  const queried: { bytes: number; unified: boolean; name: string } = init().getGpuMemoryInfo();
  if (queried.bytes > 0) return queried;
  return { bytes: Math.min(totalmem(), UNKNOWN_GPU_BYTES), unified: true, name: "" };
}

/**
 * Undo-history codec.
 *
 * The history cache stores packed FBO states, hundreds of megabytes each on a
 * multi-minute file. Every pass over them runs in the addon on a worker thread —
 * the same loops in the renderer would stall painting for hundreds of
 * milliseconds per stroke — and the compression around them is Node's zstd,
 * which is likewise off-thread. Nothing here touches the JS thread with more
 * than a buffer handoff.
 */
interface HistoryCodecAddon {
  historyEncodePlanes(src: Float32Array | Uint32Array): Promise<Buffer>;
  historyDecodePlanes(bytes: Uint8Array): Promise<Float32Array>;
  historyFootprintChanged(
    base: Float32Array,
    after: Float32Array,
    ranges: Uint32Array,
    baseCompact: boolean,
    afterCompact: boolean,
  ): Promise<boolean>;
  historyEncodeDelta(
    base: Float32Array,
    after: Float32Array,
    ranges: Uint32Array,
    baseCompact: boolean,
    afterCompact: boolean,
    turns: PhaseTurns | undefined,
  ): Promise<Buffer>;
  historyEncodeDeltaOver(
    base: Float32Array,
    baseRanges: Uint32Array,
    after: Float32Array,
    ranges: Uint32Array,
  ): Promise<{ bytes: Buffer; changed: boolean }>;
  historyApplyDelta(base: Float32Array, delta: Uint8Array): Promise<Float32Array>;
  copyPixelRanges(
    dest: Float32Array,
    destRanges: Uint32Array,
    src: Float32Array,
    srcRanges: Uint32Array,
  ): Promise<void>;
  historyApplyDeltas(
    base: Float32Array,
    out: Float32Array,
    deltas: Uint8Array[],
    inverts: boolean[],
  ): Promise<Float32Array>;
  historyApplyDeltasWindowed(
    values: Float32Array,
    table: Uint32Array,
    deltas: Uint8Array[],
    inverts: boolean[],
    totalPixels: number,
  ): Promise<Float32Array>;
  historyInverseMap(
    bandOffsets: Uint32Array,
    bandLengths: Uint32Array,
    bandStepLog2s: Int32Array,
    pixelCount: number,
  ): Promise<Float32Array>;
}

function historyCodec(): HistoryCodecAddon {
  return init() as HistoryCodecAddon;
}

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

// zstd hands its output over one chunk at a time, each through the JS thread;
// a chunk sized to the whole result keeps a block to one trip.
const ZSTD_CHUNK_SLACK = 64 * 1024;
const ZSTD_CHUNK_MAX = 64 * 1024 * 1024;

function zstdChunkSize(expectedBytes: number): number {
  return Math.min(ZSTD_CHUNK_MAX, Math.max(ZSTD_CHUNK_SLACK, expectedBytes + ZSTD_CHUNK_SLACK));
}

// A snapshot larger than this is cut into slices that reorder and compress on
// threads of their own; the codec is single-threaded, so this is what makes a
// whole-state write use more than one core. Slices are whole RGBA pixels.
const SNAPSHOT_SLICE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_SLICES = 16;
// "NCP1", which no zstd frame can begin with, so a snapshot written before
// slicing still reads as one zstd stream.
const SLICED_MAGIC = 0x4e435031;
const SLICED_HEADER_BYTES = 16;

function sliceValues(values: number): number {
  const wanted = Math.ceil((values * 4) / SNAPSHOT_SLICE_BYTES);
  const slices = Math.min(SNAPSHOT_MAX_SLICES, Math.max(1, wanted));
  if (slices === 1) return values;
  return Math.ceil(values / slices / 4) * 4;
}

/** Reorder a packed state for compression, then compress it. */
export async function encodeHistorySnapshot(packed: Float32Array): Promise<Buffer> {
  const per = sliceValues(packed.length);
  if (per >= packed.length) {
    const planes = await historyCodec().historyEncodePlanes(packed);
    return await zstdCompressAsync(planes, { chunkSize: zstdChunkSize(planes.byteLength) });
  }

  const parts = await Promise.all(
    Array.from({ length: Math.ceil(packed.length / per) }, async (_unused, index) => {
      const planes = await historyCodec().historyEncodePlanes(
        packed.subarray(index * per, Math.min(packed.length, (index + 1) * per)),
      );
      return await zstdCompressAsync(planes, { chunkSize: zstdChunkSize(planes.byteLength) });
    }),
  );

  const header = Buffer.alloc(SLICED_HEADER_BYTES + parts.length * 4);
  header.writeUInt32BE(SLICED_MAGIC, 0);
  header.writeUInt32LE(parts.length, 4);
  header.writeUInt32LE(per, 8);
  header.writeUInt32LE(packed.length, 12);
  parts.forEach((part, index) => header.writeUInt32LE(part.byteLength, SLICED_HEADER_BYTES + index * 4));
  return Buffer.concat([header, ...parts]);
}

/** Decompress a snapshot and restore its packed order. `decodedBytes`, when known, is its size. */
export async function decodeHistorySnapshot(bytes: Uint8Array, decodedBytes?: number): Promise<Float32Array> {
  const head = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, SLICED_HEADER_BYTES));
  if (bytes.byteLength < SLICED_HEADER_BYTES || head.getUint32(0, false) !== SLICED_MAGIC) {
    const options = decodedBytes === undefined ? {} : { chunkSize: zstdChunkSize(decodedBytes) };
    return await historyCodec().historyDecodePlanes(await zstdDecompressAsync(bytes, options));
  }

  const count = head.getUint32(4, true);
  const per = head.getUint32(8, true);
  const values = head.getUint32(12, true);
  const lengths = new DataView(bytes.buffer, bytes.byteOffset + SLICED_HEADER_BYTES, count * 4);
  let offset = SLICED_HEADER_BYTES + count * 4;
  const spans: Array<{ start: number; bytes: Uint8Array }> = [];
  for (let index = 0; index < count; index++) {
    const length = lengths.getUint32(index * 4, true);
    spans.push({ start: index * per, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }

  const out = new Float32Array(values);
  await Promise.all(
    spans.map(async (span) => {
      const size = Math.min(per, values - span.start) * 4;
      const part = await historyCodec().historyDecodePlanes(
        await zstdDecompressAsync(span.bytes, { chunkSize: zstdChunkSize(size) }),
      );
      out.set(part, span.start);
    }),
  );
  return out;
}

/**
 * True if a stroke changed anything inside the footprint it claims to cover.
 * Either state is whole, or, with its compact flag, just the footprint's
 * values laid end to end in range order.
 */
export async function historyFootprintChanged(
  base: Float32Array,
  after: Float32Array,
  ranges: Uint32Array,
  baseCompact = false,
  afterCompact = false,
): Promise<boolean> {
  return await historyCodec().historyFootprintChanged(base, after, ranges, baseCompact, afterCompact);
}

/**
 * Encode a stroke as the difference from the state it was painted onto; each
 * state is whole or compact as for historyFootprintChanged. `turns` carries
 * the phase shifts the stroke made past its ranges.
 */
export async function encodeHistoryDelta(
  base: Float32Array,
  after: Float32Array,
  ranges: Uint32Array,
  baseCompact = false,
  afterCompact = false,
  turns?: PhaseTurns,
): Promise<Buffer> {
  return await compressDelta(
    await historyCodec().historyEncodeDelta(base, after, ranges, baseCompact, afterCompact, turns),
  );
}

/**
 * Copies the pixels two compact range lists share from `src` into `dest`, on
 * a thread of the pool, as `copyCompactOverlap` does. Neither array may
 * change until it resolves.
 */
export async function copyPixelRanges(
  dest: Float32Array,
  destRanges: Uint32Array,
  src: Float32Array,
  srcRanges: Uint32Array,
): Promise<void> {
  await historyCodec().copyPixelRanges(dest, destRanges, src, srcRanges);
}

/**
 * A stroke's delta cut from a base laid out over `baseRanges`, which hold the
 * footprint, and the painted values over `ranges`. The base is read before
 * this returns, so the caller may then write over it; the bytes compress
 * after.
 */
export async function prepareHistoryDelta(
  base: Float32Array,
  baseRanges: Uint32Array,
  after: Float32Array,
  ranges: Uint32Array,
): Promise<{ changed: boolean; bytes: Promise<Buffer> }> {
  const { bytes, changed } = await historyCodec().historyEncodeDeltaOver(base, baseRanges, after, ranges);
  const compressed = compressDelta(bytes);
  void compressed.catch(() => {});
  return { changed, bytes: compressed };
}

// Bytes past which a delta compresses as frames side by side, one a core,
// at zstd's fastest level. The frames sit behind a header of their own,
// "NCD1", which no zstd frame can begin with, so a delta written as one
// stream still reads as one.
const DELTA_FRAME_BYTES = 8 * 1024 * 1024;
const DELTA_MAX_FRAMES = Math.min(16, availableParallelism());
const DELTA_FRAME_LEVEL = 1;
const DELTA_FRAMED_MAGIC = 0x4e434431;

/** A delta's bytes compressed: one zstd stream, or frames behind a header when it is large. */
async function compressDelta(input: Buffer): Promise<Buffer> {
  const count = Math.min(DELTA_MAX_FRAMES, Math.floor(input.byteLength / DELTA_FRAME_BYTES));
  if (count <= 1) return await zstdCompressAsync(input);
  const per = Math.ceil(input.byteLength / count);
  const raws = Array.from({ length: count }, (_unused, index) =>
    input.subarray(index * per, Math.min(input.byteLength, (index + 1) * per)),
  );
  const frames = await Promise.all(
    raws.map((raw) =>
      zstdCompressAsync(raw, {
        chunkSize: zstdChunkSize(raw.byteLength),
        params: { [zlibConstants.ZSTD_c_compressionLevel]: DELTA_FRAME_LEVEL },
      }),
    ),
  );
  const header = Buffer.alloc(8 + count * 8);
  header.writeUInt32BE(DELTA_FRAMED_MAGIC, 0);
  header.writeUInt32LE(count, 4);
  frames.forEach((frame, index) => {
    header.writeUInt32LE(frame.byteLength, 8 + index * 8);
    header.writeUInt32LE(raws[index].byteLength, 12 + index * 8);
  });
  return Buffer.concat([header, ...frames]);
}

/** A delta's bytes as `compressDelta` wrote them, or as one zstd stream. */
async function decompressDelta(bytes: Uint8Array): Promise<Buffer> {
  const head = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (bytes.byteLength < 8 || head.getUint32(0, false) !== DELTA_FRAMED_MAGIC) return await zstdDecompressAsync(bytes);
  const count = head.getUint32(4, true);
  const table = new DataView(bytes.buffer, bytes.byteOffset + 8, count * 8);
  let offset = 8 + count * 8;
  const frames: Array<{ bytes: Uint8Array; raw: number }> = [];
  for (let index = 0; index < count; index++) {
    const length = table.getUint32(index * 8, true);
    frames.push({ bytes: bytes.subarray(offset, offset + length), raw: table.getUint32(index * 8 + 4, true) });
    offset += length;
  }
  const parts = await Promise.all(
    frames.map((frame) => zstdDecompressAsync(frame.bytes, { chunkSize: zstdChunkSize(frame.raw) })),
  );
  return Buffer.concat(parts);
}

/** The phase turns a stored delta carries, or null when it has none. */
export async function readHistoryDeltaTurns(bytes: Uint8Array): Promise<PhaseTurns | null> {
  return parseHistoryDeltaTurns(await decompressDelta(bytes));
}

/** Rebuild the state a stroke produced, given the state it was painted onto. */
export async function applyHistoryDelta(base: Float32Array, bytes: Uint8Array): Promise<Float32Array> {
  return await historyCodec().historyApplyDelta(base, await decompressDelta(bytes));
}

/**
 * Walk a chain of stroke deltas from `base` into `out`, applying each in order:
 * subtracted where `inverts` is set (a hop to a parent), added otherwise.
 * `out` must be the same length as `base`; it is returned filled.
 */
export async function applyHistoryDeltas(
  base: Float32Array,
  out: Float32Array,
  deltas: Uint8Array[],
  inverts: boolean[],
): Promise<Float32Array> {
  const raw = await Promise.all(deltas.map((bytes) => decompressDelta(bytes)));
  return await historyCodec().historyApplyDeltas(base, out, raw, inverts);
}

/**
 * Walk a chain of stroke deltas in place over a compact buffer holding only
 * the pixels `table` names (sorted, non-overlapping [pixelStart, pixelCount]
 * pairs). A write a delta makes outside the table is skipped, so the caller's
 * table must cover every pixel it wants updated. `totalPixels` is the whole
 * state's pixel count, which the table and every delta are checked against
 * before anything is written.
 */
export async function applyHistoryDeltasWindowed(
  values: Float32Array,
  table: Uint32Array,
  deltas: Uint8Array[],
  inverts: boolean[],
  totalPixels: number,
): Promise<Float32Array> {
  const raw = await Promise.all(deltas.map((bytes) => decompressDelta(bytes)));
  return await historyCodec().historyApplyDeltasWindowed(values, table, raw, inverts, totalPixels);
}

/** Each packed pixel's time offset and band index, from the band layout. */
export async function buildHistoryInverseMap(
  bandOffsets: Uint32Array,
  bandLengths: Uint32Array,
  bandStepLog2s: Int32Array,
  pixelCount: number,
): Promise<Float32Array> {
  return await historyCodec().historyInverseMap(bandOffsets, bandLengths, bandStepLog2s, pixelCount);
}

/**
 * Onsets for a packed spectrogram. The addon reads the buffer by reference, so
 * this is a walk of the coefficients rather than a copy of them. Called with a
 * fresh analysis, and by the renderer for a file reloaded from history whose
 * stored onsets are missing.
 *
 * With a region, only that span of the file is walked and only its onsets are
 * reported — the caller splices them into the ones it has. The reference from a
 * pass that read the whole file goes with it, so the span is judged on the same
 * terms as the rest.
 */
export async function detectOnsets(
  packedData: Float32Array,
  analysisMetadata: {
    numBands: number;
    numChannels: number;
    numFrames: number;
    bandOffsets: Uint32Array;
    bandLengths: Uint32Array;
    bandStepLog2s: Int32Array;
  },
  sampleRate: number,
  region?: { startSec: number; endSec: number } & Partial<OnsetReference>,
): Promise<OnsetResult> {
  const gab = init();
  const options = region
    ? {
        startSec: region.startSec,
        endSec: region.endSec,
        odfReference: region.odfMax ?? 0,
        bandMax: region.bandMax,
      }
    : undefined;
  return await gab.detectOnsets(packedData, analysisMetadata, sampleRate, options);
}

function analysisOnsets(analysisResult: GaboratorAnalysisResult, sampleRate: number): Promise<OnsetResult> {
  return detectOnsets(
    analysisResult.data,
    {
      numBands: analysisResult.numBands,
      numChannels: analysisResult.numChannels,
      numFrames: analysisResult.numFrames,
      bandOffsets: analysisResult.bandOffsets,
      bandLengths: analysisResult.bandLengths,
      bandStepLog2s: analysisResult.bandStepLog2s,
    },
    sampleRate,
  );
}

/** Planar channels from a file on disk, and what the container said about it. */
async function decodePlanar(filePath: string) {
  const { sampleRate, channels, format, codec } = await probeAudioFile(filePath);

  // Gate on the file extension, not ffmpeg's container name: containers report
  // names that differ from the extension (m4a -> "mov,mp4,m4a,...", wma -> "asf",
  // mka -> "matroska,webm"), so matching the container against an extension
  // allowlist wrongly rejects supported files. The probe above already rejects
  // anything without a real audio stream.
  const ext = extname(filePath).replace(/^\./, "").toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(
      `The file format '${ext || format}' is not supported. Please use ${allowedExtensions.slice(0, -1).join(", ")}, or ${allowedExtensions[allowedExtensions.length - 1]}.`,
    );
  }

  const decodeStart = performance.now();
  const interleavedBuffer = await decodeAudioFile(filePath, sampleRate, channels);
  const decodeTime = performance.now() - decodeStart;
  const numFrames = interleavedBuffer.length / channels;
  console.log(
    `[analyze] FFmpeg decode time: ${decodeTime.toFixed(2)}ms for ${numFrames} samples × ${channels} channels`,
  );

  // Convert interleaved to planar for optimized C++ path
  const deinterleaveStart = performance.now();
  const channelArrays: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    channelArrays.push(new Float32Array(numFrames));
  }
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      channelArrays[ch][i] = interleavedBuffer[i * channels + ch];
    }
  }
  const deinterleaveTime = performance.now() - deinterleaveStart;
  console.log(`[analyze] JS de-interleave time: ${deinterleaveTime.toFixed(2)}ms`);

  return { channelArrays, channels, sampleRate, numFrames, format, codec };
}

/** The band layout and the size of a run, worked out before any audio is read. */
export type AnalysisStreamLayout = {
  texels: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  metadata: Float32Array;
  bandOffsets: Uint32Array;
  bandLengths: Uint32Array;
  bandStepLog2s: Int32Array;
  bandFreqsHz: Float32Array;
};

/**
 * A file's analysis, driven a span of frames at a time. Spans must be asked
 * for in order and must join; each returns the coefficients of its own frames,
 * laid out as the block of the packed state that covers them.
 */
export type AnalysisStream = {
  layout: AnalysisStreamLayout;
  format: string;
  codec: string;
  span: (startFrame: number, endFrame: number) => Promise<Float32Array>;
  /** The energy of the run, and each band's loudest moment over it. */
  summary: () => { magnitudeEnergy: number; onsetBandMax: Float32Array };
};

/** Decodes a file and opens its analysis as a stream of spans. */
export async function openAnalysisStream(filePath: string, params: AnalysisParams): Promise<AnalysisStream> {
  const gab = init();
  const { channelArrays, channels, sampleRate, format, codec } = await decodePlanar(filePath);
  const stream = new gab.AnalysisStream(channelArrays, channels, sampleRate, params);
  return {
    layout: stream.layout(),
    format,
    codec,
    span: (startFrame: number, endFrame: number) => stream.span(startFrame, endFrame),
    summary: () => stream.summary(),
  };
}

/**
 * Onsets found a chunk at a time from `read`, so no pass holds more than one
 * chunk's coefficients. `bandMax` is each band's loudest moment over the whole
 * file, which the analysis carries; a pass seeing one chunk cannot find it.
 *
 * With a region, only that span is read and reported on, against the gate a
 * pass over the whole file arrived at. Without one, the whole file is scanned
 * and the gate comes out of the scan.
 */
/** The onset passes the addon answers. */
function onsetPasses(): OnsetPasses {
  const gab = init();
  return {
    detect: (packed, meta, rate, options) => gab.detectOnsets(packed, meta, rate, options),
    curves: (packed, meta, rate, options) => gab.detectOnsets(packed, meta, rate, { ...options, curvesOnly: true }),
    pick: (odf, energy, numFrames, rate, odfGate) => gab.pickOnsets(odf, energy, numFrames, rate, odfGate),
    salience: (packed, meta, rate, options) => gab.onsetSalience(packed, meta, rate, options),
  };
}

export function scanFileOnsets(
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  analysisMetadata: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  region?: { startSec: number; endSec: number; odfReference: number },
): Promise<OnsetDetection> {
  const passes = onsetPasses();
  if (!region) {
    return scanOnsets(
      passes,
      read,
      analysisMetadata,
      sampleRate,
      bandMax,
      ONSET_CHUNK_SECONDS,
      onsetPassesInFlight(totalmem()),
    );
  }
  return scanOnsetChunk(
    passes.detect,
    read,
    analysisMetadata,
    sampleRate,
    bandMax,
    region.odfReference,
    Math.max(0, Math.floor(region.startSec * sampleRate)),
    Math.min(analysisMetadata.numFrames, Math.ceil(region.endSec * sampleRate)),
  );
}

/**
 * The detection curves of [startFrame, endFrame) from coefficients a caller
 * already holds — a synthesis chunk's, read wide enough for the whitening's
 * warm-up — so a file is read once for its audio and its onsets.
 */
export function onsetCurvesOfChunk(
  packed: Float32Array,
  analysisMetadata: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  view: PackedView,
  startFrame: number,
  endFrame: number,
): Promise<OnsetCurvesSlice> {
  const passes = onsetPasses();
  const read = () => Promise.reject(new Error("the chunk's coefficients were handed over"));
  return onsetCurvesOfSpan(passes, read, analysisMetadata, sampleRate, bandMax, startFrame, endFrame, {
    values: packed,
    view,
  });
}

/** The file's onsets from the curves of every chunk, measured a chunk at a time through `read`. */
export function finishFileOnsets(
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  analysisMetadata: PackedLayout,
  sampleRate: number,
  slices: OnsetCurvesSlice[],
  spans: Array<[number, number]>,
  bandMax: Float32Array,
): Promise<OnsetDetection> {
  return finishOnsets(
    onsetPasses(),
    read,
    analysisMetadata,
    sampleRate,
    slices,
    bandMax,
    onsetPassesInFlight(totalmem()),
    spans,
  );
}

export async function analyze(filePath: string, params: AnalysisParams) {
  const gab = init();
  const { channelArrays, channels, sampleRate, format, codec } = await decodePlanar(filePath);

  const analyzeStart = performance.now();
  const analysisResult: GaboratorAnalysisResult = await gab.analyze(channelArrays, channels, sampleRate, params);
  const analyzeTime = performance.now() - analyzeStart;
  console.log(`[analyze] Gaborator analyze time (planar): ${analyzeTime.toFixed(2)}ms`);

  const onsetResult = await analysisOnsets(analysisResult, sampleRate);
  return {
    ...analysisResult,
    onsets: onsetResult.onsets,
    onsetOdfMax: onsetResult.odfMax,
    onsetBandMax: onsetResult.bandMax,
    sampleRate,
    format,
    codec,
    channels,
  };
}

/** Analyse planar PCM channels that are already in memory, no file needed. */
export async function analyseChannels(channelArrays: Float32Array[], sampleRate: number, params: AnalysisParams) {
  const gab = init();
  const channels = channelArrays.length;

  const analyzeStart = performance.now();
  const analysisResult: GaboratorAnalysisResult = await gab.analyze(channelArrays, channels, sampleRate, params);
  const analyzeTime = performance.now() - analyzeStart;
  console.log(`[analyseChannels] Gaborator analyze time: ${analyzeTime.toFixed(2)}ms`);

  // A caller that already knows the onsets — a splice moves them rigidly with
  // the audio — passes detectOnsets: false and skips the detection pass. The
  // empty map stands in only for the shape; such a caller replaces it.
  if (params.detectOnsets === false) {
    return {
      ...analysisResult,
      onsets: new Float32Array(0),
      onsetOdfMax: 0,
      onsetBandMax: new Float32Array(0),
      sampleRate,
      format: "wav", // in-memory audio is always PCM data
      codec: "pcm_f32le",
      channels,
    };
  }

  const onsetResult = await analysisOnsets(analysisResult, sampleRate);
  return {
    ...analysisResult,
    onsets: onsetResult.onsets,
    onsetOdfMax: onsetResult.odfMax,
    onsetBandMax: onsetResult.bandMax,
    sampleRate,
    format: "wav", // in-memory audio is always PCM data
    codec: "pcm_f32le",
    channels,
  };
}

export async function analyseBuffer(audioBuffer: AudioBuffer, params: AnalysisParams) {
  // Pass planar data directly - no interleaving needed
  const channelArrays: Float32Array[] = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    channelArrays.push(audioBuffer.getChannelData(ch));
  }
  return analyseChannels(channelArrays, audioBuffer.sampleRate, params);
}

/**
 * The splice grid in samples: an edit whose length is a multiple of this keeps
 * every fine band on its own bin grid, so `spliceAnalyseChannels` rigid-moves
 * them instead of re-analysing. About 1.5 ms of audio.
 */
export function spliceQuantSamples(sampleRate: number): number {
  return 1 << init().spliceQuantLog2(sampleRate);
}

/**
 * Analyse spliced audio against the file's previous analysis. `pieces` names
 * the sample ranges of `channelArrays` that are identical to ranges of the old
 * audio; their coefficients copy across, and only the seams and the shifted
 * coarse bands are re-analysed. Result shape matches `analyseChannels` with
 * onset detection off — the caller supplies the spliced onset map. Rejects
 * when the layouts cannot splice; callers fall back to a full analysis. None
 * of the buffers may be touched while the promise is in flight.
 */
export async function spliceAnalyseChannels(
  channelArrays: Float32Array[],
  sampleRate: number,
  params: AnalysisParams,
  oldPacked: Float32Array,
  oldLayout: PackedLayout,
  pieces: SplicePiece[],
) {
  const gab = init();
  const newFrames = channelArrays[0]?.length ?? 0;
  let total = 0;
  for (let b = 0; b < oldLayout.numBands; b++) {
    total += newFrames > 0 ? ((newFrames - 1) >> oldLayout.bandStepLog2s[b]) + 1 : 0;
  }
  const out = {
    data: new Float32Array(total * 4),
    metadata: new Float32Array(oldLayout.numBands * 4),
  };

  const spliceStart = performance.now();
  const analysisResult: GaboratorAnalysisResult & { sampleRate: number } = await gab.spliceAnalyze(
    channelArrays,
    sampleRate,
    params,
    oldPacked,
    oldLayout,
    pieces,
    out,
  );
  console.log(`[spliceAnalyse] time: ${(performance.now() - spliceStart).toFixed(2)}ms`);

  return {
    ...analysisResult,
    onsets: new Float32Array(0),
    onsetOdfMax: 0,
    onsetBandMax: new Float32Array(0),
    sampleRate,
    format: "wav",
    codec: "pcm_f32le",
    channels: channelArrays.length,
  };
}

export interface SynthesisResult {
  channels: Float32Array[];
  peak: number;
  // Per-file gain-reduction envelope from the baked limiter (dB of reduction,
  // >= 0), one point per ~5 ms hop, spanning the whole buffer. Empty when the
  // limiter is bypassed.
  gainReductionDb: Float32Array;
  maxGainReductionDb: number;
  // Present only when params.detectOnsets was set: the onset map re-derived
  // from the packed data this synthesis ran on, covering the requested span,
  // with the reference the pass arrived at.
  onsets?: PackedOnsets;
  onsetOdfMax?: number;
  onsetBandMax?: Float32Array;
}

/** The native filter's coefficient margin for full-support reconstruction, in seconds. */
export async function synthesisReadReach(sampleRate: number, params: AnalysisParams): Promise<number> {
  const addon = init() as { synthesisReadReach: (rate: number, params: AnalysisParams) => number };
  return addon.synthesisReadReach(sampleRate, params);
}

export async function synthesize(
  processedData: Float32Array,
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
    viewStartFrame?: number;
    viewEndFrame?: number;
  },
  sampleRate: number,
  params: AnalysisParams,
  applyLimiter: boolean,
  existingAudio?: Float32Array[],
  startFrame?: number,
  endFrame?: number,
  startBand?: number,
  endBand?: number,
): Promise<SynthesisResult> {
  const gab = init();

  // Pass -1 for undefined to trigger full synthesis in C++
  const start = startFrame ?? -1;
  const end = endFrame ?? -1;
  const bandStart = startBand ?? -1;
  const bandEnd = endBand ?? -1;

  // Pass existing audio as array or empty array if not provided
  const existing = existingAudio ?? [];

  // The worker writes the finished audio into these off the main thread and
  // hands them back as the result's channels.
  const outputAudio = Array.from(
    { length: analysisMetadata.numChannels },
    () => new Float32Array(analysisMetadata.numFrames),
  );

  return await gab.synthesize(
    processedData,
    analysisMetadata,
    sampleRate,
    params,
    applyLimiter,
    existing,
    start,
    end,
    bandStart,
    bandEnd,
    outputAudio,
  );
}

/**
 * Everything a finished stroke derives, in one pass: the audio for the span it
 * touched spliced into the audio there was, its hard time edges made exact,
 * the limiter applied inside the stroke, the coefficients that audio analyses
 * to, the onsets over the span and its output levels.
 *
 * Any failure rejects the whole call — a commit that half happened would leave
 * the canvas, the audio and the history disagreeing. The projection writes its
 * coefficients into `packedData` in place; the returned patch ranges say which
 * spans changed.
 */
export async function commitStroke(
  packedData: Float32Array,
  analysisMetadata: PackedLayout,
  sampleRate: number,
  params: AnalysisParams,
  existingAudio: Float32Array[],
  window: CommitWindow,
  stroke: CommitStroke,
): Promise<CommitStrokeResult> {
  const gab = init();
  const outputAudio = Array.from(
    { length: analysisMetadata.numChannels },
    () => new Float32Array(analysisMetadata.numFrames),
  );
  return await gab.commitStroke(
    packedData,
    analysisMetadata,
    sampleRate,
    params,
    existingAudio,
    window,
    stroke,
    outputAudio,
  );
}

export async function hpss(
  packedData: Float32Array,
  analysisMetadata: {
    numBands: number;
    numChannels: number;
    bandOffsets: Uint32Array;
    bandLengths: Uint32Array;
  },
  kernelH = 31,
  kernelV = 31,
): Promise<{ harmonic: Float32Array; percussive: Float32Array }> {
  const gab = init();
  return await gab.hpss(packedData, analysisMetadata, kernelH, kernelV);
}

/**
 * Split a spectrogram into `numComponents` parts by non-negative matrix
 * factorisation. Like hpss this masks the magnitude channels and leaves phase
 * alone, and the masks sum to 1, so the parts add back up to the input.
 */
export async function nmf(
  packedData: Float32Array,
  analysisMetadata: {
    numBands: number;
    numChannels: number;
    bandOffsets: Uint32Array;
    bandLengths: Uint32Array;
  },
  numComponents: number,
  iterations = 120,
  seed = 1,
): Promise<{ parts: Float32Array[] }> {
  const gab = init();
  return await gab.nmf(packedData, analysisMetadata, numComponents, iterations, seed);
}

/**
 * Sum spectrograms that share a band layout, adding the complex coefficients
 * rather than the magnitudes so edited parts recombine coherently.
 */
export async function mergeSpectrograms(
  parts: Float32Array[],
  analysisMetadata: {
    numBands: number;
    numChannels: number;
    bandOffsets: Uint32Array;
    bandLengths: Uint32Array;
  },
): Promise<{ merged: Float32Array }> {
  const gab = init();
  return await gab.mergeSpectrograms(parts, analysisMetadata);
}

/**
 * True when AI stem separation can run here: the addon was built with ONNX
 * Runtime and the library opens on this system.
 */
export function aiSeparationAvailable(): boolean {
  const gab: { aiSeparate?: unknown; aiSeparationAvailable?: () => boolean } = init();
  if (typeof gab.aiSeparate !== "function") return false;
  return gab.aiSeparationAvailable?.() ?? true;
}

/**
 * Separate audio (already decoded to channels) into 4 stems using htdemucs ONNX.
 * Call with Gaborator-synthesized audio, then re-analyse each stem with Gaborator.
 * Stems: drums, bass, other, vocals
 */
export async function aiSeparate(
  audioChannels: Float32Array[],
  sampleRate: number,
): Promise<Record<string, Float32Array[]>> {
  const gab = init();
  const modelPath = getModelPath(AI_MODEL.file);
  return gab.aiSeparate(audioChannels, sampleRate, modelPath, [...AI_MODEL.stems]);
}

/**
 * Export audio channels to a file using ffmpeg
 * @param audioChannels Array of Float32Array channels
 * @param outputPath Path to save the file
 * @param sampleRate Sample rate of the audio
 * @param format Output format (wav, flac, mp3, etc)
 */
export async function exportAudio(
  audioChannels: Float32Array[],
  outputPath: string,
  sampleRate: number,
  format: string = "wav",
): Promise<void> {
  await encodeBufferToAudioFile(audioChannels, outputPath, sampleRate, format);
}

/**
 * Decode an audio file into planar channel arrays at the target sample rate.
 */
export async function decodeAudio(inputPath: string, sampleRate: number, numChannels: number): Promise<Float32Array[]> {
  const interleaved = await decodeAudioFile(inputPath, sampleRate, numChannels);
  const numFrames = interleaved.length / numChannels;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(new Float32Array(numFrames));
  }
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch][i] = interleaved[i * numChannels + ch];
    }
  }
  return channels;
}

/**
 * Copy a file on disk. Used to export cached undo WAVs without re-encoding.
 */
export async function copyAudioFile(sourcePath: string, destPath: string): Promise<void> {
  await copyFile(sourcePath, destPath);
}
