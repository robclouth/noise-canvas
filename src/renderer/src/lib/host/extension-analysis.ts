import { decodeFrame, type NumericArray } from "../../../../extension/shared/analysis-protocol";
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
    channels: Number(meta.channels),
    format: String(meta.format),
    codec: String(meta.codec),
  };
}

export function createExtensionAnalysis(): AnalysisApi {
  return {
    analyze,
    analyseBuffer: () => notImplemented("analyseBuffer"),
    synthesize: () => notImplemented("synthesize"),
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
