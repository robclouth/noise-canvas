import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from "electron-devtools-installer";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { hasSupportedAudioExtension } from "./lib/audio-extensions";
import { createMenu, openFileDialog } from "./lib/menu";
import { ipcMainOn, webContentsSend } from "./lib/types";
import { checkForUpdates, initUpdater } from "./lib/updater";

// Which ANGLE backend translates our shaders, chosen per platform because the
// default is the wrong trade on both. Set NOISE_CANVAS_ANGLE (gl, vulkan, d3d11,
// metal, default) to override on a machine whose driver disagrees.
//
// macOS: ANGLE's Metal backend stalls each canvas present on a CoreAnimation
// backpressure fence once a frame does any extra GPU work (e.g. a modulator
// precompute pass), which halves the framerate while painting. The OpenGL
// backend presents without that fence.
//
// Windows: the default D3D11 backend compiles the effect shaders through the
// HLSL compiler, which costs ~50s for the set, and its program binaries are not
// reused across launches — so every cold start pays it again. Vulkan compiles
// the same set in ~11s and reuses its cache afterwards (~0.5s), with paint
// throughput equal or slightly better.
const angleBackend = process.env.NOISE_CANVAS_ANGLE;
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-angle", angleBackend || "gl");
} else if (process.platform === "win32") {
  app.commandLine.appendSwitch("use-angle", angleBackend || "vulkan");
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

/**
 * The audio file an argv was launched with, or null. A plain launch passes only
 * the executable — and in dev, the script path too — so an argument is taken as
 * a file only when it is neither of those and carries a supported extension.
 */
function getOpenedPathFromArgv(argv: string[]): string | null {
  if (!argv) return null;
  const skip = is.dev ? 2 : 1;
  for (const arg of argv.slice(skip)) {
    if (!arg || arg.startsWith("-")) continue;
    if (hasSupportedAudioExtension(arg)) return arg;
  }
  return null;
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

// The renderer gets a moment to finish its shutdown work (flushing the debounced
// history manifest, thinning cached audio) before the window goes away. The
// close is held once and only briefly: if the renderer doesn't answer, the
// window closes anyway rather than leaving the app unclosable.
const QUIT_CLEANUP_TIMEOUT_MS = 3000;

function createWindow(): void {
  let quitCleanupRun = false;

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

  // Close is the one point both the window button and Quit pass through while
  // the renderer is still alive, so the cleanup handshake runs here. The second
  // close, from finish(), falls through the guard and closes for real.
  mainWindow.on("close", (event) => {
    const window = mainWindow;
    if (quitCleanupRun || !window || window.webContents.isDestroyed()) return;
    quitCleanupRun = true;
    event.preventDefault();

    const finish = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener("quit-cleanup-done", finish);
      window.close();
    };
    const timer = setTimeout(finish, QUIT_CLEANUP_TIMEOUT_MS);
    ipcMain.once("quit-cleanup-done", finish);
    webContentsSend(window, "app-will-quit");
  });

  // Every later property read on a destroyed BrowserWindow throws, so drop the
  // reference as soon as the window goes.
  mainWindow.on("closed", () => {
    mainWindow = null;
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
  // Must match electron-builder.yml's appId, or Windows treats the running app
  // and the installed shortcut as two different apps.
  electronApp.setAppUserModelId("com.robclouth.noise-canvas");

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
      checkForUpdates();
    });
  }

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMainOn("renderer-ready", () => {
  if (mainWindow && pendingPath) {
    webContentsSend(mainWindow, "open-file", pendingPath);
    pendingPath = null;
  }
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

app.on("window-all-closed", () => {
  app.quit();
});
