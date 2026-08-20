import {
  aiSeparate,
  analyseChannels,
  analyze,
  applyHistoryDelta,
  applyHistoryDeltas,
  buildHistoryInverseMap,
  readHistoryDeltaTurns,
  commitStroke,
  copyAudioFile,
  decodeAudio,
  decodeHistorySnapshot,
  detectOnsets,
  downloadModel,
  encodeHistoryDelta,
  encodeHistorySnapshot,
  exportAudio,
  historyFootprintChanged,
  hpss,
  isModelDownloaded,
  mergeSpectrograms,
  nmf,
  synthesize,
} from "../../main/lib/audio-analysis";
import type { AnalysisParams } from "../../main/lib/types";
export { getGpuMemoryInfo } from "../../main/lib/audio-analysis";
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
  // The onset reference seeds region-limited re-detection on the first stroke;
  // without it the renderer falls back to a whole-file pass.
  if (result.onsetBandMax) arrays.onsetBandMax = result.onsetBandMax;

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
      ...(result.onsetOdfMax !== undefined ? { onsetOdfMax: result.onsetOdfMax } : {}),
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
  // Carried, as commitStroke already does: without them the client cannot
  // establish onsetReference, and every later pass falls back to a whole-file
  // onset walk instead of the region the stroke touched.
  if (result.onsetBandMax) channels.onsetBandMax = result.onsetBandMax;
  return encodeFrame({
    meta: {
      peak: result.peak,
      numChannels: result.channels.length,
      maxGainReductionDb: result.maxGainReductionDb,
      ...(result.onsetOdfMax !== undefined ? { onsetOdfMax: result.onsetOdfMax } : {}),
    },
    arrays: channels,
  });
}

/**
 * Derives everything a finished stroke means, in the host where the addon
 * lives. One request in, one frame out — the audio, the coefficient patch, the
 * onsets and the levels, or a rejection carrying none of them.
 */
export async function runCommitStrokeFramed(request: ArrayBuffer): Promise<Uint8Array> {
  const { meta, arrays } = decodeFrame(request);
  const existingChannelCount = Number(meta.existingChannelCount);
  const existingAudio = Array.from({ length: existingChannelCount }, (_, i) =>
    asF32(arrays[`existing${i}`], `existing${i}`),
  );

  const packedData = asF32(arrays.packedData, "packedData");
  const bandOffsets = asU32(arrays.bandOffsets, "bandOffsets");

  const result = await commitStroke(
    packedData,
    {
      numFrames: Number(meta.numFrames),
      numChannels: Number(meta.numChannels),
      numBands: Number(meta.numBands),
      bandOffsets,
      bandStepLog2s: asI32(arrays.bandStepLog2s, "bandStepLog2s"),
      bandLengths: asU32(arrays.bandLengths, "bandLengths"),
    },
    Number(meta.sampleRate),
    {
      bandsPerOctave: Number(meta.bandsPerOctave),
      minFreq: Number(meta.minFreq),
      detectOnsets: meta.detectOnsets === 1,
      onsetStartSec: optionalNumber(meta.onsetStartSec),
      onsetEndSec: optionalNumber(meta.onsetEndSec),
      onsetOdfReference: optionalNumber(meta.onsetOdfReference),
      onsetBandMax: arrays.onsetBandMax ? asF32(arrays.onsetBandMax, "onsetBandMax") : undefined,
    },
    existingAudio,
    {
      startFrame: Number(meta.startFrame),
      endFrame: Number(meta.endFrame),
      startBand: Number(meta.startBand),
      endBand: Number(meta.endBand),
    },
    {
      footStartFrame: Number(meta.footStartFrame),
      footEndFrame: Number(meta.footEndFrame),
      hardEdgeStart: meta.hardEdgeStart === 1,
      hardEdgeEnd: meta.hardEdgeEnd === 1,
      applyLimiter: meta.applyLimiter === 1,
      project: meta.project === 1,
    },
  );

  // The addon wrote the patch into this host's packedData in place; the client
  // holds its own copy, so the pixels are gathered back out for the wire.
  const ranges = result.patch.ranges;
  let patchFloats = 0;
  for (let i = 0; i < ranges.length; i += 3) patchFloats += ranges[i + 2] * 4;
  const patchPixels = new Float32Array(patchFloats);
  let dst = 0;
  for (let i = 0; i < ranges.length; i += 3) {
    const start = (bandOffsets[ranges[i]] + ranges[i + 1]) * 4;
    const count = ranges[i + 2] * 4;
    patchPixels.set(packedData.subarray(start, start + count), dst);
    dst += count;
  }

  const out: Record<string, NumericArray> = {
    patchRanges: ranges,
    patchPixels,
    patchPrevious: result.patch.previous ?? new Float32Array(0),
    tailPixelStarts: result.tail.pixelStarts,
    tailPixelCounts: result.tail.pixelCounts,
    tailOffsets: result.tail.offsets,
    tailResiduals: result.tail.residuals,
    gainReductionDb: result.gainReductionDb,
    levelPeaks: result.levels.peaks,
    levelOverDb: result.levels.overDb,
  };
  result.channels.forEach((channel, i) => (out[`channel${i}`] = channel));
  if (result.onsets) out.onsets = result.onsets;
  if (result.onsetBandMax) out.onsetBandMax = result.onsetBandMax;

  return encodeFrame({
    meta: {
      numChannels: result.channels.length,
      peak: result.peak,
      maxGainReductionDb: result.maxGainReductionDb,
      audioWindowStart: result.audioWindow.start,
      audioWindowEnd: result.audioWindow.end,
      levelStartHop: result.levels.startHop,
      ...(result.onsetOdfMax !== undefined ? { onsetOdfMax: result.onsetOdfMax } : {}),
    },
    arrays: out,
  });
}

function planarChannels(arrays: Record<string, NumericArray>, count: number, prefix = "channel"): Float32Array[] {
  return Array.from({ length: count }, (_, i) => asF32(arrays[`${prefix}${i}`], `${prefix}${i}`));
}

function framedChannels(channels: Float32Array[]): Frame {
  const arrays: Record<string, NumericArray> = {};
  channels.forEach((channel, i) => (arrays[`channel${i}`] = channel));
  return { meta: { numChannels: channels.length }, arrays };
}

// In-flight model downloads, so the webview can poll progress while its
// download request is still pending.
const modelDownloads = new Map<string, { downloaded: number; total: number; done: boolean }>();

/**
 * Runs one analysis operation on in-memory buffers in the host: buffer
 * analysis, onset detection, splits and merges, AI separation, and audio
 * encode/decode/copy. The buffers travel over the same framed transport the
 * analysis uses; `meta.op` selects the operation.
 */
export async function runAnalysisOpFramed(request: ArrayBuffer): Promise<Uint8Array> {
  const { meta, arrays } = decodeFrame(request);
  switch (String(meta.op)) {
    case "analyseChannels": {
      const channels = planarChannels(arrays, Number(meta.numChannels));
      const params: AnalysisParams = {
        bandsPerOctave: Number(meta.bandsPerOctave),
        minFreq: Number(meta.minFreq),
      };
      if (meta.maxCoefficients !== undefined) params.maxCoefficients = Number(meta.maxCoefficients);
      const result = await analyseChannels(channels, Number(meta.sampleRate), params);
      return encodeFrame(resultToFrame(result));
    }
    case "detectOnsets": {
      const region =
        meta.regionStartSec !== undefined
          ? {
              startSec: Number(meta.regionStartSec),
              endSec: Number(meta.regionEndSec),
              odfMax: optionalNumber(meta.regionOdfMax),
              bandMax: arrays.regionBandMax ? asF32(arrays.regionBandMax, "regionBandMax") : undefined,
            }
          : undefined;
      const result = await detectOnsets(
        asF32(arrays.packed, "packed"),
        {
          numBands: Number(meta.numBands),
          numChannels: Number(meta.numChannels),
          numFrames: Number(meta.numFrames),
          bandOffsets: asU32(arrays.bandOffsets, "bandOffsets"),
          bandLengths: asU32(arrays.bandLengths, "bandLengths"),
          bandStepLog2s: asI32(arrays.bandStepLog2s, "bandStepLog2s"),
        },
        Number(meta.sampleRate),
        region,
      );
      return encodeFrame({
        meta: { odfMax: result.odfMax },
        arrays: { onsets: result.onsets, bandMax: result.bandMax },
      });
    }
    case "hpss": {
      const result = await hpss(
        asF32(arrays.packed, "packed"),
        {
          numBands: Number(meta.numBands),
          numChannels: Number(meta.numChannels),
          bandOffsets: asU32(arrays.bandOffsets, "bandOffsets"),
          bandLengths: asU32(arrays.bandLengths, "bandLengths"),
        },
        optionalNumber(meta.kernelH),
        optionalNumber(meta.kernelV),
      );
      return encodeFrame({ meta: {}, arrays: { harmonic: result.harmonic, percussive: result.percussive } });
    }
    case "nmf": {
      const result = await nmf(
        asF32(arrays.packed, "packed"),
        {
          numBands: Number(meta.numBands),
          numChannels: Number(meta.numChannels),
          bandOffsets: asU32(arrays.bandOffsets, "bandOffsets"),
          bandLengths: asU32(arrays.bandLengths, "bandLengths"),
        },
        Number(meta.numComponents),
        optionalNumber(meta.iterations),
        optionalNumber(meta.seed),
      );
      const parts: Record<string, NumericArray> = {};
      result.parts.forEach((part, i) => (parts[`part${i}`] = part));
      return encodeFrame({ meta: { numParts: result.parts.length }, arrays: parts });
    }
    case "mergeSpectrograms": {
      const parts = planarChannels(arrays, Number(meta.numParts), "part");
      const result = await mergeSpectrograms(parts, {
        numBands: Number(meta.numBands),
        numChannels: Number(meta.numChannels),
        bandOffsets: asU32(arrays.bandOffsets, "bandOffsets"),
        bandLengths: asU32(arrays.bandLengths, "bandLengths"),
      });
      return encodeFrame({ meta: {}, arrays: { merged: result.merged } });
    }
    case "aiSeparate": {
      const channels = planarChannels(arrays, Number(meta.numChannels));
      const stems = await aiSeparate(channels, Number(meta.sampleRate));
      const out: Record<string, NumericArray> = {};
      const outMeta: Record<string, number | string> = { stemNames: Object.keys(stems).join(",") };
      for (const [stem, stemChannels] of Object.entries(stems)) {
        outMeta[`${stem}Channels`] = stemChannels.length;
        stemChannels.forEach((channel, i) => (out[`${stem}${i}`] = channel));
      }
      return encodeFrame({ meta: outMeta, arrays: out });
    }
    case "isModelDownloaded":
      return encodeFrame({ meta: { downloaded: isModelDownloaded(String(meta.modelFile)) ? 1 : 0 }, arrays: {} });
    case "downloadModel": {
      const modelFile = String(meta.modelFile);
      if (!isModelDownloaded(modelFile)) {
        const progress = { downloaded: 0, total: 0, done: false };
        modelDownloads.set(modelFile, progress);
        try {
          await downloadModel(modelFile, (downloaded, total) => {
            progress.downloaded = downloaded;
            progress.total = total;
          });
        } finally {
          progress.done = true;
        }
      }
      return encodeFrame({ meta: {}, arrays: {} });
    }
    case "modelDownloadProgress": {
      const progress = modelDownloads.get(String(meta.modelFile));
      return encodeFrame({
        meta: {
          downloaded: progress?.downloaded ?? 0,
          total: progress?.total ?? 0,
          done: progress && !progress.done ? 0 : 1,
        },
        arrays: {},
      });
    }
    case "exportAudio": {
      const channels = planarChannels(arrays, Number(meta.numChannels));
      await exportAudio(channels, String(meta.outputPath), Number(meta.sampleRate), String(meta.format));
      return encodeFrame({ meta: {}, arrays: {} });
    }
    case "decodeAudio": {
      const channels = await decodeAudio(String(meta.inputPath), Number(meta.sampleRate), Number(meta.numChannels));
      return encodeFrame(framedChannels(channels));
    }
    case "copyAudioFile":
      await copyAudioFile(String(meta.sourcePath), String(meta.destPath));
      return encodeFrame({ meta: {}, arrays: {} });
    default:
      throw new Error(`analysis op: unknown op ${String(meta.op)}`);
  }
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
        Number(meta.baseCompact) === 1,
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
            Number(meta.baseCompact) === 1,
            arrays.tailPixelStarts
              ? {
                  pixelStarts: asU32(arrays.tailPixelStarts, "tailPixelStarts"),
                  pixelCounts: asU32(arrays.tailPixelCounts, "tailPixelCounts"),
                  offsets: asF32(arrays.tailOffsets, "tailOffsets"),
                  residuals: asU32(arrays.tailResiduals, "tailResiduals"),
                }
              : undefined,
          ),
        },
      });
    case "applyDelta":
      return encodeFrame({
        meta: {},
        arrays: { packed: await applyHistoryDelta(asF32(arrays.base, "base"), asU8(arrays.bytes, "bytes")) },
      });
    case "readDeltaTurns": {
      const turns = await readHistoryDeltaTurns(asU8(arrays.bytes, "bytes"));
      return encodeFrame({
        meta: { hasTurns: turns ? 1 : 0 },
        arrays: turns
          ? {
              tailPixelStarts: turns.pixelStarts,
              tailPixelCounts: turns.pixelCounts,
              tailOffsets: turns.offsets,
              tailResiduals: turns.residuals,
            }
          : {},
      });
    }
    case "applyDeltas": {
      const count = Number(meta.deltaCount);
      const deltas = Array.from({ length: count }, (_, i) => asU8(arrays[`delta${i}`], `delta${i}`));
      const inverts = String(meta.inverts)
        .split("")
        .map((flag) => flag === "1");
      const base = asF32(arrays.base, "base");
      return encodeFrame({
        meta: {},
        arrays: { packed: await applyHistoryDeltas(base, new Float32Array(base.length), deltas, inverts) },
      });
    }
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
