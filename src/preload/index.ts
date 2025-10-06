import { electronAPI } from "@electron-toolkit/preload";
import { ipcRenderer } from "electron";
import * as fs from "fs/promises";
import { compressSync, uncompressSync } from "lz4-napi";
import * as os from "os";
import * as path from "path";
import * as audioAnalysis from "../main/lib/audio-analysis";

// @ts-ignore (define in dts)
window.electron = electronAPI;

// @ts-ignore (define in dts)
window.ipcRenderer = ipcRenderer;

// @ts-ignore (define in dts)
window.audioAnalysis = audioAnalysis;

// @ts-ignore (define in dts)
window.compression = {
  compress: compressSync,
  uncompress: uncompressSync,
};

// @ts-ignore (define in dts)
window.nodeFs = fs;
// @ts-ignore (define in dts)
window.nodePath = path;
// @ts-ignore (define in dts)
window.nodeOs = os;
