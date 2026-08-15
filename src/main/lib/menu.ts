import { app, BrowserWindow, dialog, Menu } from "electron";
import { allowedExtensions } from "./audio-analysis";
import { webContentsSend } from "./types";
import { checkForUpdates } from "./updater";

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

/**
 * The app's own menus live in the window (see `components/layout/menu-bar.tsx`),
 * so the native menu carries only what the OS owns. On macOS that is the
 * application menu, which cannot be removed, plus the text-editing roles that
 * Chromium needs a menu item for before Cmd+X/C/V/A reach an input. Every other
 * platform gets no menu at all.
 */
export function createMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { label: `About ${app.getName()}`, role: "about" },
        { label: "Check for Updates...", click: () => checkForUpdates() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
        { role: "cut", visible: false },
        { role: "copy", visible: false },
        { role: "paste", visible: false },
        { role: "selectAll", visible: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
