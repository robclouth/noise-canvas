import { electronAPI } from "@electron-toolkit/preload";
import { ipcRenderer } from "electron";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import * as audioAnalysis from "../main/lib/audio-analysis";
import * as linkAddon from "../main/lib/link";

// @ts-ignore (define in dts)
window.electron = electronAPI;

// @ts-ignore (define in dts)
window.ipcRenderer = ipcRenderer;

// @ts-ignore (define in dts)
window.audioAnalysis = audioAnalysis;

// @ts-ignore (define in dts)
window.nodeFs = fs;
// @ts-ignore (define in dts)
window.nodePath = path;
// @ts-ignore (define in dts)
window.nodeOs = os;
// @ts-ignore (define in dts)
window.nodeZlib = zlib;
// @ts-ignore (define in dts)
window.platform = process.platform;
// @ts-ignore (define in dts)
window.linkAddon = linkAddon;

// @ts-ignore (define in dts)
window.updater = {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
};
