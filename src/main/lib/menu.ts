import { app, BrowserWindow, dialog, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import { allowedExtensions } from "./audio-analysis";
import { webContentsSend } from "./types";

export interface MenuState {
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  recentFiles: string[];
}

export async function openFileDialog(window: BrowserWindow) {
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [
      {
        name: "Audio Files",
        extensions: allowedExtensions,
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    webContentsSend(window, "open-file", result.filePaths[0]);
  }
}

function buildRecentFilesSubmenu(window: BrowserWindow, recentFiles: string[]): Electron.MenuItemConstructorOptions[] {
  if (recentFiles.length === 0) {
    return [{ label: "(No recent files)", enabled: false }];
  }
  const items: Electron.MenuItemConstructorOptions[] = recentFiles.map((filePath) => ({
    label: path.basename(filePath),
    toolTip: filePath,
    click: () => {
      webContentsSend(window, "open-file", filePath);
    },
  }));
  items.push({ type: "separator" });
  items.push({
    label: "Clear Recent",
    click: () => {
      webContentsSend(window, "clear-recent-files");
    },
  });
  return items;
}

export function createMenu(window: BrowserWindow, state: MenuState) {
  const { canUndo, canRedo, isDirty, recentFiles } = state;

  const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
    {
      label: "File",
      submenu: [
        {
          label: "New",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            webContentsSend(window, "new-file");
          },
        },
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: () => openFileDialog(window),
        },
        {
          label: "Open Recent",
          submenu: buildRecentFilesSubmenu(window, recentFiles),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          enabled: isDirty,
          id: "save",
          click: () => {
            webContentsSend(window, "save-active-file");
          },
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => {
            webContentsSend(window, "save-active-file-as");
          },
        },
        {
          label: "Save Version",
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => {
            webContentsSend(window, "save-active-file-version");
          },
        },
        {
          label: "Close File",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            webContentsSend(window, "close-active-file");
          },
        },
        { type: "separator" },
        {
          label: "Export Undo History...",
          click: () => {
            webContentsSend(window, "export-undo-history");
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          enabled: canUndo,
          click: () => {
            webContentsSend(window, "undo");
          },
          id: "undo",
        },
        {
          label: "Redo",
          accelerator: "Shift+CmdOrCtrl+Z",
          enabled: canRedo,
          click: () => {
            webContentsSend(window, "redo");
          },
          id: "redo",
        },
        { type: "separator" },
        {
          label: "Restore Original",
          click: () => {
            webContentsSend(window, "restore-original");
          },
        },
        {
          label: "Re-analyze File",
          click: () => {
            webContentsSend(window, "reanalyze-active-file");
          },
        },
        {
          label: "Duplicate File",
          accelerator: "CmdOrCtrl+D",
          click: () => {
            webContentsSend(window, "duplicate-active-file");
          },
        },
        { type: "separator" },
        {
          label: "Double Length",
          click: () => {
            webContentsSend(window, "double-active-file-length");
          },
        },
        {
          label: "Half Length",
          click: () => {
            webContentsSend(window, "halve-active-file-length");
          },
        },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        {
          label: "Check for Updates...",
          click: async () => {
            try {
              const update = await autoUpdater.checkForUpdates();
              if (update) {
                webContentsSend(window, "update-available", update);
              } else {
                webContentsSend(window, "update-not-available");
              }
            } catch (error) {
              console.error("Failed to check for updates:", error);
            }
          },
        },
      ],
    });
  }

  // Add Help menu for non-macOS platforms
  if (process.platform !== "darwin") {
    template.push({
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: async () => {
            try {
              await autoUpdater.checkForUpdates();
            } catch (error) {
              console.error("Failed to check for updates:", error);
            }
          },
        },
      ],
    });
  }

  const mainMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(mainMenu);
}
