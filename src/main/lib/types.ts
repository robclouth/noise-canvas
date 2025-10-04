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

export type GaboratorParams = {
  bandsPerOctave: number;
  minFreq: number;
};

export interface UndoState {
  data: Buffer;
  filePath: string;
}

export interface IpcApi {
  onOpenFile: (callback: (path: string) => void) => () => void;
  onOpenAndAnalyze: (callback: () => void) => () => void;
  onAnalysisComplete: (callback: (payload: AnalysisPayloadForRenderer) => void) => () => void;
  onAnalysisError: (callback: (error: string) => void) => () => void;
  onUndoApplyState: (callback: (state: UndoState) => void) => () => void;
  loadFile: (filePath: string, params: GaboratorParams) => void;
  addUndoState: (args: { filePath: string; data: ArrayBufferLike }) => void;
  fileOpened: (filePath: string) => void;
  fileClosed: (filePath: string) => void;
  setActiveFile: (filePath: string | null) => void;
  clearUndoState: () => void;
  synthesizeAudio: (
    payload: Omit<SynthesisPayload, "processedData"> & { processedData: ArrayBufferLike },
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<Float32Array[]>;
  openAndAnalyze: (params: GaboratorParams) => void;
  reanalyzeCurrentFile: (params: GaboratorParams) => Promise<void>;
  saveAudioData: (
    payload: Omit<SynthesisPayload, "processedData"> & { processedData: ArrayBufferLike },
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<void>;
  onRequestAudioForSaving: (callback: () => void) => () => void;
  onCloseActiveFile: (callback: () => void) => () => void;
  onCloseAllFiles: (callback: () => void) => () => void;
  onRestoreOriginal: (callback: () => void) => () => void;
  onReanalyzeActiveFile: (callback: () => void) => () => void;
}

export interface IpcMainHandlers {
  "load-file": (event: Electron.IpcMainEvent, filePath: string, params: GaboratorParams) => void;
  "add-undo-state": (event: Electron.IpcMainEvent, args: { data: Buffer; filePath: string }) => void;
  "clear-undo-state": (event: Electron.IpcMainEvent) => void;
  "open-and-analyze": (event: Electron.IpcMainEvent, params: GaboratorParams) => void;
  "reanalyze-current-file": (event: Electron.IpcMainInvokeEvent, params: GaboratorParams) => Promise<void>;
  "synthesize-audio": (
    event: Electron.IpcMainInvokeEvent,
    payload: SynthesisPayload,
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<Float32Array[]>;
  "save-audio-data": (
    event: Electron.IpcMainInvokeEvent,
    payload: SynthesisPayload,
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<void>;
  "set-active-file": (event: Electron.IpcMainEvent, filePath: string) => void;
  "file-opened": (event: Electron.IpcMainEvent, filePath: string) => void;
  "file-closed": (event: Electron.IpcMainEvent, filePath: string) => void;
}

export interface IpcRendererEvents {
  "open-file": (path: string) => void;
  "analysis-complete": (payload: AnalysisPayloadForRenderer) => void;
  "analysis-error": (error: string) => void;
  "request-audio-for-saving": () => void;
  "apply-undo-state": (state: { data: Buffer; filePath: string }) => void;
  "undo-state-changed": (state: { canUndo: boolean; canRedo: boolean }) => void;
  "close-active-file": () => void;
  "close-all-files": () => void;
  "open-and-analyze": () => void;
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
