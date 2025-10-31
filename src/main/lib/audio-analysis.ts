import { join } from "path";
import { decodeAudioFile, encodeBufferToAudioFile, probeAudioFile } from "./ffmpeg";
import type { AnalysisParams, GaboratorAnalysisResult } from "./types";

let gaborator: any = null;

export const allowedExtensions = ["wav", "mp3", "ogg", "flac", "m4a", "aac", "wma", "aiff", "ape", "wv", "mka"];

export function getGaboratorPath(): string {
  // Check if we're running from an asar archive (packaged app)
  const isPackaged = __dirname.includes("app.asar");

  if (isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node");
  } else {
    // In development, __dirname will be something like .../out/preload or .../out/main
    // We need to go up to the project root and then to build/Release
    return join(__dirname, "../../build/Release/gaborator_addon.node");
  }
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

export async function analyze(filePath: string, params: AnalysisParams) {
  const gab = init();

  const { sampleRate, channels, format, codec } = await probeAudioFile(filePath);

  if (!allowedExtensions.includes(format.toLowerCase())) {
    throw new Error(`Unsupported file format: ${format}`);
  }

  const audioBuffer = await decodeAudioFile(filePath, sampleRate, channels);

  const analysisResult: GaboratorAnalysisResult = await gab.analyze(audioBuffer, channels, sampleRate, params);

  return {
    ...analysisResult,
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

  // Interleave the audio channels into a single Float32Array
  const audioVector = new Float32Array(channels * length);

  for (let channel = 0; channel < channels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      audioVector[i * channels + channel] = channelData[i];
    }
  }

  const analysisResult: GaboratorAnalysisResult = await gab.analyze(audioVector, channels, sampleRate, params);

  return {
    ...analysisResult,
    sampleRate,
    format: "wav", // AudioBuffer is always PCM data
    codec: "pcm_f32le", // AudioBuffer uses 32-bit float PCM
    channels,
  };
}

export async function synthesize(
  processedData: Float32Array,
  analysisMetadata: any,
  sampleRate: number,
  params: AnalysisParams,
  normalize: boolean,
): Promise<Float32Array[]> {
  const gab = init();

  return await gab.synthesize(processedData, analysisMetadata, sampleRate, params, normalize);
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
