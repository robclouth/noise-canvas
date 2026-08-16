import { decodeFrame, encodeFrame, type NumericArray } from "../../../../extension/shared/analysis-protocol";
import { getBootstrapOrNull } from "./extension-rpc";
import type { Host } from "./types";

// Webview side of the analysis transport. The page is served by the extension's
// localhost server, so it reaches the native analysis path with a same-origin
// fetch: the Node host runs ffmpeg + the gaborator addon on the clip's on-disk
// path and returns the packed spectrogram as a binary frame.

type AnalysisApi = Host["analysis"];
type AnalyzeResult = Awaited<ReturnType<AnalysisApi["analyze"]>>;

function f32(array: NumericArray | undefined, name: string): Float32Array {
  if (array instanceof Float32Array) return array;
  throw new Error(`analysis frame: expected Float32Array for ${name}`);
}
function u32(array: NumericArray | undefined, name: string): Uint32Array {
  if (array instanceof Uint32Array) return array;
  throw new Error(`analysis frame: expected Uint32Array for ${name}`);
}
function i32(array: NumericArray | undefined, name: string): Int32Array {
  if (array instanceof Int32Array) return array;
  throw new Error(`analysis frame: expected Int32Array for ${name}`);
}
function u8(array: NumericArray | undefined, name: string): Uint8Array {
  if (array instanceof Uint8Array) return array;
  throw new Error(`analysis frame: expected Uint8Array for ${name}`);
}

function frameToAnalysis(frame: {
  meta: Record<string, number | string>;
  arrays: Record<string, NumericArray>;
}): AnalyzeResult {
  const { meta, arrays } = frame;
  return {
    data: f32(arrays.data, "data"),
    inverseMap: f32(arrays.inverseMap, "inverseMap"),
    metadata: f32(arrays.metadata, "metadata"),
    bandOffsets: u32(arrays.bandOffsets, "bandOffsets"),
    bandStepLog2s: i32(arrays.bandStepLog2s, "bandStepLog2s"),
    bandLengths: u32(arrays.bandLengths, "bandLengths"),
    onsets: f32(arrays.onsets, "onsets"),
    onsetOdfMax: meta.onsetOdfMax === undefined ? undefined : Number(meta.onsetOdfMax),
    onsetBandMax: arrays.onsetBandMax ? f32(arrays.onsetBandMax, "onsetBandMax") : undefined,
    textureWidth: Number(meta.textureWidth),
    textureHeight: Number(meta.textureHeight),
    numFrames: Number(meta.numFrames),
    numChannels: Number(meta.numChannels),
    numBands: Number(meta.numBands),
    sampleRate: Number(meta.sampleRate),
    magnitudeEnergy: Number(meta.magnitudeEnergy),
    channels: Number(meta.channels),
    format: String(meta.format),
    codec: String(meta.codec),
  };
}

async function analyze(
  filePath: string,
  params: { bandsPerOctave: number; minFreq: number; maxCoefficients?: number },
): Promise<AnalyzeResult> {
  const response = await fetch("/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filePath,
      bandsPerOctave: params.bandsPerOctave,
      minFreq: params.minFreq,
      maxCoefficients: params.maxCoefficients,
    }),
  });
  if (!response.ok) {
    throw new Error(`analysis request failed (${response.status}): ${await response.text()}`);
  }
  return frameToAnalysis(decodeFrame(await response.arrayBuffer()));
}

// One analysis operation on in-memory buffers, running in the Node host where
// the addon and ffmpeg live; `op` selects which. Same framed round-trip as the
// history codec.
async function analysisOp(
  op: string,
  arrays: Record<string, NumericArray>,
  meta: Record<string, number | string> = {},
): Promise<{ meta: Record<string, number | string>; arrays: Record<string, NumericArray> }> {
  const response = await fetch("/analysis-op", {
    method: "POST",
    body: encodeFrame({ meta: { op, ...meta }, arrays }),
  });
  if (!response.ok) {
    throw new Error(`analysis op ${op} failed (${response.status}): ${await response.text()}`);
  }
  return decodeFrame(await response.arrayBuffer());
}

async function analyseBuffer(
  audioBuffer: AudioBuffer,
  params: { bandsPerOctave: number; minFreq: number; maxCoefficients?: number },
): Promise<AnalyzeResult> {
  const arrays: Record<string, NumericArray> = {};
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    arrays[`channel${ch}`] = audioBuffer.getChannelData(ch);
  }
  const meta: Record<string, number> = {
    numChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
    bandsPerOctave: params.bandsPerOctave,
    minFreq: params.minFreq,
  };
  if (params.maxCoefficients !== undefined) meta.maxCoefficients = params.maxCoefficients;
  return frameToAnalysis(await analysisOp("analyseChannels", arrays, meta));
}

type SynthesizeFn = AnalysisApi["synthesize"];
type SynthesisResult = Awaited<ReturnType<SynthesizeFn>>;
type AnalysisMetadata = Parameters<SynthesizeFn>[1];

const synthesize: SynthesizeFn = async (
  processedData,
  analysisMetadata: AnalysisMetadata,
  sampleRate,
  params,
  applyLimiter,
  existingAudio,
  startFrame,
  endFrame,
  startBand,
  endBand,
): Promise<SynthesisResult> => {
  const arrays: Record<string, NumericArray> = {
    processedData,
    bandOffsets: analysisMetadata.bandOffsets,
    bandStepLog2s: analysisMetadata.bandStepLog2s,
    bandLengths: analysisMetadata.bandLengths,
  };
  (existingAudio ?? []).forEach((channel, i) => (arrays[`existing${i}`] = channel));

  const meta: Record<string, number> = {
    numFrames: analysisMetadata.numFrames,
    numChannels: analysisMetadata.numChannels,
    numBands: analysisMetadata.numBands,
    sampleRate,
    bandsPerOctave: params.bandsPerOctave,
    minFreq: params.minFreq,
    applyLimiter: applyLimiter ? 1 : 0,
    detectOnsets: params.detectOnsets ? 1 : 0,
    existingChannelCount: existingAudio?.length ?? 0,
  };
  if (startFrame !== undefined) meta.startFrame = startFrame;
  if (endFrame !== undefined) meta.endFrame = endFrame;
  if (startBand !== undefined) meta.startBand = startBand;
  if (endBand !== undefined) meta.endBand = endBand;

  const response = await fetch("/synthesize", { method: "POST", body: encodeFrame({ meta, arrays }) });
  if (!response.ok) {
    throw new Error(`synthesis request failed (${response.status}): ${await response.text()}`);
  }
  const { meta: outMeta, arrays: outArrays } = decodeFrame(await response.arrayBuffer());
  const numChannels = Number(outMeta.numChannels);
  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) channels.push(f32(outArrays[`channel${i}`], `channel${i}`));
  return {
    channels,
    peak: Number(outMeta.peak),
    gainReductionDb: f32(outArrays.gainReductionDb, "gainReductionDb"),
    maxGainReductionDb: Number(outMeta.maxGainReductionDb),
    onsets: outArrays.onsets ? f32(outArrays.onsets, "onsets") : undefined,
    onsetOdfMax: outMeta.onsetOdfMax !== undefined ? Number(outMeta.onsetOdfMax) : undefined,
    onsetBandMax: outArrays.onsetBandMax ? f32(outArrays.onsetBandMax, "onsetBandMax") : undefined,
  };
};

type CommitStrokeFn = AnalysisApi["commitStroke"];
type CommitResult = Awaited<ReturnType<CommitStrokeFn>>;

const commitStroke: CommitStrokeFn = async (
  packedData,
  analysisMetadata,
  sampleRate,
  params,
  existingAudio,
  window,
  stroke,
): Promise<CommitResult> => {
  const arrays: Record<string, NumericArray> = {
    packedData,
    bandOffsets: analysisMetadata.bandOffsets,
    bandStepLog2s: analysisMetadata.bandStepLog2s,
    bandLengths: analysisMetadata.bandLengths,
  };
  existingAudio.forEach((channel, i) => (arrays[`existing${i}`] = channel));
  if (params.onsetBandMax) arrays.onsetBandMax = params.onsetBandMax;

  const meta: Record<string, number> = {
    numFrames: analysisMetadata.numFrames,
    numChannels: analysisMetadata.numChannels,
    numBands: analysisMetadata.numBands,
    sampleRate,
    bandsPerOctave: params.bandsPerOctave,
    minFreq: params.minFreq,
    detectOnsets: params.detectOnsets ? 1 : 0,
    existingChannelCount: existingAudio.length,
    startFrame: window.startFrame,
    endFrame: window.endFrame,
    startBand: window.startBand,
    endBand: window.endBand,
    footStartFrame: stroke.footStartFrame,
    footEndFrame: stroke.footEndFrame,
    hardEdgeStart: stroke.hardEdgeStart ? 1 : 0,
    hardEdgeEnd: stroke.hardEdgeEnd ? 1 : 0,
    applyLimiter: stroke.applyLimiter ? 1 : 0,
    project: stroke.project ? 1 : 0,
  };
  if (params.onsetStartSec !== undefined) meta.onsetStartSec = params.onsetStartSec;
  if (params.onsetEndSec !== undefined) meta.onsetEndSec = params.onsetEndSec;
  if (params.onsetOdfReference !== undefined) meta.onsetOdfReference = params.onsetOdfReference;

  const response = await fetch("/commit-stroke", { method: "POST", body: encodeFrame({ meta, arrays }) });
  if (!response.ok) {
    throw new Error(`stroke commit failed (${response.status}): ${await response.text()}`);
  }
  const { meta: outMeta, arrays: outArrays } = decodeFrame(await response.arrayBuffer());
  const numChannels = Number(outMeta.numChannels);
  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) channels.push(f32(outArrays[`channel${i}`], `channel${i}`));
  return {
    channels,
    peak: Number(outMeta.peak),
    patch: {
      ranges: u32(outArrays.patchRanges, "patchRanges"),
      pixels: f32(outArrays.patchPixels, "patchPixels"),
    },
    gainReductionDb: f32(outArrays.gainReductionDb, "gainReductionDb"),
    maxGainReductionDb: Number(outMeta.maxGainReductionDb),
    levels: {
      startHop: Number(outMeta.levelStartHop),
      peaks: f32(outArrays.levelPeaks, "levelPeaks"),
      overDb: f32(outArrays.levelOverDb, "levelOverDb"),
    },
    onsets: outArrays.onsets ? f32(outArrays.onsets, "onsets") : undefined,
    onsetOdfMax: outMeta.onsetOdfMax === undefined ? undefined : Number(outMeta.onsetOdfMax),
    onsetBandMax: outArrays.onsetBandMax ? f32(outArrays.onsetBandMax, "onsetBandMax") : undefined,
  };
};

// The undo-history codec runs in the addon, which lives in the Node host — so
// each operation is a framed round-trip over the same transport the analysis
// uses, with `op` selecting which one.
async function historyCodec(
  op: string,
  arrays: Record<string, NumericArray>,
  meta: Record<string, number | string> = {},
): Promise<{ meta: Record<string, number | string>; arrays: Record<string, NumericArray> }> {
  const response = await fetch("/history-codec", {
    method: "POST",
    body: encodeFrame({ meta: { op, ...meta }, arrays }),
  });
  if (!response.ok) {
    throw new Error(`history codec ${op} failed (${response.status}): ${await response.text()}`);
  }
  return decodeFrame(await response.arrayBuffer());
}

type DetectOnsetsFn = AnalysisApi["detectOnsets"];
const detectOnsets: DetectOnsetsFn = async (packedData, analysisMetadata, sampleRate, region) => {
  const arrays: Record<string, NumericArray> = {
    packed: packedData,
    bandOffsets: analysisMetadata.bandOffsets,
    bandLengths: analysisMetadata.bandLengths,
    bandStepLog2s: analysisMetadata.bandStepLog2s,
  };
  const meta: Record<string, number> = {
    numBands: analysisMetadata.numBands,
    numChannels: analysisMetadata.numChannels,
    numFrames: analysisMetadata.numFrames,
    sampleRate,
  };
  if (region) {
    meta.regionStartSec = region.startSec;
    meta.regionEndSec = region.endSec;
    if (region.odfMax !== undefined) meta.regionOdfMax = region.odfMax;
    if (region.bandMax) arrays.regionBandMax = region.bandMax;
  }
  const result = await analysisOp("detectOnsets", arrays, meta);
  return {
    onsets: f32(result.arrays.onsets, "onsets"),
    odfMax: Number(result.meta.odfMax),
    bandMax: f32(result.arrays.bandMax, "bandMax"),
  };
};

// The coefficient-layout metadata hpss/nmf/mergeSpectrograms share.
type SplitLayout = Parameters<AnalysisApi["hpss"]>[1];

function layoutFrame(
  packedOrParts: Record<string, NumericArray>,
  layout: SplitLayout,
): { arrays: Record<string, NumericArray>; meta: Record<string, number> } {
  return {
    arrays: { ...packedOrParts, bandOffsets: layout.bandOffsets, bandLengths: layout.bandLengths },
    meta: { numBands: layout.numBands, numChannels: layout.numChannels },
  };
}

type HpssFn = AnalysisApi["hpss"];
const hpss: HpssFn = async (packedData, analysisMetadata, kernelH, kernelV) => {
  const { arrays, meta } = layoutFrame({ packed: packedData }, analysisMetadata);
  const withKernels: Record<string, number> = { ...meta };
  if (kernelH !== undefined) withKernels.kernelH = kernelH;
  if (kernelV !== undefined) withKernels.kernelV = kernelV;
  const result = await analysisOp("hpss", arrays, withKernels);
  return {
    harmonic: f32(result.arrays.harmonic, "harmonic"),
    percussive: f32(result.arrays.percussive, "percussive"),
  };
};

type NmfFn = AnalysisApi["nmf"];
const nmf: NmfFn = async (packedData, analysisMetadata, numComponents, iterations, seed) => {
  const { arrays, meta } = layoutFrame({ packed: packedData }, analysisMetadata);
  const withOptions: Record<string, number> = { ...meta, numComponents };
  if (iterations !== undefined) withOptions.iterations = iterations;
  if (seed !== undefined) withOptions.seed = seed;
  const result = await analysisOp("nmf", arrays, withOptions);
  const numParts = Number(result.meta.numParts);
  return { parts: Array.from({ length: numParts }, (_, i) => f32(result.arrays[`part${i}`], `part${i}`)) };
};

type MergeFn = AnalysisApi["mergeSpectrograms"];
const mergeSpectrograms: MergeFn = async (parts, analysisMetadata) => {
  const partArrays: Record<string, NumericArray> = {};
  parts.forEach((part, i) => (partArrays[`part${i}`] = part));
  const { arrays, meta } = layoutFrame(partArrays, analysisMetadata);
  const result = await analysisOp("mergeSpectrograms", arrays, { ...meta, numParts: parts.length });
  return { merged: f32(result.arrays.merged, "merged") };
};

type AiSeparateFn = AnalysisApi["aiSeparate"];
const aiSeparate: AiSeparateFn = async (audioChannels, sampleRate) => {
  const arrays: Record<string, NumericArray> = {};
  audioChannels.forEach((channel, i) => (arrays[`channel${i}`] = channel));
  const result = await analysisOp("aiSeparate", arrays, { numChannels: audioChannels.length, sampleRate });
  const stems: Record<string, Float32Array[]> = {};
  for (const stem of String(result.meta.stemNames).split(",").filter(Boolean)) {
    const count = Number(result.meta[`${stem}Channels`]);
    stems[stem] = Array.from({ length: count }, (_, i) => f32(result.arrays[`${stem}${i}`], `${stem}${i}`));
  }
  return stems;
};

// Models downloaded during this webview's lifetime; the bootstrap carries the
// ones already cached on disk, so the synchronous check never needs a round-trip.
const downloadedThisSession = new Set<string>();

type DownloadModelFn = AnalysisApi["downloadModel"];
const downloadModel: DownloadModelFn = async (modelFile, onProgress) => {
  // The download rides a single long request, so progress is polled beside it.
  const poll = onProgress
    ? window.setInterval(() => {
        void analysisOp("modelDownloadProgress", {}, { modelFile }).then(
          (frame) => {
            const downloaded = Number(frame.meta.downloaded);
            if (downloaded > 0) onProgress(downloaded, Number(frame.meta.total));
          },
          () => {},
        );
      }, 500)
    : null;
  try {
    await analysisOp("downloadModel", {}, { modelFile });
    downloadedThisSession.add(modelFile);
  } finally {
    if (poll !== null) window.clearInterval(poll);
  }
};

type ExportAudioFn = AnalysisApi["exportAudio"];
const exportAudio: ExportAudioFn = async (audioChannels, outputPath, sampleRate, format) => {
  const arrays: Record<string, NumericArray> = {};
  audioChannels.forEach((channel, i) => (arrays[`channel${i}`] = channel));
  await analysisOp("exportAudio", arrays, {
    numChannels: audioChannels.length,
    outputPath,
    sampleRate,
    format: format ?? "wav",
  });
};

export function createExtensionAnalysis(): AnalysisApi {
  return {
    getGpuMemoryInfo: () => {
      const boot = getBootstrapOrNull();
      return { bytes: boot?.gpuMemoryBytes ?? 0, unified: boot?.gpuMemoryUnified ?? true };
    },
    analyze,
    analyseBuffer,
    synthesize,
    commitStroke,
    encodeHistorySnapshot: async (packed) =>
      u8((await historyCodec("encodeSnapshot", { packed })).arrays.bytes, "bytes"),
    decodeHistorySnapshot: async (bytes) =>
      f32((await historyCodec("decodeSnapshot", { bytes })).arrays.packed, "packed"),
    historyFootprintChanged: async (base, after, ranges) =>
      Number((await historyCodec("footprintChanged", { base, after, ranges })).meta.changed) === 1,
    encodeHistoryDelta: async (base, after, ranges) =>
      u8((await historyCodec("encodeDelta", { base, after, ranges })).arrays.bytes, "bytes"),
    applyHistoryDelta: async (base, bytes) =>
      f32((await historyCodec("applyDelta", { base, bytes })).arrays.packed, "packed"),
    buildHistoryInverseMap: async (bandOffsets, bandLengths, bandStepLog2s, pixelCount) =>
      f32(
        (await historyCodec("inverseMap", { bandOffsets, bandLengths, bandStepLog2s }, { pixelCount })).arrays
          .inverseMap,
        "inverseMap",
      ),
    isModelDownloaded: (modelFile) =>
      downloadedThisSession.has(modelFile) || (getBootstrapOrNull()?.downloadedModels ?? []).includes(modelFile),
    downloadModel,
    aiSeparate,
    detectOnsets,
    hpss,
    nmf,
    mergeSpectrograms,
    exportAudio,
    decodeAudio: async (inputPath, sampleRate, numChannels) => {
      const result = await analysisOp("decodeAudio", {}, { inputPath, sampleRate, numChannels });
      return Array.from({ length: numChannels }, (_, i) => f32(result.arrays[`channel${i}`], `channel${i}`));
    },
    copyAudioFile: async (sourcePath, destPath) => {
      await analysisOp("copyAudioFile", {}, { sourcePath, destPath });
    },
    init: () => {},
  };
}
