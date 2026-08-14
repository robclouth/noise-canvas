import { BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { webContentsSend } from "./types";

/**
 * Forward electron-updater's progress to the renderer and expose the download
 * and install steps over IPC.
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  // Both steps wait for a button in the renderer: nothing downloads on its own,
  // and a downloaded update never installs behind the user's back on quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    const window = getWindow();
    if (window) webContentsSend(window, "update-available", info);
  });

  autoUpdater.on("update-not-available", () => {
    const window = getWindow();
    if (window) webContentsSend(window, "update-not-available");
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    const window = getWindow();
    if (window) webContentsSend(window, "download-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    const window = getWindow();
    if (window) webContentsSend(window, "update-downloaded", info);
  });

  autoUpdater.on("error", (error: Error) => {
    const window = getWindow();
    if (window) webContentsSend(window, "update-error", error.message);
  });

  ipcMain.handle("check-for-updates", () => {
    checkForUpdates();
  });

  ipcMain.handle("download-update", async () => {
    await autoUpdater.downloadUpdate();
    return true;
  });

  ipcMain.handle("quit-and-install", () => {
    autoUpdater.quitAndInstall();
  });
}

/**
 * Ask the feed for a newer version. The answer arrives as an `update-available`
 * or `update-not-available` event, so failures here only need logging.
 */
export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((error) => {
    console.error("Failed to check for updates:", error);
  });
}
