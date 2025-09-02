import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { Writable } from "stream";
import icon from "../../resources/icon.png?asset";

let mainWindow: BrowserWindow | null = null;

const gotTheLock = app.requestSingleInstanceLock();
let pendingPath: string | null = null;

// This handles opening a file with the app on macOS when it's not running.
// The event fires before the 'ready' event.
app.on("open-file", (event, path) => {
  event.preventDefault();
  // On launch, we just save the path. It will be opened when the window is created.
  pendingPath = path;
});

// In dev, the first arg is the app path, second is CWD.
// In prod, the first is the app path.
const fileArgIndex = app.isPackaged ? 1 : 2;
const args = process.argv.slice(fileArgIndex);
for (const arg of args) {
  // Simple check to filter out flags and take the first non-flag argument as the file path.
  if (!arg.startsWith("--")) {
    pendingPath = arg;
    break;
  }
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      mainWindow.webContents.send("debug-arguments", argv);
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      const newFileArgs = argv.slice(fileArgIndex);
      for (const arg of newFileArgs) {
        if (!arg.startsWith("--") && mainWindow) {
          // Send the file path to the renderer process
          // We'll just send the first valid file path we find
          mainWindow.webContents.send("open-file", arg);
          break; // only open one file
        }
      }
    }
  });
}

// This handles opening a file with the app on macOS when it's already running.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("open-file", path);
  }
});

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
  mainWindow = new BrowserWindow({
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
    mainWindow?.show();
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
    mainWindow.webContents.openDevTools();
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

  if (mainWindow) {
    mainWindow.webContents.on("did-finish-load", () => {
      // Send initial arguments for debugging
      mainWindow?.webContents.send("debug-arguments", process.argv);

      if (pendingPath) {
        // Send the pending file path to the renderer
        mainWindow?.webContents.send("open-file", pendingPath);
        pendingPath = null;
      }
    });
  }

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
