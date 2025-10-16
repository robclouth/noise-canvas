// Direct access module for gaborator - to be used from renderer with nodeIntegration
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Writable } from "stream";
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

export function setupFfmpeg() {
  const isPackaged = __dirname.includes("app.asar");
  const correctFfmpegPath = isPackaged ? ffmpegPath!.replace("app.asar", "app.asar.unpacked") : ffmpegPath!;
  const correctFfprobePath = isPackaged ? ffprobePath.path.replace("app.asar", "app.asar.unpacked") : ffprobePath.path;
  ffmpeg.setFfmpegPath(correctFfmpegPath);
  ffmpeg.setFfprobePath(correctFfprobePath);
}

export async function analyze(filePath: string, params: AnalysisParams) {
  const gab = init();
  setupFfmpeg();

  const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

  const audioStreamInfo = metadata.streams.find((s) => s.codec_type === "audio");
  if (!audioStreamInfo || !audioStreamInfo.sample_rate) {
    throw new Error("Could not determine sample rate from audio file.");
  }

  const format = metadata.format.format_name?.split(",")[0] || "wav";
  const codec = audioStreamInfo.codec_name || "pcm_s32le";
  const sampleRate = audioStreamInfo.sample_rate;
  const channels = audioStreamInfo.channels || 1;

  if (!allowedExtensions.includes(format.toLowerCase())) {
    throw new Error(`Unsupported file format: ${format}`);
  }

  const concatenatedBuffer = await new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    ffmpeg(filePath)
      .toFormat("f32le")
      .audioChannels(channels)
      .audioFrequency(sampleRate)
      .on("error", (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .stream(
        new Writable({
          write(chunk, _encoding, callback) {
            audioChunks.push(chunk);
            callback();
          },
        }),
      )
      .on("finish", () => {
        resolve(Buffer.concat(audioChunks));
      });
  });

  const audioBuffer = new Float32Array(
    concatenatedBuffer.buffer,
    concatenatedBuffer.byteOffset,
    concatenatedBuffer.length / Float32Array.BYTES_PER_ELEMENT,
  );

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
  for (let i = 0; i < processedData.length; i++) {
    if (isNaN(processedData[i]) || !isFinite(processedData[i])) {
      throw new Error(`Invalid value in processed data at index ${i}: ${processedData[i]}`);
    }
  }
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
  setupFfmpeg();

  const numChannels = audioChannels.length;
  const numFrames = audioChannels[0].length;

  // Interleave channels into a single buffer
  const interleavedBuffer = Buffer.allocUnsafe(numChannels * numFrames * 4); // 4 bytes per float32
  const interleavedView = new Float32Array(
    interleavedBuffer.buffer,
    interleavedBuffer.byteOffset,
    numChannels * numFrames,
  );

  for (let frame = 0; frame < numFrames; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      interleavedView[frame * numChannels + channel] = audioChannels[channel][frame];
    }
  }

  // Write to a temporary raw file first, then convert with ffmpeg
  const tempFile = join(tmpdir(), `audio-export-${Date.now()}.raw`);

  return new Promise<void>((resolve, reject) => {
    try {
      // Write interleaved buffer to temp file
      writeFileSync(tempFile, interleavedBuffer);

      // Convert temp file to output format
      ffmpeg(tempFile)
        .inputFormat("f32le")
        .inputOptions([`-ar ${sampleRate}`, `-ac ${numChannels}`])
        .audioCodec(format === "wav" ? "pcm_f32le" : format === "flac" ? "flac" : "libmp3lame")
        .toFormat(format)
        .on("error", (err) => {
          try {
            unlinkSync(tempFile);
          } catch {
            // Ignore cleanup errors
          }
          reject(new Error(`FFmpeg export error: ${err.message}`));
        })
        .on("end", () => {
          try {
            unlinkSync(tempFile);
          } catch {
            // Ignore cleanup errors
          }
          resolve();
        })
        .save(outputPath);
    } catch (error) {
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      reject(error);
    }
  });
}
