import { BrowserWindow, ipcMain } from "electron";
// Describes the flat object returned directly from the C++ addon
export interface GaboratorAnalysisResult {
  data: Float32Array;
  inverseMap: Float32Array;
  metadata: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
}

export type AnalysisParams = {
  bandsPerOctave: number;
  minFreq: number;
};

export interface IpcMainHandlers {
  "update-menu-state": (event: Electron.IpcMainEvent, canUndo: boolean, canRedo: boolean) => void;
  "update-save-state": (event: Electron.IpcMainEvent, isDirty: boolean) => void;
  "trigger-open-file": (event: Electron.IpcMainEvent) => void;
  "update-recent-files": (event: Electron.IpcMainEvent, paths: string[]) => void;
  "update-ui-size": (event: Electron.IpcMainEvent, isCompact: boolean) => void;
}

export interface IpcRendererEvents {
  "new-file": () => void;
  "open-file": (path: string) => void;
  "save-active-file": () => void;
  "save-active-file-as": () => void;
  "save-active-file-version": () => void;
  "export-history": () => void;
  undo: () => void;
  redo: () => void;
  "restore-original": () => void;
  "duplicate-active-file": () => void;
  "close-active-file": () => void;
  "reanalyze-active-file": () => void;
  "double-active-file-length": () => void;
  "halve-active-file-length": () => void;
  "update-available": (info: any) => void;
  "update-not-available": () => void;
  "update-downloaded": (info: any) => void;
  "download-progress": (progressInfo: any) => void;
  "update-error": (message: string) => void;
  "app-will-quit": () => void;
  "clear-recent-files": () => void;
  "toggle-ui-size": () => void;
}

export function ipcMainOn<K extends keyof IpcMainHandlers>(channel: K, listener: IpcMainHandlers[K]): void {
  ipcMain.on(channel, listener as any);
}

export function webContentsSend<K extends keyof IpcRendererEvents>(
  window: BrowserWindow,
  channel: K,
  ...args: Parameters<IpcRendererEvents[K]>
): void {
  window.webContents.send(channel, ...args);
}
