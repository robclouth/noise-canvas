import {
  analyze,
  applyHistoryDelta,
  buildHistoryInverseMap,
  decodeHistorySnapshot,
  encodeHistoryDelta,
  encodeHistorySnapshot,
  historyFootprintChanged,
  synthesize,
} from "../../main/lib/audio-analysis";
import type { AnalysisParams } from "../../main/lib/types";
import {
  asF32,
  asI32,
  asU8,
  asU32,
  decodeFrame,
  encodeFrame,
  type Frame,
  type NumericArray,
} from "../shared/analysis-protocol";

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
    onsets: result.onsets,
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
      magnitudeEnergy: result.magnitudeEnergy,
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

function optionalNumber(value: number | string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

// Synthesises audio from a (painted) packed spectrogram via the native gaborator
// addon. Request/response travel as frames: the painted data + band tables in,
// the per-channel PCM out.
export async function runSynthesizeFramed(request: ArrayBuffer): Promise<Uint8Array> {
  const { meta, arrays } = decodeFrame(request);
  const existingChannelCount = Number(meta.existingChannelCount);
  const existingAudio =
    existingChannelCount > 0
      ? Array.from({ length: existingChannelCount }, (_, i) => asF32(arrays[`existing${i}`], `existing${i}`))
      : undefined;

  const result = await synthesize(
    asF32(arrays.processedData, "processedData"),
    {
      numFrames: Number(meta.numFrames),
      numChannels: Number(meta.numChannels),
      numBands: Number(meta.numBands),
      bandOffsets: asU32(arrays.bandOffsets, "bandOffsets"),
      bandStepLog2s: asI32(arrays.bandStepLog2s, "bandStepLog2s"),
      bandLengths: asU32(arrays.bandLengths, "bandLengths"),
    },
    Number(meta.sampleRate),
    {
      bandsPerOctave: Number(meta.bandsPerOctave),
      minFreq: Number(meta.minFreq),
      detectOnsets: meta.detectOnsets === 1,
    },
    meta.applyLimiter === 1,
    existingAudio,
    optionalNumber(meta.startFrame),
    optionalNumber(meta.endFrame),
    optionalNumber(meta.startBand),
    optionalNumber(meta.endBand),
  );

  const channels: Record<string, NumericArray> = {};
  result.channels.forEach((channel, i) => (channels[`channel${i}`] = channel));
  channels.gainReductionDb = result.gainReductionDb;
  if (result.onsets) channels.onsets = result.onsets;
  return encodeFrame({
    meta: { peak: result.peak, numChannels: result.channels.length, maxGainReductionDb: result.maxGainReductionDb },
    arrays: channels,
  });
}

/**
 * Runs one undo-history codec operation in the host. The webview holds the
 * packed states but not the addon, so the buffers travel over the same framed
 * transport the analysis uses; `meta.op` selects the operation.
 */
export async function runHistoryCodecFramed(request: ArrayBuffer): Promise<Uint8Array> {
  const { meta, arrays } = decodeFrame(request);
  switch (String(meta.op)) {
    case "encodeSnapshot":
      return encodeFrame({
        meta: {},
        arrays: { bytes: await encodeHistorySnapshot(asF32(arrays.packed, "packed")) },
      });
    case "decodeSnapshot":
      return encodeFrame({
        meta: {},
        arrays: { packed: await decodeHistorySnapshot(asU8(arrays.bytes, "bytes")) },
      });
    case "footprintChanged": {
      const changed = await historyFootprintChanged(
        asF32(arrays.base, "base"),
        asF32(arrays.after, "after"),
        asU32(arrays.ranges, "ranges"),
      );
      return encodeFrame({ meta: { changed: changed ? 1 : 0 }, arrays: {} });
    }
    case "encodeDelta":
      return encodeFrame({
        meta: {},
        arrays: {
          bytes: await encodeHistoryDelta(
            asF32(arrays.base, "base"),
            asF32(arrays.after, "after"),
            asU32(arrays.ranges, "ranges"),
          ),
        },
      });
    case "applyDelta":
      return encodeFrame({
        meta: {},
        arrays: { packed: await applyHistoryDelta(asF32(arrays.base, "base"), asU8(arrays.bytes, "bytes")) },
      });
    case "inverseMap":
      return encodeFrame({
        meta: {},
        arrays: {
          inverseMap: await buildHistoryInverseMap(
            asU32(arrays.bandOffsets, "bandOffsets"),
            asU32(arrays.bandLengths, "bandLengths"),
            asI32(arrays.bandStepLog2s, "bandStepLog2s"),
            Number(meta.pixelCount),
          ),
        },
      });
    default:
      throw new Error(`history codec: unknown op ${String(meta.op)}`);
  }
}
