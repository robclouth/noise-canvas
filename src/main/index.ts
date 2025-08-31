import { app, shell, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Writable } from "stream";

// Load the native addon
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaborator = require(join(__dirname, "../../build/Release/gaborator_addon.node"));

ffmpeg.setFfmpegPath(ffmpegPath!);

// This is treated as a global for the synthesis function.
// It's updated each time a file is analyzed.
let currentSampleRate = 44100;

// --- Corrected Interfaces ---

// Describes the object returned directly from the C++ addon
interface GaboratorAnalysis {
  data: Float32Array;
  metadata: {
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

// Describes the payload sent to the renderer process via IPC
interface AnalysisPayload {
  data: Buffer; // Float32Array data converted to a Buffer for efficient transfer
  metadata: GaboratorAnalysis["metadata"];
  numFrames: number;
  sampleRate: number;
}

interface GaboratorParams {
  bandsPerOctave: number;
  fmin: number;
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Note: These are insecure settings, suitable for development but
      // should be revisited for a production app.
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
    if (is.dev) mainWindow.webContents.openDevTools();
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
      filters: [
        {
          name: "Audio Files",
          extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"],
        },
      ],
    });
    if (!canceled && filePaths.length > 0) {
      return filePaths[0];
    }
    return null;
  });

  ipcMain.handle("analyze-audio", async (_, filePath: string, params: GaboratorParams): Promise<AnalysisPayload> => {
    return new Promise((resolve, reject) => {
      // 1. Probe the file to get metadata (sample rate, channels)
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          return reject(err);
        }
        const audioStreamInfo = metadata.streams.find((s) => s.codec_type === "audio");
        if (!audioStreamInfo || !audioStreamInfo.sample_rate) {
          return reject(new Error("Could not determine sample rate from audio file."));
        }

        const sampleRate =
          typeof audioStreamInfo.sample_rate === "string"
            ? parseInt(audioStreamInfo.sample_rate, 10)
            : audioStreamInfo.sample_rate;
        currentSampleRate = sampleRate; // Store for potential synthesis later

        const channels = audioStreamInfo.channels || 1;

        // 2. Decode the entire audio file to raw 32-bit float PCM
        const audioChunks: Buffer[] = [];
        const audioStream = new Writable({
          write(chunk, _encoding, callback) {
            audioChunks.push(chunk);
            callback();
          },
        });

        ffmpeg(filePath)
          .toFormat("f32le") // Decode to 32-bit floating point, little-endian
          .audioChannels(channels)
          .audioFrequency(sampleRate)
          .on("error", (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
          .stream(audioStream)
          .on("finish", () => {
            try {
              // 3. Prepare data for the native addon
              const concatenatedBuffer = Buffer.concat(audioChunks);
              const audioVector = new Float32Array(
                concatenatedBuffer.buffer,
                concatenatedBuffer.byteOffset,
                concatenatedBuffer.length / Float32Array.BYTES_PER_ELEMENT,
              );
              const numFrames = audioVector.length / channels;

              // 4. Call the C++ Gaborator analysis function
              const analysisResult: GaboratorAnalysis = gaborator.analyze(audioVector, channels, sampleRate, params);

              // 5. Package the results for efficient IPC transfer
              const payload: AnalysisPayload = {
                // Convert the Float32Array's underlying ArrayBuffer to a Node.js Buffer
                data: Buffer.from(analysisResult.data.buffer),
                metadata: analysisResult.metadata,
                numFrames,
                sampleRate,
              };

              resolve(payload);
            } catch (e) {
              reject(e);
            }
          });
      });
    });
  });

  // This handler assumes you will add a 'synthesize' function to your C++ addon
  ipcMain.handle(
    "synthesize-audio",
    async (_, payload: AnalysisPayload, params: GaboratorParams): Promise<Float32Array> => {
      // Reconstruct the Float32Array from the Buffer for the C++ addon
      const dataArray = new Float32Array(
        payload.data.buffer,
        payload.data.byteOffset,
        payload.data.length / Float32Array.BYTES_PER_ELEMENT,
      );

      // The C++ addon would need a function that accepts this structure
      const audioVector = gaborator.synthesize(
        dataArray,
        payload.metadata,
        currentSampleRate, // Using the globally stored sample rate
        params,
        payload.numFrames,
      );
      return audioVector;
    },
  );

  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
