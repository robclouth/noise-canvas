import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, systemPreferences } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from "electron-devtools-installer";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { createMenu } from "./lib/menu";
import { ipcMainOn, webContentsSend } from "./lib/types";

systemPreferences.setUserDefault("NSDisabledDictationMenuItem", "boolean", true);
systemPreferences.setUserDefault("NSDisabledCharacterPaletteMenuItem", "boolean", true);

let mainWindow: BrowserWindow | null = null;

const gotTheLock = app.requestSingleInstanceLock();
let pendingPath: string | null = null;

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
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      const newFileArgs = argv.slice(fileArgIndex);
      for (const arg of newFileArgs) {
        if (!arg.startsWith("--") && mainWindow) {
          webContentsSend(mainWindow, "open-file", arg);
          break;
        }
      }
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    show: false,
    autoHideMenuBar: true,
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

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    // mainWindow.webContents.openDevTools();
  }

  createMenu(mainWindow!);
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

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
    });
  }

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Update menu items based on undo/redo state from renderer
ipcMainOn("update-menu-state", (_, canUndo: boolean, canRedo: boolean) => {
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const undoItem = menu.getMenuItemById("undo");
    if (undoItem) undoItem.enabled = canUndo;
    const redoItem = menu.getMenuItemById("redo");
    if (redoItem) redoItem.enabled = canRedo;
  }
});

// Update save menu item based on dirty state from renderer
ipcMainOn("update-save-state", (_, isDirty: boolean) => {
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const saveItem = menu.getMenuItemById("save");
    if (saveItem) saveItem.enabled = isDirty;
  }
});

// Handle save dialog from renderer
ipcMain.handle("show-save-dialog", async (_event, options) => {
  if (!mainWindow) return { canceled: true };
  return await dialog.showSaveDialog(mainWindow, options);
});

app.on("will-quit", async () => {});

app.on("window-all-closed", () => {
  app.quit();
});
