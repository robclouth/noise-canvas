import { app, BrowserWindow, dialog } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { Readable, Writable } from "stream";
import { ipcMainHandle, ipcMainOn, webContentsSend } from "./ipc-typed";
import type { AnalysisPayloadForRenderer, GaboratorAnalysisResult, GaboratorParams } from "./types";

let gaborator;
let currentSampleRate = 44100;
let currentFilePath: string | null = null;
let currentChannels = 2;
let currentMetadata: {
  format: string;
  codec: string;
} | null = null;

export function setupAudio() {
  // Load the native addon
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

export function saveAudioFile(window: BrowserWindow) {
  if (!currentFilePath) {
    dialog.showErrorBox("Cannot Save", "No file is currently open.");
    return;
  }
  webContentsSend(window, "request-audio-for-saving");
}

export function analyzeAudio(filePath: string, params: GaboratorParams): Promise<AnalysisPayloadForRenderer> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const audioStreamInfo = metadata.streams.find((s) => s.codec_type === "audio");
      if (!audioStreamInfo || !audioStreamInfo.sample_rate) {
        return reject(new Error("Could not determine sample rate from audio file."));
      }

      currentMetadata = {
        format: metadata.format.format_name?.split(",")[0] || "wav",
        codec: audioStreamInfo.codec_name || "pcm_s32le",
      };

      const sampleRate = audioStreamInfo.sample_rate;
      currentSampleRate = sampleRate;
      const channels = audioStreamInfo.channels || 1;
      currentChannels = channels;

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
  ipcMainHandle("open-file-and-analyze", async (_event, params) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"] }],
    });
    if (canceled || filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = filePaths[0];
    currentFilePath = filePath;

    try {
      const payload = await analyzeAudio(filePath, params);
      webContentsSend(window, "analysis-complete", payload);
      return { canceled: false };
    } catch (error) {
      console.error("Analysis failed:", error);
      webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
      throw error; // re-throw to be caught in renderer
    }
  });

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

  ipcMainHandle("save-audio-data", async (_, payload, params, normalize) => {
    if (!currentFilePath) {
      throw new Error("No file path specified for saving.");
    }

    const processedDataArray = new Float32Array(
      payload.processedData.buffer,
      payload.processedData.byteOffset,
      payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    const audioVector: Float32Array = gaborator.synthesize(
      processedDataArray,
      payload.analysisMetadata,
      currentSampleRate,
      params,
      normalize,
    );

    const readable = new Readable();
    readable._read = () => {}; // _read is required but we push data manually
    readable.push(Buffer.from(audioVector.buffer));
    readable.push(null);

    return new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(readable)
        .inputFormat("f32le")
        .inputOptions([`-ar ${currentSampleRate}`, `-ac ${currentChannels}`])
        .audioCodec(currentMetadata?.codec || "pcm_s32le")
        .toFormat(currentMetadata?.format || "wav")
        .on("error", (err) => {
          console.error("Error saving file:", err);
          reject(err);
        })
        .on("end", () => {
          console.log("File saved successfully");
          resolve();
        })
        .save(currentFilePath!);
    });
  });

  ipcMainOn("load-file", async (_, filePath, params) => {
    currentFilePath = filePath;

    try {
      const payload = await analyzeAudio(filePath, params);
      webContentsSend(window, "analysis-complete", payload);
    } catch (error) {
      console.error("Analysis failed:", error);
      webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
    }
  });
}
