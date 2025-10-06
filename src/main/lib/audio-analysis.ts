// Direct access module for gaborator - to be used from renderer with nodeIntegration
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
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

  const audioVector = new Float32Array(
    concatenatedBuffer.buffer,
    concatenatedBuffer.byteOffset,
    concatenatedBuffer.length / Float32Array.BYTES_PER_ELEMENT,
  );

  const analysisResult: GaboratorAnalysisResult = await gab.analyze(audioVector, channels, sampleRate, params);

  return {
    ...analysisResult,
    sampleRate,
    format,
    codec,
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
