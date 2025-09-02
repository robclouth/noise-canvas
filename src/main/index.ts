import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { Writable } from "stream";
import icon from "../../resources/icon.png?asset";

// Load the native addon
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaboratorPath = app.isPackaged
  ? join(process.resourcesPath, "app.asar.unpacked/build/Release/gaborator_addon.node")
  : join(__dirname, "../../build/Release/gaborator_addon.node");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaborator = require(gaboratorPath);

const correctFfmpegPath = app.isPackaged ? ffmpegPath!.replace("app.asar", "app.asar.unpacked") : ffmpegPath!;
const correctFfprobePath = app.isPackaged
  ? ffprobePath.path.replace("app.asar", "app.asar.unpacked")
  : ffprobePath.path;
ffmpeg.setFfmpegPath(correctFfmpegPath);
ffmpeg.setFfprobePath(correctFfprobePath);

// This is treated as a global for the synthesis function.
// It's updated each time a file is analyzed.
let currentSampleRate = 44100;

// Describes the flat object returned directly from the C++ addon
interface GaboratorAnalysisResult {
  data: Float32Array;
  inverseMap: Float32Array;
  metadataTexture: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
}

// Describes the payload sent to the renderer process via IPC. Large arrays are Buffers.
interface AnalysisPayloadForRenderer {
  data: Buffer;
  inverseMap: Buffer;
  metadataTexture: Buffer;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
}

// Describes the payload received from the renderer when requesting synthesis
interface SynthesisPayload {
  processedData: Buffer; // The modified data from the GPU
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

interface GaboratorParams {
  bandsPerOctave: number;
  fmin: number;
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200, // Wider for better spectrogram view
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.handle("open-file-dialog", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"] }],
    });
    if (!canceled && filePaths.length > 0) {
      return filePaths[0];
    }
    return null;
  });

  ipcMain.handle(
    "analyze-audio",
    async (_, filePath: string, params: GaboratorParams): Promise<AnalysisPayloadForRenderer> => {
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

                // 1. Call the C++ addon, which returns a single flat object
                const analysisResult: GaboratorAnalysisResult = gaborator.analyze(
                  audioVector,
                  channels,
                  sampleRate,
                  params,
                );

                // 2. Convert large arrays to Buffers for efficient IPC transfer
                const payload: AnalysisPayloadForRenderer = {
                  ...analysisResult,
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
    },
  );

  ipcMain.handle(
    "synthesize-audio",
    async (_, payload: SynthesisPayload, params: GaboratorParams, normalize: boolean): Promise<Float32Array> => {
      // Convert the processed data Buffer from the renderer back to a Float32Array
      const processedDataArray = new Float32Array(
        payload.processedData.buffer,
        payload.processedData.byteOffset,
        payload.processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      // The C++ addon expects the processed data array and the original metadata object
      const audioVector = gaborator.synthesize(
        processedDataArray,
        payload.analysisMetadata,
        currentSampleRate,
        params,
        normalize,
      );
      return audioVector;
    },
  );

  createWindow();

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
