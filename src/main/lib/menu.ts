import { app, BrowserWindow, Menu } from "electron";
import { saveAudioFile } from "./audio2";

export function createMenu(window: BrowserWindow) {
  const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            window.webContents.send("open-and-analyze");
          },
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            saveAudioFile(window);
          },
        },
        { type: "separator" },
        {
          label: "Close Active",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            window.webContents.send("close-active-file");
          },
        },
        {
          label: "Close All",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => {
            window.webContents.send("close-all-files");
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
            window.webContents.send("undo");
          },
          id: "undo",
        },
        {
          label: "Redo",
          accelerator: "Shift+CmdOrCtrl+Z",
          enabled: false,
          click: () => {
            window.webContents.send("redo");
          },
          id: "redo",
        },
        { type: "separator" },
        {
          label: "Restore Original",
          click: () => {
            window.webContents.send("restore-original");
          },
        },
        {
          label: "Re-analyze Active File",
          click: () => {
            window.webContents.send("reanalyze-active-file");
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
