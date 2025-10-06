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

// Describes the payload sent to the renderer process via IPC. Large arrays are Buffers.
export interface AnalysisPayloadForRenderer {
  filePath: string;
  data: Buffer;
  inverseMap: Buffer;
  metadataTexture: Buffer;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
  sampleRate: number;
  minFreq: number;
  bandsPerOctave: number;
  isClamped: boolean;
  clampedDurationSeconds: number;
}

// Describes the payload received from the renderer when requesting synthesis
export interface SynthesisPayload {
  processedData: Buffer; // The modified data from the GPU
  analysisMetadata: {
    numFrames: number;
    numChannels: number;
    numBands: number;
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
}

export type AnalysisParams = {
  bandsPerOctave: number;
  minFreq: number;
};

export interface UndoState {
  data: Buffer;
  filePath: string;
}

// Legacy type kept for reference - no longer used
// Renderer now uses ipcRenderer directly instead of this wrapper API

export interface IpcMainHandlers {
  "load-file": (event: Electron.IpcMainEvent, filePath: string, params: AnalysisParams) => void;
  "add-undo-state": (event: Electron.IpcMainEvent, args: { data: Buffer; filePath: string }) => void;
  "clear-undo-state": (event: Electron.IpcMainEvent) => void;
  "open-and-analyze": (event: Electron.IpcMainEvent, params: AnalysisParams) => void;
  "reanalyze-current-file": (event: Electron.IpcMainInvokeEvent, params: AnalysisParams) => Promise<void>;
  "save-audio-data": (event: Electron.IpcMainInvokeEvent, audioChannelsBuffers: Buffer[]) => Promise<void>;
  "set-file-metadata": (
    event: Electron.IpcMainEvent,
    metadata: { sampleRate: number; channels: number; format: string; codec: string },
  ) => void;
  "update-menu-state": (event: Electron.IpcMainEvent, canUndo: boolean, canRedo: boolean) => void;
  "set-active-file": (event: Electron.IpcMainEvent, filePath: string) => void;
  "file-opened": (event: Electron.IpcMainEvent, filePath: string) => void;
  "file-closed": (event: Electron.IpcMainEvent, filePath: string) => void;
}

export interface IpcRendererEvents {
  "open-file": (path: string) => void;
  "analysis-complete": (payload: AnalysisPayloadForRenderer) => void;
  "analysis-error": (error: string) => void;
  "save-active-file": () => void;
  undo: () => void;
  redo: () => void;
  "restore-original": () => void;
  "close-active-file": () => void;
  "close-all-files": () => void;
  "reanalyze-active-file": () => void;
}

type IpcMainHandlerKeysWithPromise = {
  [K in keyof IpcMainHandlers]: IpcMainHandlers[K] extends (...args: any[]) => Promise<any> ? K : never;
}[keyof IpcMainHandlers];

export function ipcMainOn<K extends keyof IpcMainHandlers>(channel: K, listener: IpcMainHandlers[K]): void {
  ipcMain.on(channel, listener as any);
}

export function ipcMainHandle<K extends IpcMainHandlerKeysWithPromise>(channel: K, listener: IpcMainHandlers[K]): void {
  ipcMain.handle(channel, listener as any);
}

export function webContentsSend<K extends keyof IpcRendererEvents>(
  window: BrowserWindow,
  channel: K,
  ...args: Parameters<IpcRendererEvents[K]>
): void {
  window.webContents.send(channel, ...args);
}
