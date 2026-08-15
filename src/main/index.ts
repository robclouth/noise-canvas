import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from "electron-devtools-installer";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { createMenu, openFileDialog } from "./lib/menu";
import { ipcMainOn, webContentsSend } from "./lib/types";
import { checkForUpdates, initUpdater } from "./lib/updater";

// On macOS, ANGLE's Metal backend stalls each canvas present on a CoreAnimation
// backpressure fence once a frame does any extra GPU work (e.g. a modulator
// precompute pass), which halves the framerate while painting. The OpenGL
// backend presents without that fence, so use it on macOS.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-angle", "gl");
}

// Remove dictation and character palette menu items on macOS
if (process.platform === "darwin") {
  systemPreferences.setUserDefault("NSDisabledDictationMenuItem", "boolean", true);
  systemPreferences.setUserDefault("NSDisabledCharacterPaletteMenuItem", "boolean", true);
}

let mainWindow: BrowserWindow | null = null;

const gotTheLock = app.requestSingleInstanceLock();
let pendingPath: string | null = getOpenedPathFromArgv(process.argv);

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    webContentsSend(mainWindow, "open-file", path);
  } else {
    pendingPath = path;
  }
});

function getOpenedPathFromArgv(argv: string[]): string | null {
  return argv?.slice(-1)[0] || null;
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      const openedFilePath = getOpenedPathFromArgv(argv);

      if (openedFilePath && mainWindow) {
        webContentsSend(mainWindow, "open-file", openedFilePath);
      }
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: "#333333",
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // Allow loading local files
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // setWindowOpenHandler only catches target="_blank". Plain hrefs, such as the
  // links inside release notes, navigate this window instead, which would hand a
  // remote page the window's Node access.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (current && url.startsWith(current)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    // mainWindow.webContents.openDevTools();
  }

  createMenu();
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  initUpdater(() => mainWindow);

  createWindow();

  if (mainWindow && is.dev) {
    // Install DevTools extensions in development mode
    // Temporarily suppress deprecation and extension warnings
    const noDeprecation = process.noDeprecation;
    process.noDeprecation = true;
    process.removeAllListeners("warning");

    try {
      await installExtension([REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS], {
        loadExtensionOptions: { allowFileAccess: true },
      });
    } catch (error) {
      console.log("DevTools extensions failed to install:", error);
    } finally {
      process.noDeprecation = noDeprecation;
    }

    if (process.env.NODE_ENV === "development") {
      setTimeout(() => {
        mainWindow!.reload();
      }, 500);
    }
  }

  if (mainWindow) {
    mainWindow.webContents.on("did-finish-load", () => {
      if (pendingPath) {
        webContentsSend(mainWindow!, "open-file", pendingPath);
        pendingPath = null;
      }
      checkForUpdates();
    });
  }

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMainOn("check-for-updates", () => {
  checkForUpdates();
});

ipcMainOn("trigger-open-file", () => {
  if (mainWindow) {
    openFileDialog(mainWindow);
  }
});

// Handle save dialog from renderer
ipcMain.handle("show-save-dialog", async (_event, options) => {
  if (!mainWindow) return { canceled: true };
  return await dialog.showSaveDialog(mainWindow, options);
});

// Handle directory picker dialog from renderer (used for Export History)
ipcMain.handle("show-directory-dialog", async (_event, options) => {
  if (!mainWindow) return { canceled: true };
  return await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    ...(options ?? {}),
  });
});

ipcMain.handle("get-user-data-path", () => app.getPath("userData"));

// Links in the manual go to the system browser rather than navigating the
// editor window, which has no way back.
ipcMain.on("open-external", (_event, url: string) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// Give the renderer a moment to finish its shutdown work (flushing the debounced
// history manifest, thinning cached audio) before the process goes away. Quit is
// held once and only briefly: if the renderer doesn't answer, quitting proceeds
// anyway rather than leaving the app unclosable.
const QUIT_CLEANUP_TIMEOUT_MS = 3000;
let quitCleanupRun = false;

app.on("before-quit", (event) => {
  if (quitCleanupRun || !mainWindow || mainWindow.webContents.isDestroyed()) return;
  quitCleanupRun = true;
  event.preventDefault();

  const finish = (): void => {
    clearTimeout(timer);
    ipcMain.removeListener("quit-cleanup-done", finish);
    app.quit();
  };
  const timer = setTimeout(finish, QUIT_CLEANUP_TIMEOUT_MS);
  ipcMain.once("quit-cleanup-done", finish);
  webContentsSend(mainWindow, "app-will-quit");
});

app.on("will-quit", async () => {});

app.on("window-all-closed", () => {
  app.quit();
});
