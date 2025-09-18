import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import type { GaboratorParams, IpcApi } from "../main/lib/types";

// Custom APIs for renderer
const api: IpcApi = {
  onOpenFile: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("open-file", handler);
    return () => ipcRenderer.removeListener("open-file", handler);
  },
  onTriggerOpenFile: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("trigger-open-file", handler);
    return () => ipcRenderer.removeListener("trigger-open-file", handler);
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
  onUndoApplyState: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("apply-undo-state", handler);
    return () => ipcRenderer.removeListener("apply-undo-state", handler);
  },
  loadFile: (filePath: string, params: GaboratorParams) => {
    ipcRenderer.send("load-file", filePath, params);
  },
  addUndoState: (args: { after: ArrayBufferLike }) => {
    ipcRenderer.send("add-undo-state", {
      after: Buffer.from(args.after as ArrayBuffer),
    });
  },
  setInitialState: (args: { state: ArrayBufferLike }) => {
    ipcRenderer.send("set-initial-undo-state", {
      state: Buffer.from(args.state as ArrayBuffer),
    });
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
  openFileAndAnalyze: (params) => ipcRenderer.invoke("open-file-and-analyze", params),
  saveAudioData: (payload, params, normalize) => {
    return ipcRenderer.invoke(
      "save-audio-data",
      {
        ...payload,
        processedData: Buffer.from(payload.processedData),
      },
      params,
      normalize,
    );
  },
  onRequestAudioForSaving: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("request-audio-for-saving", handler);
    return () => {
      ipcRenderer.removeListener("request-audio-for-saving", handler);
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
}
