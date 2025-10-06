import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import * as fs from "fs/promises";
import { compressSync, uncompressSync } from "lz4-napi";
import * as os from "os";
import * as path from "path";
import * as directGaborator from "../main/lib/audio";
import type { GaboratorParams, IpcApi } from "../main/lib/types";

// Custom APIs for renderer
const api: IpcApi = {
  onOpenFile: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("open-file", handler);
    return () => ipcRenderer.removeListener("open-file", handler);
  },
  onOpenAndAnalyze: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("open-and-analyze", handler);
    return () => ipcRenderer.removeListener("open-and-analyze", handler);
  },
  onAnalysisComplete: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("analysis-complete", handler);
    return () => ipcRenderer.removeListener("analysis-complete", handler);
  },
  onAnalysisError: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("analysis-error", handler);
    return () => ipcRenderer.removeListener("analysis-error", handler);
  },
  loadFile: (filePath: string, params: GaboratorParams) => {
    ipcRenderer.send("load-file", filePath, params);
  },
  fileOpened: (filePath: string) => {
    ipcRenderer.send("file-opened", filePath);
  },
  fileClosed: (filePath: string) => {
    ipcRenderer.send("file-closed", filePath);
  },
  setActiveFile: (filePath: string | null) => {
    ipcRenderer.send("set-active-file", filePath);
  },
  clearUndoState: () => {
    ipcRenderer.send("clear-undo-state");
  },
  synthesizeAudio: (payload, params, normalize) => {
    return ipcRenderer.invoke(
      "synthesize-audio",
      {
        ...payload,
        processedData: Buffer.from(payload.processedData),
      },
      params,
      normalize,
    );
  },
  reanalyzeCurrentFile: (params) => ipcRenderer.invoke("reanalyze-current-file", params),
  openAndAnalyze: (params) => ipcRenderer.send("open-and-analyze", params),
  saveAudioData: (audioChannels) => {
    // Convert Float32Arrays to Buffers for IPC transfer
    const buffers = audioChannels.map((channel) => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
    return ipcRenderer.invoke("save-audio-data", buffers);
  },
  setFileMetadata: (metadata) => {
    ipcRenderer.send("set-file-metadata", metadata);
  },
  updateMenuState: (canUndo, canRedo) => {
    ipcRenderer.send("update-menu-state", canUndo, canRedo);
  },
  onRequestAudioForSaving: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("request-audio-for-saving", handler);
    return () => {
      ipcRenderer.removeListener("request-audio-for-saving", handler);
    };
  },
  onUndo: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("undo", handler);
    return () => {
      ipcRenderer.removeListener("undo", handler);
    };
  },
  onRedo: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("redo", handler);
    return () => {
      ipcRenderer.removeListener("redo", handler);
    };
  },
  onCloseActiveFile: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("close-active-file", handler);
    return () => {
      ipcRenderer.removeListener("close-active-file", handler);
    };
  },
  onCloseAllFiles: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("close-all-files", handler);
    return () => {
      ipcRenderer.removeListener("close-all-files", handler);
    };
  },
  onRestoreOriginal: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("restore-original", handler);
    return () => {
      ipcRenderer.removeListener("restore-original", handler);
    };
  },
  onReanalyzeActiveFile: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("reanalyze-active-file", handler);
    return () => {
      ipcRenderer.removeListener("reanalyze-active-file", handler);
    };
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;

  // Expose direct gaborator functions for no-IPC access
  // @ts-ignore (define in dts)
  window.gaborator = {
    analyze: directGaborator.analyzeAudio,
    synthesize: directGaborator.synthesizeAudio,
    loadGaborator: directGaborator.loadGaborator,
  };

  // Expose compression utilities for undo
  // @ts-ignore (define in dts)
  window.compression = {
    compress: compressSync,
    uncompress: uncompressSync,
  };

  // Expose Node.js utilities for direct filesystem access
  // @ts-ignore (define in dts)
  window.nodeFs = fs;
  // @ts-ignore (define in dts)
  window.nodePath = path;
  // @ts-ignore (define in dts)
  window.nodeOs = os;
}
