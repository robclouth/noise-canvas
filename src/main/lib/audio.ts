import { app, BrowserWindow, dialog } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { Readable } from "stream";
import { Worker } from "worker_threads";
import { ipcMainHandle, ipcMainOn, webContentsSend } from "./ipc-typed";
import type { AnalysisPayloadForRenderer, GaboratorAnalysisResult, GaboratorParams } from "./types";

const gaboratorPath = app.isPackaged
  ? join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node")
  : join(__dirname, "../../build/Release/gaborator_addon.node");

let currentSampleRate = 44100;
let currentFilePath: string | null = null;
let currentChannels = 2;
let currentMetadata: {
  format: string;
  codec: string;
} | null = null;

export function setupAudio() {
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

function runAnalysisInWorker(filePath: string, params: GaboratorParams): Promise<AnalysisPayloadForRenderer> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, "analysis-worker.js");
    const correctFfmpegPath = app.isPackaged ? ffmpegPath!.replace("app.asar", "app.asar.unpacked") : ffmpegPath!;
    const correctFfprobePath = app.isPackaged
      ? ffprobePath.path.replace("app.asar", "app.asar.unpacked")
      : ffprobePath.path;

    const worker = new Worker(workerPath, {
      workerData: { gaboratorPath, ffmpegPath: correctFfmpegPath, ffprobePath: correctFfprobePath },
    });

    worker.on("message", (message) => {
      if (message.error) {
        reject(message.error);
      } else {
        const result = message.result as GaboratorAnalysisResult & {
          sampleRate: number;
          format: string;
          codec: string;
          channels: number;
        };

        currentSampleRate = result.sampleRate;
        currentChannels = result.channels;
        currentMetadata = {
          format: result.format,
          codec: result.codec,
        };

        const payload: AnalysisPayloadForRenderer = {
          ...result,
          filePath,
          data: Buffer.from(result.data.buffer),
          inverseMap: Buffer.from(result.inverseMap.buffer),
          metadataTexture: Buffer.from(result.metadataTexture.buffer),
        };

        resolve(payload);
      }
      worker.terminate();
    });

    worker.on("error", (err) => {
      reject(err);
      worker.terminate();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({ filePath, params });
  });
}

function runSynthesisInWorker(
  payload: { processedData: Buffer; analysisMetadata: any },
  params: GaboratorParams,
  normalize: boolean,
): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, "synthesis-worker.js");
    const worker = new Worker(workerPath, {
      workerData: { gaboratorPath },
    });

    worker.on("message", (message) => {
      if (message.error) {
        reject(message.error);
      } else {
        resolve(message.result as Float32Array[]);
      }
      worker.terminate();
    });

    worker.on("error", (err) => {
      reject(err);
      worker.terminate();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
    const processedData = payload.processedData;

    worker.postMessage(
      {
        processedData: processedData,
        analysisMetadata: payload.analysisMetadata,
        sampleRate: currentSampleRate,
        params,
        normalize,
      },
      [processedData.buffer as ArrayBuffer],
    );
  });
}

function interleave(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const interleaved = new Float32Array(numChannels * numFrames);

  for (let i = 0; i < numFrames; i++) {
    for (let j = 0; j < numChannels; j++) {
      interleaved[i * numChannels + j] = channels[j][i];
    }
  }
  return interleaved;
}

export function registerAudioIpcHandlers(window: BrowserWindow) {
  ipcMainOn("open-and-analyze", async (_event, params) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"] }],
    });
    if (canceled || filePaths.length === 0) {
      return;
    }

    const filePath = filePaths[0];
    currentFilePath = filePath;

    try {
      const payload = await runAnalysisInWorker(filePath, params);
      webContentsSend(window, "analysis-complete", payload);
    } catch (error) {
      console.error("Analysis failed:", error);
      webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
    }
  });

  ipcMainHandle("synthesize-audio", async (_, payload, params, normalize) => {
    return runSynthesisInWorker(payload, params, normalize);
  });

  ipcMainHandle("save-audio-data", async (_, payload, params, normalize) => {
    if (!currentFilePath) {
      throw new Error("No file path specified for saving.");
    }

    const audioChannels = await runSynthesisInWorker(payload, params, normalize);
    const interleavedAudio = interleave(audioChannels);

    const readable = new Readable();
    readable._read = () => {}; // _read is required but we push data manually
    readable.push(Buffer.from(interleavedAudio.buffer));
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
      const payload = await runAnalysisInWorker(filePath, params);
      webContentsSend(window, "analysis-complete", payload);
    } catch (error) {
      console.error("Analysis failed:", error);
      webContentsSend(window, "analysis-error", error instanceof Error ? error.message : "Unknown error");
    }
  });
}
