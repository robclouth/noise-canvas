import { app, BrowserWindow, dialog } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { Readable } from "stream";
import { ipcMainHandle, ipcMainOn, webContentsSend } from "./types";

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

// Analysis and synthesis are now done directly in the renderer process to avoid IPC transfer

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
  // Just handle file dialog, let renderer do analysis
  ipcMainOn("open-and-analyze", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"] }],
    });
    if (canceled || filePaths.length === 0) {
      return;
    }

    const filePath = filePaths[0];
    currentFilePath = filePath;

    // Send file path to renderer, which will do the analysis directly
    webContentsSend(window, "open-file", filePath);
  });

  // Handler that receives pre-synthesized audio channels from renderer
  ipcMainHandle("save-audio-data", async (_, audioChannelsBuffers: Buffer[]) => {
    if (!currentFilePath) {
      throw new Error("No file path specified for saving.");
    }

    // Convert buffers back to Float32Arrays
    const audioChannels = audioChannelsBuffers.map(
      (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT),
    );
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

  // Just set current file path and notify renderer
  ipcMainOn("load-file", async (_, filePath) => {
    currentFilePath = filePath;
    // Renderer will handle analysis directly
    webContentsSend(window, "open-file", filePath);
  });

  // Store file metadata when analysis completes in renderer
  ipcMainOn(
    "set-file-metadata",
    (_, metadata: { sampleRate: number; channels: number; format: string; codec: string }) => {
      currentSampleRate = metadata.sampleRate;
      currentChannels = metadata.channels;
      currentMetadata = {
        format: metadata.format,
        codec: metadata.codec,
      };
    },
  );
}
