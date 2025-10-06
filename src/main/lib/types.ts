import { BrowserWindow, ipcMain } from "electron";
// Describes the flat object returned directly from the C++ addon
export interface GaboratorAnalysisResult {
  data: Float32Array;
  inverseMap: Float32Array;
  metadataTexture: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
  isClamped: boolean;
  clampedDurationSeconds: number;
}

export type AnalysisParams = {
  bandsPerOctave: number;
  minFreq: number;
};

export interface IpcMainHandlers {
  "update-menu-state": (event: Electron.IpcMainEvent, canUndo: boolean, canRedo: boolean) => void;
}

export interface IpcRendererEvents {
  "open-file": (path: string) => void;
  "save-active-file": () => void;
  undo: () => void;
  redo: () => void;
  "restore-original": () => void;
  "close-active-file": () => void;
  "close-all-files": () => void;
  "reanalyze-active-file": () => void;
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
