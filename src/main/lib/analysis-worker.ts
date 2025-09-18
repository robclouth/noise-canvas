import { parentPort, workerData } from "worker_threads";
import ffmpeg from "fluent-ffmpeg";
import { Writable } from "stream";
import type { GaboratorAnalysisResult, GaboratorParams } from "./types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaborator = require(workerData.gaboratorPath);
ffmpeg.setFfmpegPath(workerData.ffmpegPath);
ffmpeg.setFfprobePath(workerData.ffprobePath);

if (!parentPort) {
  throw new Error("This script must be run as a worker thread.");
}

async function analyzeAudio(filePath: string, params: GaboratorParams) {
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

  const analysisResult: GaboratorAnalysisResult = await gaborator.analyze(audioVector, channels, sampleRate, params);

  return {
    ...analysisResult,
    sampleRate,
    format,
    codec,
    channels,
  };
}

parentPort.on("message", async (args) => {
  try {
    const { filePath, params } = args;
    const result = await analyzeAudio(filePath, params);
    parentPort!.postMessage({ result });
  } catch (error) {
    parentPort!.postMessage({ error });
  }
});
