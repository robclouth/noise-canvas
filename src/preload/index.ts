import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import type { IpcApi } from "../main/lib/types";

// Custom APIs for renderer
const api: IpcApi = {
  onOpenFile: (callback) => {
    ipcRenderer.on("open-file", (_event, value) => callback(value));
  },
  onAnalysisComplete: (callback) => {
    ipcRenderer.on("analysis-complete", (_event, value) => callback(value));
  },
  onAnalysisError: (callback) => {
    ipcRenderer.on("analysis-error", (_event, value) => callback(value));
  },
  onUndoApplyState: (callback) => {
    ipcRenderer.on("undo:apply-state", (_event, value) => callback(value));
  },
  loadFile: (filePath: string) => {
    ipcRenderer.send("load-file", filePath);
  },
  addUndoState: (args: { before: ArrayBufferLike; after: ArrayBufferLike }) => {
    ipcRenderer.send("undo:add-state", {
      before: Buffer.from(args.before as ArrayBuffer),
      after: Buffer.from(args.after as ArrayBuffer),
    });
  },
  clearUndoState: () => {
    ipcRenderer.send("undo:clear");
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
