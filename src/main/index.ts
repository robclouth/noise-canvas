import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { registerAudioIpcHandlers, setupAudio } from "./lib/audio";
import { createMenu } from "./lib/menu";
import { UndoService } from "./lib/undo";

let mainWindow: BrowserWindow | null = null;
let undoService: UndoService | null = null;

const gotTheLock = app.requestSingleInstanceLock();
let pendingPath: string | null = null;

app.on("open-file", (event, path) => {
  event.preventDefault();
  pendingPath = path;
});

const fileArgIndex = app.isPackaged ? 1 : 2;
const args = process.argv.slice(fileArgIndex);
for (const arg of args) {
  if (!arg.startsWith("--")) {
    pendingPath = arg;
    break;
  }
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      mainWindow.webContents.send("debug-arguments", argv);
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      const newFileArgs = argv.slice(fileArgIndex);
      for (const arg of newFileArgs) {
        if (!arg.startsWith("--") && mainWindow) {
          mainWindow.webContents.send("open-file", arg);
          break;
        }
      }
    }
  });
}

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("open-file", path);
  }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
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

  undoService = new UndoService(mainWindow);
  createMenu(mainWindow, undoService);
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  setupAudio();
  createWindow();

  if (mainWindow) {
    registerAudioIpcHandlers(mainWindow);

    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow?.webContents.send("debug-arguments", process.argv);
      if (pendingPath) {
        mainWindow?.webContents.send("open-file", pendingPath);
        pendingPath = null;
      }
    });
  }

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on("undo:add-state", (_, { before, after }: { before: Buffer; after: Buffer }) => {
  undoService?.addState(before, after);
});

ipcMain.on("undo:clear", () => {
  undoService?.clear();
});

app.on("will-quit", () => {
  undoService?.destroy();
});

app.on("window-all-closed", () => {
  app.quit();
});
