import { decodeFrame, encodeFrame, type NumericArray } from "../../../../extension/shared/analysis-protocol";
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

async function analyze(filePath: string, params: { bandsPerOctave: number; minFreq: number }): Promise<AnalyzeResult> {
  const response = await fetch("/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filePath, bandsPerOctave: params.bandsPerOctave, minFreq: params.minFreq }),
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
  normalize,
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
    normalize: normalize ? 1 : 0,
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
  return { channels, peak: Number(outMeta.peak) };
};

export function createExtensionAnalysis(): AnalysisApi {
  return {
    analyze,
    analyseBuffer: () => notImplemented("analyseBuffer"),
    synthesize,
    isModelDownloaded: () => notImplemented("isModelDownloaded"),
    downloadModel: () => notImplemented("downloadModel"),
    aiSeparate: () => notImplemented("aiSeparate"),
    hpss: () => notImplemented("hpss"),
    exportAudio: () => notImplemented("exportAudio"),
    decodeAudio: () => notImplemented("decodeAudio"),
    copyAudioFile: () => notImplemented("copyAudioFile"),
    init: () => {},
  };
}
