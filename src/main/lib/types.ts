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
  sampleRate: number; // Pass sample rate through
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

export interface GaboratorParams {
  bandsPerOctave: number;
  fmin: number;
}

export interface IpcApi {
  onOpenFile: (callback: (path: string) => void) => () => void;
  onTriggerOpenFile: (callback: () => void) => () => void;
  onAnalysisComplete: (callback: (payload: AnalysisPayloadForRenderer) => void) => () => void;
  onAnalysisError: (callback: (error: string) => void) => () => void;
  onUndoApplyState: (callback: (data: Buffer) => void) => () => void;
  loadFile: (filePath: string, params: GaboratorParams) => void;
  addUndoState: (args: { before: ArrayBufferLike; after: ArrayBufferLike }) => void;
  clearUndoState: () => void;
  synthesizeAudio: (
    payload: Omit<SynthesisPayload, "processedData"> & { processedData: ArrayBufferLike },
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<Float32Array>;
  openFileAndAnalyze: (params: GaboratorParams) => Promise<{ canceled: boolean }>;
  saveAudioData: (
    payload: Omit<SynthesisPayload, "processedData"> & { processedData: ArrayBufferLike },
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<void>;
  onRequestAudioForSaving: (callback: () => void) => () => void;
}

export interface IpcMainHandlers {
  "load-file": (event: Electron.IpcMainEvent, filePath: string, params: GaboratorParams) => void;
  "undo:add-state": (event: Electron.IpcMainEvent, args: { before: Buffer; after: Buffer }) => void;
  "undo:clear": (event: Electron.IpcMainEvent) => void;
  "open-file-and-analyze": (
    event: Electron.IpcMainInvokeEvent,
    params: GaboratorParams,
  ) => Promise<{ canceled: boolean }>;
  "synthesize-audio": (
    event: Electron.IpcMainInvokeEvent,
    payload: SynthesisPayload,
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<Float32Array>;
  "save-audio-data": (
    event: Electron.IpcMainInvokeEvent,
    payload: SynthesisPayload,
    params: GaboratorParams,
    normalize: boolean,
  ) => Promise<void>;
}

export interface IpcRendererEvents {
  "open-file": (path: string) => void;
  "analysis-complete": (payload: AnalysisPayloadForRenderer) => void;
  "analysis-error": (error: string) => void;
  "request-audio-for-saving": () => void;
  "undo:apply-state": (data: Buffer) => void;
  "undo:state-changed": (state: { canUndo: boolean; canRedo: boolean }) => void;
}
