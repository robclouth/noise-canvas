import { app, BrowserWindow, dialog, Menu } from "electron";
import { allowedExtensions } from "./audio-analysis";
import { webContentsSend } from "./types";

export function createMenu(window: BrowserWindow) {
  const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
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
          },
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            webContentsSend(window, "save-active-file");
          },
        },
        { type: "separator" },
        {
          label: "Close Active",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            webContentsSend(window, "close-active-file");
          },
        },
        {
          label: "Close All",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => {
            webContentsSend(window, "close-all-files");
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
          enabled: false,
          click: () => {
            webContentsSend(window, "undo");
          },
          id: "undo",
        },
        {
          label: "Redo",
          accelerator: "Shift+CmdOrCtrl+Z",
          enabled: false,
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
          label: "Re-analyze Active File",
          click: () => {
            webContentsSend(window, "reanalyze-active-file");
          },
        },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const mainMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(mainMenu);
}
