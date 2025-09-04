import { app, BrowserWindow, dialog } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { Writable } from "stream";
import { ipcMainHandle, ipcMainOn, webContentsSend } from "./ipc-typed";
import type { AnalysisPayloadForRenderer, GaboratorAnalysisResult, GaboratorParams } from "./types";

let gaborator;
let currentSampleRate = 44100;

export function setupAudio() {
  // Load the native addon
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const gaboratorPath = app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node")
    : join(__dirname, "../../build/Release/gaborator_addon.node");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  gaborator = require(gaboratorPath);

  const correctFfmpegPath = app.isPackaged ? ffmpegPath!.replace("app.asar", "app.asar.unpacked") : ffmpegPath!;
  const correctFfprobePath = app.isPackaged
    ? ffprobePath.path.replace("app.asar", "app.asar.unpacked")
    : ffprobePath.path;
  ffmpeg.setFfmpegPath(correctFfmpegPath);
  ffmpeg.setFfprobePath(correctFfprobePath);
}

export async function openAndAnalyzeAudioFile(window: BrowserWindow) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"] }],
  });
  if (canceled || filePaths.length === 0) {
    return;
  }

  const filePath = filePaths[0];

  const params = {
    bandsPerOctave: 48,
    fmin: 20.0,
  };

  try {
    const payload = await analyzeAudio(filePath, params);
    webContentsSend(window, "analysis-complete", payload);
  } catch (error) {
    console.error("Analysis failed:", error);
    webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
  }
}

export function analyzeAudio(filePath: string, params: GaboratorParams): Promise<AnalysisPayloadForRenderer> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const audioStreamInfo = metadata.streams.find((s) => s.codec_type === "audio");
      if (!audioStreamInfo || !audioStreamInfo.sample_rate) {
        return reject(new Error("Could not determine sample rate from audio file."));
      }

      const sampleRate = audioStreamInfo.sample_rate;
      currentSampleRate = sampleRate;
      const channels = audioStreamInfo.channels || 1;

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
          try {
            const concatenatedBuffer = Buffer.concat(audioChunks);
            const audioVector = new Float32Array(
              concatenatedBuffer.buffer,
              concatenatedBuffer.byteOffset,
              concatenatedBuffer.length / Float32Array.BYTES_PER_ELEMENT,
            );

            const analysisResult: GaboratorAnalysisResult = gaborator.analyze(
              audioVector,
              channels,
              sampleRate,
              params,
            );

            const payload: AnalysisPayloadForRenderer = {
              ...analysisResult,
              sampleRate,
              data: Buffer.from(analysisResult.data.buffer),
              inverseMap: Buffer.from(analysisResult.inverseMap.buffer),
              metadataTexture: Buffer.from(analysisResult.metadataTexture.buffer),
            };

            resolve(payload);
          } catch (e) {
            reject(e);
          }
        });
    });
  });
}

export function registerAudioIpcHandlers(window: BrowserWindow) {
  ipcMainHandle("synthesize-audio", async (_, payload, params, normalize) => {
    const processedDataArray = new Float32Array(
      payload.processedData.buffer,
      payload.processedData.byteOffset,
      payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    const audioVector = gaborator.synthesize(
      processedDataArray,
      payload.analysisMetadata,
      currentSampleRate,
      params,
      normalize,
    );
    return audioVector;
  });

  ipcMainOn("load-file", async (_, filePath) => {
    const params = {
      bandsPerOctave: 48,
      fmin: 20.0,
    };

    try {
      const payload = await analyzeAudio(filePath, params);
      webContentsSend(window, "analysis-complete", payload);
    } catch (error) {
      console.error("Analysis failed:", error);
      webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
    }
  });
}
