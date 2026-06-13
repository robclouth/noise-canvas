import { analyze } from "../../main/lib/audio-analysis";
import type { AnalysisParams } from "../../main/lib/types";
import { encodeFrame, type Frame, type NumericArray } from "../shared/analysis-protocol";

// Reuses the Electron app's native analysis path verbatim: analyze() runs the
// ffmpeg-static decode + N-API gaborator addon (both verified to run in Live's
// embedded Node). The webview hands the host a real on-disk clip path; the host
// reads, decodes, and analyses it, then ships the packed spectrogram back framed
// as binary.

type AnalysisResult = Awaited<ReturnType<typeof analyze>>;

// Splits the analyze() result into the binary frame: typed arrays travel as raw
// bytes, scalars as the JSON header.
function resultToFrame(result: AnalysisResult): Frame {
  const arrays: Record<string, NumericArray> = {
    data: result.data,
    inverseMap: result.inverseMap,
    metadata: result.metadata,
    bandOffsets: result.bandOffsets,
    bandStepLog2s: result.bandStepLog2s,
    bandLengths: result.bandLengths,
  };
  // bandFreqsHz is returned by the addon but absent from the published type;
  // forward it when present so the renderer sees the same shape as in Electron.
  const maybeFreqs = (result as { bandFreqsHz?: NumericArray }).bandFreqsHz;
  if (maybeFreqs) arrays.bandFreqsHz = maybeFreqs;

  return {
    meta: {
      textureWidth: result.textureWidth,
      textureHeight: result.textureHeight,
      numFrames: result.numFrames,
      numChannels: result.numChannels,
      numBands: result.numBands,
      sampleRate: result.sampleRate,
      format: result.format,
      codec: result.codec,
      channels: result.channels,
    },
    arrays,
  };
}

export async function runAnalyzeFramed(filePath: string, params: AnalysisParams): Promise<Uint8Array> {
  const result = await analyze(filePath, params);
  return encodeFrame(resultToFrame(result));
}
