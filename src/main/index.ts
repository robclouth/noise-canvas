import { app, shell, BrowserWindow, ipcMain, dialog } from "electron"
import { join } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import icon from "../../resources/icon.png?asset"
import ffmpeg from "fluent-ffmpeg"
import ffmpegPath from "ffmpeg-static"
import { Writable } from "stream"

// Load the native addon
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaborator = require(join(__dirname, "../../build/Release/gaborator_addon.node"))

ffmpeg.setFfmpegPath(ffmpegPath!)

let sampleRate = 44100 // Default, will be updated on file load

type Spectrogram = Float32Array[][]
interface GaboratorParams {
  bandsPerOctave: number
  fmin: number
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
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.electron")

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on("ping", () => console.log("pong"))

  ipcMain.handle("open-file-dialog", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        {
          name: "Audio Files",
          extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff"]
        }
      ]
    })
    if (!canceled) {
      return filePaths[0]
    }
    return null
  })

  ipcMain.handle(
    "analyze-audio",
    async (_, filePath: string, params: GaboratorParams): Promise<Spectrogram> => {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            return reject(err)
          }
          const audioStreamInfo = metadata.streams.find((s) => s.codec_type === "audio")
          if (!audioStreamInfo || !audioStreamInfo.sample_rate) {
            return reject(new Error("Could not determine sample rate from audio file."))
          }
          sampleRate =
            typeof audioStreamInfo.sample_rate === "string"
              ? parseInt(audioStreamInfo.sample_rate, 10)
              : audioStreamInfo.sample_rate

          const channels = audioStreamInfo.channels || 1

          const audioBuffer: Buffer[] = []
          const audioStream = new Writable({
            write(chunk, _encoding, callback) {
              audioBuffer.push(chunk)
              callback()
            }
          })
          ffmpeg(filePath)
            .toFormat("f32le")
            .audioChannels(channels)
            .on("error", (err) => reject(err))
            .stream(audioStream)
            .on("finish", () => {
              const concatenatedBuffer = Buffer.concat(audioBuffer)
              const audioVector = new Float32Array(
                concatenatedBuffer.buffer,
                concatenatedBuffer.byteOffset,
                concatenatedBuffer.length / Float32Array.BYTES_PER_ELEMENT
              )

              const spectrogram = gaborator.analyze(audioVector, channels, sampleRate, params)
              resolve(spectrogram)
            })
        })
      })
    }
  )

  ipcMain.handle(
    "synthesize-audio",
    async (
      _,
      spectrogram: Spectrogram,
      channels: number,
      numFrames: number,
      params: GaboratorParams
    ): Promise<Float32Array> => {
      const audioVector = gaborator.synthesize(spectrogram, channels, sampleRate, numFrames, params)
      return audioVector
    }
  )

  createWindow()

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
