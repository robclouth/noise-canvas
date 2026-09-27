import { existsSync, readFileSync } from "fs";
import { downloadModelFile, getModelPath } from "./ai-separation";
import { floatOutputPatch, functionPatch } from "./sa3-codec-patch";
import { createTokenizer, parseSentencePieceModel } from "./sa3-tokenizer";
import type { AnalysisParams, GaboratorAnalysisResult } from "./types";

/** The rate Generate's model works at; callers resample to and from it. */
export const GENERATE_SAMPLE_RATE = 44100;
/** The longest clip the model takes in one run, in seconds. */
export const GENERATE_MAX_SECONDS = 380;
/** Sampler steps per run. */
export const GENERATE_STEPS = 8;

const CHUNK_SECONDS = 360;
const CHUNK_OVERLAP_SECONDS = 4;
const LEVEL_MATCH_LIMIT_DB = 12;

const MODEL_DIR = "stable-audio-3-medium";
/** Pinned to the revision the codec patch was checked against. */
const REPO =
  "https://huggingface.co/stabilityai/stable-audio-3-optimized/resolve/da6edc54ddba10bfd79a077102ded687f80e882b";

type ModelFile = { file: string; path: string; bytes: number; patch?: () => Uint8Array };

/** Everything Generate downloads, with the bytes appended to the codec files. */
const MODEL_FILES: ModelFile[] = [
  { file: "tokenizer.model", path: "tokenizer.model", bytes: 4241003 },
  { file: "text.onnx", path: "onnx/t5gemma/encoder.onnx", bytes: 620393530 },
  { file: "dit_fp16.onnx", path: "onnx/sa3-m/dit_fp16.onnx", bytes: 4245500 },
  { file: "dit_fp16.onnx.data", path: "onnx/sa3-m/dit_fp16.onnx.data", bytes: 2906724352 },
  { file: "encoder.onnx", path: "onnx/same-l/enc_fp16.onnx", bytes: 1192471389, patch: functionPatch },
  {
    file: "decoder.onnx",
    path: "onnx/same-l/dec_fp16.onnx",
    bytes: 1192532027,
    patch: () => {
      const fn = functionPatch();
      const output = floatOutputPatch();
      const joined = new Uint8Array(fn.length + output.length);
      joined.set(fn);
      joined.set(output, fn.length);
      return joined;
    },
  },
];

const modelPath = (file: string): string => getModelPath(`${MODEL_DIR}/${file}`);

type GenerateAddon = {
  generate?: (
    request: {
      models: { text: string; encoder: string; dit: string; decoder: string };
      tokens: Int32Array;
      context: Float32Array[];
      restyle: boolean;
      sigmas: Float32Array;
      span?: [number, number];
      seed: number;
    },
    onProgress?: (step: number, steps: number) => void,
  ) => Promise<Float32Array[]>;
  generateRelease?: () => void;
  onnxUsesGpu?: () => boolean;
  aiSeparationAvailable?: () => boolean;
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: AnalysisParams,
  ) => Promise<GaboratorAnalysisResult>;
  synthesize: (
    data: Float32Array,
    analysis: GaboratorAnalysisResult,
    sampleRate: number,
    params: AnalysisParams,
    applyLimiter: boolean,
    existingAudio: Float32Array[],
  ) => Promise<{ channels: Float32Array[] }>;
};

let addon: () => GenerateAddon = () => {
  throw new Error("The native addon is not set");
};

/** Points Generate at the loaded native addon. */
export function setGenerateAddon(load: () => GenerateAddon): void {
  addon = load;
}

/** True when Generate can run here: the addon has it and ONNX Runtime opens. */
export function generateAvailable(): boolean {
  const gab = addon();
  return typeof gab.generate === "function" && (gab.aiSeparationAvailable?.() ?? true);
}

/** True when ONNX Runtime runs on the GPU through WebGPU, false when on the CPU. */
export function onnxUsesGpu(): boolean {
  return addon().onnxUsesGpu?.() ?? false;
}

export function isGenerateModelDownloaded(): boolean {
  return MODEL_FILES.every(({ file }) => existsSync(modelPath(file)));
}

/** Downloads the files Generate still lacks, reporting bytes across all of them. */
export async function downloadGenerateModel(onProgress?: (downloaded: number, total: number) => void): Promise<void> {
  const missing = MODEL_FILES.filter(({ file }) => !existsSync(modelPath(file)));
  const total = missing.reduce((sum, { bytes }) => sum + bytes, 0);
  let done = 0;
  for (const entry of missing) {
    await downloadModelFile(
      `${MODEL_DIR}/${entry.file}`,
      `${REPO}/${entry.path}`,
      (downloaded) => onProgress?.(done + downloaded, total),
      entry.patch?.(),
    );
    done += entry.bytes;
  }
}

/** Frees the model's memory; the next Generate loads it again. */
export function releaseGenerateModels(): void {
  addon().generateRelease?.();
}

let tokenizer: ((text: string) => number[]) | null = null;

function tokenize(prompt: string): Int32Array {
  tokenizer ??= createTokenizer(parseSentencePieceModel(new Uint8Array(readFileSync(modelPath("tokenizer.model")))));
  return Int32Array.from(tokenizer(prompt).slice(0, 256));
}

/**
 * The sampler's noise levels for `steps` steps, falling to 0. `strength` is
 * the share of the model's log-SNR schedule that runs: the last `strength` of
 * it, so at 1 the whole schedule from pure noise.
 */
export function generateSchedule(strength: number, steps = GENERATE_STEPS): Float32Array {
  const anchor = -6.2;
  const end = 2.0;
  const start = Math.min(1, strength);
  const sigmas = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = start * (1 - i / steps);
    sigmas[i] = 1 / (1 + Math.exp(end - t * (end - anchor)));
  }
  if (strength >= 1) sigmas[0] = 1;
  sigmas[steps] = 0;
  return sigmas;
}

/** A Generate request over 44.1 kHz stereo audio. */
export type GenerateRequest = {
  prompt: string;
  context: Float32Array[];
  /**
   * 0 to 1. At 1 the span in `fill` is regenerated from the audio around it;
   * below 1 the whole context is restyled starting from itself.
   */
  strength: number;
  /** The seconds a strength-1 run regenerates; the rest of the context is kept. */
  fill?: [number, number];
  seed?: number;
};

/** Seconds [start, end) of each run a clip of `seconds` is cut into, overlapping at the seams. */
export function generateChunks(seconds: number): [number, number][] {
  if (seconds <= GENERATE_MAX_SECONDS) return [[0, seconds]];
  const count = Math.ceil((seconds - CHUNK_OVERLAP_SECONDS) / (CHUNK_SECONDS - CHUNK_OVERLAP_SECONDS));
  const stride = (seconds - CHUNK_OVERLAP_SECONDS) / count;
  return Array.from({ length: count }, (_, i) => [
    i * stride,
    Math.min(seconds, i * stride + stride + CHUNK_OVERLAP_SECONDS),
  ]);
}

/**
 * Runs the model over `request.context` and returns audio of the same length.
 * A clip longer than the model's limit runs in overlapping chunks that
 * crossfade into one another. `onProgress` reports steps done out of the
 * total: 0 once the model is loaded, and the total when only decoding is left.
 */
export async function generate(
  request: GenerateRequest,
  onProgress?: (step: number, steps: number) => void,
): Promise<Float32Array[]> {
  const gab = addon();
  if (!gab.generate) throw new Error("Generate is not available on this system.");
  const context = request.context.length === 1 ? [request.context[0], request.context[0]] : request.context;
  const length = context[0].length;
  const tokens = tokenize(request.prompt);
  const sigmas = generateSchedule(Math.min(1, Math.max(0.01, request.strength)));
  const models = {
    text: modelPath("text.onnx"),
    encoder: modelPath("encoder.onnx"),
    dit: modelPath("dit_fp16.onnx"),
    decoder: modelPath("decoder.onnx"),
  };
  const baseSeed = request.seed ?? Math.floor(Math.random() * 2 ** 31);
  const chunks = generateChunks(length / GENERATE_SAMPLE_RATE);
  const out = [new Float32Array(length), new Float32Array(length)];
  const weight = new Float32Array(length);
  const fade = Math.round(CHUNK_OVERLAP_SECONDS * GENERATE_SAMPLE_RATE);

  for (let c = 0; c < chunks.length; c++) {
    const from = Math.round(chunks[c][0] * GENERATE_SAMPLE_RATE);
    const to = Math.min(length, Math.round(chunks[c][1] * GENERATE_SAMPLE_RATE));
    const piece = context.map((channel) => channel.subarray(from, to));
    const fill = request.strength >= 1 ? request.fill : undefined;
    const span = fill ? clipSpan(fill, from / GENERATE_SAMPLE_RATE, to / GENERATE_SAMPLE_RATE) : undefined;
    if (fill && !span) {
      for (let ch = 0; ch < 2; ch++) accumulate(out[ch], piece[ch], from, 1);
      for (let i = from; i < to; i++) weight[i] += 1;
      continue;
    }
    const take = await gab.generate(
      {
        models,
        tokens,
        context: piece,
        restyle: request.strength < 1,
        sigmas,
        span,
        seed: baseSeed + c,
      },
      (step, steps) => onProgress?.(c * steps + step + 1, chunks.length * steps),
    );
    for (let i = 0; i < to - from; i++) {
      const rise = c > 0 ? Math.min(1, (i + 1) / fade) : 1;
      const fall = c < chunks.length - 1 ? Math.min(1, (to - from - i) / fade) : 1;
      const w = Math.min(rise, fall);
      out[0][from + i] += take[0][i] * w;
      out[1][from + i] += take[1][i] * w;
      weight[from + i] += w;
    }
  }
  for (let i = 0; i < length; i++) {
    if (weight[i] > 0) {
      out[0][i] /= weight[i];
      out[1][i] /= weight[i];
    }
  }
  return request.context.length === 1 ? [Float32Array.from(out[0], (v, i) => (v + out[1][i]) / 2)] : out;
}

function clipSpan(fill: [number, number], from: number, to: number): [number, number] | undefined {
  const start = Math.max(fill[0], from) - from;
  const end = Math.min(fill[1], to) - from;
  return end > start ? [start, end] : undefined;
}

function accumulate(target: Float32Array, source: Float32Array, offset: number, gain: number): void {
  for (let i = 0; i < source.length; i++) target[offset + i] += source[i] * gain;
}

/** A band of frequencies in Hz, over seconds [start, end) or the whole clip. */
export type BandRegion = { loHz: number; hiHz: number; start?: number; end?: number };

function inRegion(region: BandRegion, freq: number, time: number): boolean {
  if (freq < region.loHz || freq > region.hiHz) return false;
  return region.start === undefined || region.end === undefined || (time >= region.start && time < region.end);
}

/** Calls `visit` with each coefficient's pixel, band frequency and time. */
function eachCoefficient(
  analysis: GaboratorAnalysisResult,
  sampleRate: number,
  visit: (pixel: number, freq: number, time: number) => void,
): void {
  for (let band = 0; band < analysis.numBands; band++) {
    const offset = analysis.bandOffsets[band];
    const step = 2 ** analysis.bandStepLog2s[band];
    const freq = analysis.metadata[band * 4 + 3];
    for (let i = 0; i < analysis.bandLengths[band]; i++) visit(offset + i, freq, (i * step) / sampleRate);
  }
}

/** `channels` with only the coefficients inside `region` kept. */
export async function bandLimit(
  channels: Float32Array[],
  sampleRate: number,
  params: AnalysisParams,
  region: BandRegion,
): Promise<Float32Array[]> {
  const gab = addon();
  const analysis = await gab.analyze(channels, channels.length, sampleRate, params);
  const data = new Float32Array(analysis.data);
  eachCoefficient(analysis, sampleRate, (pixel, freq, time) => {
    if (inRegion(region, freq, time)) return;
    data[pixel * 4] = 0;
    data[pixel * 4 + 2] = 0;
  });
  const { channels: out } = await gab.synthesize(data, analysis, sampleRate, params, false, []);
  return out.map((channel) => channel.slice(0, channels[0].length));
}

/**
 * `take` scaled so its energy inside `region` matches `reference`'s there,
 * within ±12 dB.
 */
export async function matchLevel(
  take: Float32Array[],
  reference: Float32Array[],
  sampleRate: number,
  params: AnalysisParams,
  region: BandRegion,
): Promise<Float32Array[]> {
  const gab = addon();
  const energy = async (channels: Float32Array[]): Promise<number> => {
    const analysis = await gab.analyze(channels, channels.length, sampleRate, params);
    let sum = 0;
    eachCoefficient(analysis, sampleRate, (pixel, freq, time) => {
      if (inRegion(region, freq, time)) sum += analysis.data[pixel * 4] ** 2 + analysis.data[pixel * 4 + 2] ** 2;
    });
    return sum;
  };
  const [takeEnergy, referenceEnergy] = [await energy(take), await energy(reference)];
  if (takeEnergy <= 0 || referenceEnergy <= 0) return take;
  const db = Math.max(
    -LEVEL_MATCH_LIMIT_DB,
    Math.min(LEVEL_MATCH_LIMIT_DB, 10 * Math.log10(referenceEnergy / takeEnergy)),
  );
  const gain = 10 ** (db / 20);
  return take.map((channel) => Float32Array.from(channel, (v) => v * gain));
}
