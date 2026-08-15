import { decodeFrame, encodeFrame, type NumericArray } from "../../../../extension/shared/analysis-protocol";
import { getBootstrapOrNull } from "./extension-rpc";
import type { Host } from "./types";

// Webview side of the analysis transport. The page is served by the extension's
// localhost server, so it reaches the native analysis path with a same-origin
// fetch: the Node host runs ffmpeg + the gaborator addon on the clip's on-disk
// path and returns the packed spectrogram as a binary frame.

type AnalysisApi = Host["analysis"];
type AnalyzeResult = Awaited<ReturnType<AnalysisApi["analyze"]>>;

function notImplemented(capability: string): never {
  throw new Error(`host.analysis.${capability} is not yet wired in the Ableton extension (later transport slice).`);
}

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
  const { meta, arrays } = decodeFrame(await response.arrayBuffer());
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
      clipped: u8(outArrays.levelClipped, "levelClipped"),
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

export function createExtensionAnalysis(): AnalysisApi {
  return {
    getGpuMemoryInfo: () => {
      const boot = getBootstrapOrNull();
      return { bytes: boot?.gpuMemoryBytes ?? 0, unified: boot?.gpuMemoryUnified ?? true };
    },
    analyze,
    analyseBuffer: () => notImplemented("analyseBuffer"),
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
    isModelDownloaded: () => notImplemented("isModelDownloaded"),
    downloadModel: () => notImplemented("downloadModel"),
    aiSeparate: () => notImplemented("aiSeparate"),
    detectOnsets: () => notImplemented("detectOnsets"),
    hpss: () => notImplemented("hpss"),
    nmf: () => notImplemented("nmf"),
    mergeSpectrograms: () => notImplemented("mergeSpectrograms"),
    exportAudio: () => notImplemented("exportAudio"),
    decodeAudio: () => notImplemented("decodeAudio"),
    copyAudioFile: () => notImplemented("copyAudioFile"),
    init: () => {},
  };
}
