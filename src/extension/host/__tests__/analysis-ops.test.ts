import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, encodeFrame, type Frame, type NumericArray } from "../../shared/analysis-protocol";
import { runAnalysisOpFramed } from "../analysis-service";

// runAnalysisOpFramed marshals framed requests into the native analysis calls
// and their results back into frames. The native layer itself is exercised by
// the addon suite, so it is mocked here and only the marshaling is under test.

const native = vi.hoisted(() => ({
  analyseChannels: vi.fn(),
  detectOnsets: vi.fn(),
  hpss: vi.fn(),
  nmf: vi.fn(),
  mergeSpectrograms: vi.fn(),
  aiSeparate: vi.fn(),
  isModelDownloaded: vi.fn(),
  downloadModel: vi.fn(),
  exportAudio: vi.fn(),
  decodeAudio: vi.fn(),
  copyAudioFile: vi.fn(),
}));

vi.mock("../../../main/lib/audio-analysis", () => ({
  ...native,
  analyze: vi.fn(),
  synthesize: vi.fn(),
  commitStroke: vi.fn(),
  encodeHistorySnapshot: vi.fn(),
  decodeHistorySnapshot: vi.fn(),
  historyFootprintChanged: vi.fn(),
  encodeHistoryDelta: vi.fn(),
  applyHistoryDelta: vi.fn(),
  buildHistoryInverseMap: vi.fn(),
  getGpuMemoryInfo: vi.fn(() => ({ bytes: 0, unified: true })),
}));

async function runOp(meta: Record<string, number | string>, arrays: Record<string, NumericArray> = {}): Promise<Frame> {
  const framed = await runAnalysisOpFramed(encodeFrame({ meta, arrays }).buffer);
  return decodeFrame(framed.buffer as ArrayBuffer);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyseChannels op", () => {
  it("hands the planar channels and params to the analyser and frames its result", async () => {
    native.analyseChannels.mockResolvedValue({
      data: new Float32Array([1, 2]),
      inverseMap: new Float32Array([3]),
      metadata: new Float32Array([4]),
      bandOffsets: new Uint32Array([0]),
      bandStepLog2s: new Int32Array([-1]),
      bandLengths: new Uint32Array([2]),
      onsets: new Float32Array([0.5, 1]),
      onsetOdfMax: 7,
      onsetBandMax: new Float32Array([9]),
      textureWidth: 2,
      textureHeight: 1,
      numFrames: 2,
      numChannels: 2,
      numBands: 1,
      sampleRate: 48000,
      magnitudeEnergy: 1.5,
      format: "wav",
      codec: "pcm_f32le",
      channels: 2,
    });

    const result = await runOp(
      {
        op: "analyseChannels",
        numChannels: 2,
        sampleRate: 48000,
        bandsPerOctave: 36,
        minFreq: 20,
        maxCoefficients: 99,
      },
      { channel0: new Float32Array([0.1, 0.2]), channel1: new Float32Array([-0.1, -0.2]) },
    );

    expect(native.analyseChannels).toHaveBeenCalledTimes(1);
    const [channels, sampleRate, params] = native.analyseChannels.mock.calls[0] as [
      Float32Array[],
      number,
      Record<string, number>,
    ];
    expect(channels).toHaveLength(2);
    expect(Array.from(channels[1])).toEqual([Math.fround(-0.1), Math.fround(-0.2)]);
    expect(sampleRate).toBe(48000);
    expect(params).toEqual({ bandsPerOctave: 36, minFreq: 20, maxCoefficients: 99 });

    expect(result.meta.sampleRate).toBe(48000);
    expect(result.meta.onsetOdfMax).toBe(7);
    expect(Array.from(result.arrays.data)).toEqual([1, 2]);
    expect(Array.from(result.arrays.onsetBandMax)).toEqual([9]);
  });
});

describe("detectOnsets op", () => {
  const layoutMeta = { numBands: 2, numChannels: 1, numFrames: 4, sampleRate: 44100 };
  const layoutArrays = {
    packed: new Float32Array([1, 2, 3, 4]),
    bandOffsets: new Uint32Array([0, 2]),
    bandLengths: new Uint32Array([2, 2]),
    bandStepLog2s: new Int32Array([0, 1]),
  };

  it("runs a whole-file pass when no region is framed", async () => {
    native.detectOnsets.mockResolvedValue({
      onsets: new Float32Array([0.5, 1]),
      odfMax: 3,
      bandMax: new Float32Array([1, 2]),
    });
    const result = await runOp({ op: "detectOnsets", ...layoutMeta }, layoutArrays);

    const [packed, layout, sampleRate, region] = native.detectOnsets.mock.calls[0] as [
      Float32Array,
      { numBands: number; bandStepLog2s: Int32Array },
      number,
      unknown,
    ];
    expect(Array.from(packed)).toEqual([1, 2, 3, 4]);
    expect(layout.numBands).toBe(2);
    expect(Array.from(layout.bandStepLog2s)).toEqual([0, 1]);
    expect(sampleRate).toBe(44100);
    expect(region).toBeUndefined();
    expect(result.meta.odfMax).toBe(3);
    expect(Array.from(result.arrays.onsets)).toEqual([0.5, 1]);
  });

  it("carries a region and its reference through", async () => {
    native.detectOnsets.mockResolvedValue({ onsets: new Float32Array(), odfMax: 0, bandMax: new Float32Array() });
    await runOp(
      { op: "detectOnsets", ...layoutMeta, regionStartSec: 1.5, regionEndSec: 2.5, regionOdfMax: 8 },
      { ...layoutArrays, regionBandMax: new Float32Array([4, 5]) },
    );

    const region = native.detectOnsets.mock.calls[0][3] as {
      startSec: number;
      endSec: number;
      odfMax?: number;
      bandMax?: Float32Array;
    };
    expect(region.startSec).toBe(1.5);
    expect(region.endSec).toBe(2.5);
    expect(region.odfMax).toBe(8);
    expect(Array.from(region.bandMax ?? [])).toEqual([4, 5]);
  });
});

describe("split and merge ops", () => {
  const layoutMeta = { numBands: 1, numChannels: 1 };
  const layoutArrays = { bandOffsets: new Uint32Array([0]), bandLengths: new Uint32Array([2]) };

  it("hpss leaves omitted kernels to the native defaults", async () => {
    native.hpss.mockResolvedValue({ harmonic: new Float32Array([1]), percussive: new Float32Array([2]) });
    const result = await runOp({ op: "hpss", ...layoutMeta }, { ...layoutArrays, packed: new Float32Array([9, 8]) });

    const [, , kernelH, kernelV] = native.hpss.mock.calls[0] as [Float32Array, unknown, number?, number?];
    expect(kernelH).toBeUndefined();
    expect(kernelV).toBeUndefined();
    expect(Array.from(result.arrays.harmonic)).toEqual([1]);
    expect(Array.from(result.arrays.percussive)).toEqual([2]);
  });

  it("nmf frames each part it gets back", async () => {
    native.nmf.mockResolvedValue({ parts: [new Float32Array([1]), new Float32Array([2])] });
    const result = await runOp(
      { op: "nmf", ...layoutMeta, numComponents: 2, iterations: 50, seed: 3 },
      { ...layoutArrays, packed: new Float32Array([9]) },
    );

    const [, , numComponents, iterations, seed] = native.nmf.mock.calls[0] as [
      Float32Array,
      unknown,
      number,
      number?,
      number?,
    ];
    expect([numComponents, iterations, seed]).toEqual([2, 50, 3]);
    expect(result.meta.numParts).toBe(2);
    expect(Array.from(result.arrays.part1)).toEqual([2]);
  });

  it("mergeSpectrograms gathers the framed parts back into an array", async () => {
    native.mergeSpectrograms.mockResolvedValue({ merged: new Float32Array([5]) });
    const result = await runOp(
      { op: "mergeSpectrograms", ...layoutMeta, numParts: 2 },
      { ...layoutArrays, part0: new Float32Array([1]), part1: new Float32Array([2]) },
    );

    const [parts] = native.mergeSpectrograms.mock.calls[0] as [Float32Array[]];
    expect(parts).toHaveLength(2);
    expect(Array.from(parts[1])).toEqual([2]);
    expect(Array.from(result.arrays.merged)).toEqual([5]);
  });
});

describe("aiSeparate op", () => {
  it("frames every stem with its channel count", async () => {
    native.aiSeparate.mockResolvedValue({
      drums: [new Float32Array([1])],
      bass: [new Float32Array([2]), new Float32Array([3])],
    });
    const result = await runOp(
      { op: "aiSeparate", numChannels: 1, sampleRate: 44100 },
      { channel0: new Float32Array([0.5]) },
    );

    expect(native.aiSeparate).toHaveBeenCalledTimes(1);
    expect(result.meta.stemNames).toBe("drums,bass");
    expect(result.meta.drumsChannels).toBe(1);
    expect(result.meta.bassChannels).toBe(2);
    expect(Array.from(result.arrays.bass1)).toEqual([3]);
  });
});

describe("model ops", () => {
  it("skips the download when the model is already on disk", async () => {
    native.isModelDownloaded.mockReturnValue(true);
    await runOp({ op: "downloadModel", modelFile: "htdemucs.onnx" });
    expect(native.downloadModel).not.toHaveBeenCalled();
  });

  it("downloads a missing model and reports the finished progress", async () => {
    native.isModelDownloaded.mockReturnValue(false);
    native.downloadModel.mockImplementation(
      async (_modelFile: string, onProgress?: (downloaded: number, total: number) => void) => {
        onProgress?.(10, 100);
      },
    );
    await runOp({ op: "downloadModel", modelFile: "htdemucs.onnx" });
    expect(native.downloadModel).toHaveBeenCalledTimes(1);

    const progress = await runOp({ op: "modelDownloadProgress", modelFile: "htdemucs.onnx" });
    expect(progress.meta).toEqual({ downloaded: 10, total: 100, done: 1 });
  });

  it("answers isModelDownloaded from the cache check", async () => {
    native.isModelDownloaded.mockReturnValue(true);
    const result = await runOp({ op: "isModelDownloaded", modelFile: "htdemucs.onnx" });
    expect(result.meta.downloaded).toBe(1);
  });
});

describe("audio file ops", () => {
  it("exportAudio hands channels, path, rate and format through", async () => {
    native.exportAudio.mockResolvedValue(undefined);
    await runOp(
      { op: "exportAudio", numChannels: 2, outputPath: "/tmp/out.wav", sampleRate: 44100, format: "wav" },
      { channel0: new Float32Array([1]), channel1: new Float32Array([2]) },
    );

    const [channels, outputPath, sampleRate, format] = native.exportAudio.mock.calls[0] as [
      Float32Array[],
      string,
      number,
      string,
    ];
    expect(channels).toHaveLength(2);
    expect(Array.from(channels[0])).toEqual([1]);
    expect([outputPath, sampleRate, format]).toEqual(["/tmp/out.wav", 44100, "wav"]);
  });

  it("decodeAudio frames the decoded channels", async () => {
    native.decodeAudio.mockResolvedValue([new Float32Array([1]), new Float32Array([2])]);
    const result = await runOp({ op: "decodeAudio", inputPath: "/tmp/in.wav", sampleRate: 44100, numChannels: 2 });

    expect(native.decodeAudio).toHaveBeenCalledWith("/tmp/in.wav", 44100, 2);
    expect(result.meta.numChannels).toBe(2);
    expect(Array.from(result.arrays.channel1)).toEqual([2]);
  });

  it("copyAudioFile hands both paths through", async () => {
    native.copyAudioFile.mockResolvedValue(undefined);
    await runOp({ op: "copyAudioFile", sourcePath: "/a.wav", destPath: "/b.wav" });
    expect(native.copyAudioFile).toHaveBeenCalledWith("/a.wav", "/b.wav");
  });

  it("rejects an unknown op", async () => {
    await expect(runOp({ op: "nope" })).rejects.toThrow("unknown op nope");
  });
});
