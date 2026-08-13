import { existsSync } from "fs";
import { copyFile } from "fs/promises";
import { extname, join } from "path";
import { promisify } from "util";
import { zstdCompress, zstdDecompress } from "zlib";
import { decodeAudioFile, encodeBufferToAudioFile, probeAudioFile } from "./ffmpeg";
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
} from "./types";
import { getModelPath } from "./ai-separation";
export { isModelDownloaded, downloadModel } from "./ai-separation";
export type { FourStemName, TwoStemName } from "./ai-separation";

// Only 4-stem is available as a public ONNX — no clean 2-stem ONNX exists yet.
// Stem order matches htdemucs output: drums(0), bass(1), other(2), vocals(3)
const AI_MODEL = {
  file: "htdemucs.onnx",
  stems: ["drums", "bass", "other", "vocals"],
} as const;

let gaborator: any = null;

export const allowedExtensions = ["wav", "mp3", "ogg", "flac", "m4a", "aac", "wma", "aiff", "ape", "wv", "mka"];

export function getGaboratorPath(): string {
  // Check if we're running from an asar archive (packaged app)
  const isPackaged = __dirname.includes("app.asar");

  if (isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node");
  }
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    gaborator = require(path);
    console.log("Gaborator loaded successfully");
  }
  return gaborator;
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
  historyFootprintChanged(base: Float32Array, after: Float32Array, ranges: Uint32Array): Promise<boolean>;
  historyEncodeDelta(base: Float32Array, after: Float32Array, ranges: Uint32Array): Promise<Buffer>;
  historyApplyDelta(base: Float32Array, delta: Uint8Array): Promise<Float32Array>;
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

/** Reorder a packed state for compression, then compress it. */
export async function encodeHistorySnapshot(packed: Float32Array): Promise<Buffer> {
  return await zstdCompressAsync(await historyCodec().historyEncodePlanes(packed));
}

export async function decodeHistorySnapshot(bytes: Uint8Array): Promise<Float32Array> {
  return await historyCodec().historyDecodePlanes(await zstdDecompressAsync(bytes));
}

/** True if a stroke changed anything inside the footprint it claims to cover. */
export async function historyFootprintChanged(
  base: Float32Array,
  after: Float32Array,
  ranges: Uint32Array,
): Promise<boolean> {
  return await historyCodec().historyFootprintChanged(base, after, ranges);
}

/** Encode a stroke as the difference from the state it was painted onto. */
export async function encodeHistoryDelta(
  base: Float32Array,
  after: Float32Array,
  ranges: Uint32Array,
): Promise<Buffer> {
  return await zstdCompressAsync(await historyCodec().historyEncodeDelta(base, after, ranges));
}

/** Rebuild the state a stroke produced, given the state it was painted onto. */
export async function applyHistoryDelta(base: Float32Array, bytes: Uint8Array): Promise<Float32Array> {
  return await historyCodec().historyApplyDelta(base, await zstdDecompressAsync(bytes));
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

export async function analyze(filePath: string, params: AnalysisParams) {
  const gab = init();

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

export async function analyseBuffer(audioBuffer: AudioBuffer, params: AnalysisParams) {
  const gab = init();

  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // Pass planar data directly - no interleaving needed
  const startTime = performance.now();
  const channelArrays: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    channelArrays.push(audioBuffer.getChannelData(ch));
  }
  const prepTime = performance.now() - startTime;
  console.log(
    `[analyseBuffer] Prep time (planar): ${prepTime.toFixed(2)}ms for ${length} samples × ${channels} channels`,
  );

  const analyzeStart = performance.now();
  const analysisResult: GaboratorAnalysisResult = await gab.analyze(channelArrays, channels, sampleRate, params);
  const analyzeTime = performance.now() - analyzeStart;
  console.log(`[analyseBuffer] Gaborator analyze time: ${analyzeTime.toFixed(2)}ms`);

  const onsetResult = await analysisOnsets(analysisResult, sampleRate);
  return {
    ...analysisResult,
    onsets: onsetResult.onsets,
    onsetOdfMax: onsetResult.odfMax,
    onsetBandMax: onsetResult.bandMax,
    sampleRate,
    format: "wav", // AudioBuffer is always PCM data
    codec: "pcm_f32le", // AudioBuffer uses 32-bit float PCM
    channels,
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

export async function synthesize(
  processedData: Float32Array,
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
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
  );
}

/**
 * Everything a finished stroke derives, in one pass: the audio for the span it
 * touched spliced into the audio there was, its hard time edges made exact,
 * the limiter applied inside the stroke, the coefficients that audio analyses
 * to, the onsets over the span and its output levels.
 *
 * Any failure rejects the whole call — a commit that half happened would leave
 * the canvas, the audio and the history disagreeing. The input buffer is never
 * written; the returned patch alone carries this pass's coefficient changes.
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
  return await gab.commitStroke(packedData, analysisMetadata, sampleRate, params, existingAudio, window, stroke);
}

/**
 * Computes the boundary-conditioning patch for a stroke footprint: the
 * coefficients around the footprint's time edges rewritten to carry the
 * time-domain-exact edit (interior content confined to the footprint,
 * exterior content excluded from it). Returns per-band ranges plus the
 * patched pixel values; the input buffer is not modified.
 */
export async function conditionBoundary(
  packedData: Float32Array,
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  },
  sampleRate: number,
  params: AnalysisParams,
  footprint: { startFrame: number; endFrame: number; bandLo: number; bandHi: number },
): Promise<{ ranges: Uint32Array; pixels: Float32Array }> {
  const gab = init();
  return await gab.conditionBoundary(packedData, analysisMetadata, sampleRate, params, footprint);
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
