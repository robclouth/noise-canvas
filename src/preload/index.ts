import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

// Custom APIs for renderer
const api = {
  onOpenFile: (callback: (path: string) => void) => {
    ipcRenderer.on("open-file", (_event, value) => callback(value));
  },
  onDebugArguments: (callback: (args: string[]) => void) => {
    ipcRenderer.on("debug-arguments", (_event, value) => callback(value));
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", {
      ...electronAPI,
      ipcRenderer: {
        send: (channel: string, ...args: any) => ipcRenderer.send(channel, ...args),
        on: (channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any[]) => void) =>
          ipcRenderer.on(channel, listener),
        invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
      },
    });
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = {
    ...electronAPI,
    ipcRenderer: {
      send: (channel: string, ...args: any) => ipcRenderer.send(channel, ...args),
      on: (channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any[]) => void) =>
        ipcRenderer.on(channel, listener),
      invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
    },
  };
  // @ts-ignore (define in dts)
  window.api = api;
}
