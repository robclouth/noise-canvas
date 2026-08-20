import { ElectronAPI } from "@electron-toolkit/preload";
import type { IpcRenderer } from "electron";
import {
  AnalysisParams,
  CommitStroke,
  CommitStrokeResult,
  CommitWindow,
  PackedLayout,
  PhaseTurns,
} from "../main/lib/types";

// Type definitions for window globals

declare global {
  interface Window {
    electron: ElectronAPI;
    // Direct IPC access (exposed to avoid Vite bundling issues)
    ipcRenderer: IpcRenderer;
    audioAnalysis: {
      /**
       * GPU memory available to textures in bytes; `unified` marks a GPU that
       * shares system RAM. Zero bytes means no budget is known.
       */
      getGpuMemoryInfo: () => { bytes: number; unified: boolean };
      analyze: (
        filePath: string,
        params: AnalysisParams,
      ) => Promise<{
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
        sampleRate: number;
        magnitudeEnergy: number;
        onsets: Float32Array;
        // What the whole-file onset pass learned, so later passes can re-derive
        // one span of the file and still judge it on the file's own terms.
        onsetOdfMax?: number;
        onsetBandMax?: Float32Array;
        format: string;
        codec: string;
        channels: number;
      }>;
      analyseBuffer: (
        audioBuffer: AudioBuffer,
        params: AnalysisParams,
      ) => Promise<{
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
        sampleRate: number;
        magnitudeEnergy: number;
        onsets: Float32Array;
        // What the whole-file onset pass learned, so later passes can re-derive
        // one span of the file and still judge it on the file's own terms.
        onsetOdfMax?: number;
        onsetBandMax?: Float32Array;
        format: string;
        codec: string;
        channels: number;
      }>;
      synthesize: (
        processedData: Float32Array,
        analysisMetadata: {
          numFrames: number;
          numChannels: number;
          numBands: number;
          bandOffsets: Uint32Array;
          bandStepLog2s: Int32Array;
          bandLengths: Uint32Array;
        },
        sampleRate: number,
        params: AnalysisParams,
        applyLimiter: boolean,
        existingAudio?: Float32Array[],
        startFrame?: number,
        endFrame?: number,
        startBand?: number,
        endBand?: number,
      ) => Promise<{
        channels: Float32Array[];
        peak: number;
        gainReductionDb: Float32Array;
        maxGainReductionDb: number;
        onsets?: Float32Array;
        onsetOdfMax?: number;
        onsetBandMax?: Float32Array;
      }>;
      /**
       * Everything a finished stroke derives, in one call. Rejects whole on any
       * failure; never writes to `packedData`.
       */
      commitStroke: (
        packedData: Float32Array,
        analysisMetadata: PackedLayout,
        sampleRate: number,
        params: AnalysisParams,
        existingAudio: Float32Array[],
        window: CommitWindow,
        stroke: CommitStroke,
      ) => Promise<CommitStrokeResult>;
      isModelDownloaded: (modelFile: string) => boolean;
      downloadModel: (modelFile: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>;
      aiSeparate: (audioChannels: Float32Array[], sampleRate: number) => Promise<Record<string, Float32Array[]>>;
      detectOnsets: (
        packedData: Float32Array,
        analysisMetadata: {
          numBands: number;
          numChannels: number;
          numFrames: number;
          bandOffsets: Uint32Array;
          bandLengths: Uint32Array;
          bandStepLog2s: Int32Array;
        },
        sampleRate: number,
        region?: { startSec: number; endSec: number; odfMax?: number; bandMax?: Float32Array },
      ) => Promise<{ onsets: Float32Array; odfMax: number; bandMax: Float32Array }>;
      hpss: (
        packedData: Float32Array,
        analysisMetadata: {
          numBands: number;
          numChannels: number;
          bandOffsets: Uint32Array;
          bandLengths: Uint32Array;
        },
        kernelH?: number,
        kernelV?: number,
      ) => Promise<{ harmonic: Float32Array; percussive: Float32Array }>;
      nmf: (
        packedData: Float32Array,
        analysisMetadata: {
          numBands: number;
          numChannels: number;
          bandOffsets: Uint32Array;
          bandLengths: Uint32Array;
        },
        numComponents: number,
        iterations?: number,
        seed?: number,
      ) => Promise<{ parts: Float32Array[] }>;
      mergeSpectrograms: (
        parts: Float32Array[],
        analysisMetadata: {
          numBands: number;
          numChannels: number;
          bandOffsets: Uint32Array;
          bandLengths: Uint32Array;
        },
      ) => Promise<{ merged: Float32Array }>;
      exportAudio: (
        audioChannels: Float32Array[],
        outputPath: string,
        sampleRate: number,
        format?: string,
      ) => Promise<void>;
      decodeAudio: (inputPath: string, sampleRate: number, numChannels: number) => Promise<Float32Array[]>;
      copyAudioFile: (sourcePath: string, destPath: string) => Promise<void>;
      // Undo-history codec. Each of these walks a packed state, so they run in
      // the addon off the renderer thread.
      encodeHistorySnapshot: (packed: Float32Array) => Promise<Uint8Array>;
      decodeHistorySnapshot: (bytes: Uint8Array) => Promise<Float32Array>;
      historyFootprintChanged: (
        base: Float32Array,
        after: Float32Array,
        ranges: Uint32Array,
        baseCompact?: boolean,
      ) => Promise<boolean>;
      encodeHistoryDelta: (
        base: Float32Array,
        after: Float32Array,
        ranges: Uint32Array,
        baseCompact?: boolean,
        turns?: PhaseTurns,
      ) => Promise<Uint8Array>;
      readHistoryDeltaTurns: (bytes: Uint8Array) => Promise<PhaseTurns | null>;
      applyHistoryDelta: (base: Float32Array, bytes: Uint8Array) => Promise<Float32Array>;
      applyHistoryDeltas: (
        base: Float32Array,
        out: Float32Array,
        deltas: Uint8Array[],
        inverts: boolean[],
      ) => Promise<Float32Array>;
      buildHistoryInverseMap: (
        bandOffsets: Uint32Array,
        bandLengths: Uint32Array,
        bandStepLog2s: Int32Array,
        pixelCount: number,
      ) => Promise<Float32Array>;
      init: () => void;
    };
    linkAddon: {
      create: (bpm: number) => void;
      destroy: () => void;
      setCallbacks: (callbacks: {
        onTempoChanged: (tempo: number) => void;
        onStartStopChanged: (isPlaying: boolean) => void;
        onNumPeersChanged: (numPeers: number) => void;
      }) => void;
      enable: () => void;
      disable: () => void;
      isEnabled: () => boolean;
      enableStartStopSync: (enable: boolean) => void;
      setIsPlaying: (isPlaying: boolean) => void;
      setTempo: (bpm: number) => void;
      requestBeatAtTime: (beat: number, quantum: number) => void;
      captureState: (quantum: number) => {
        tempo: number;
        beat: number;
        phase: number;
        isPlaying: boolean;
        numPeers: number;
      };
      init: () => void;
    };
    compression: {
      compress: (data: Buffer) => Buffer;
      uncompress: (data: Buffer) => Buffer;
    };
    nodeFs: typeof import("fs/promises");
    nodePath: typeof import("path");
    nodeOs: typeof import("os");
    nodeZlib: typeof import("zlib");
    platform: NodeJS.Platform;
    updater: {
      checkForUpdates: () => Promise<any>;
      downloadUpdate: () => Promise<boolean>;
      quitAndInstall: () => void;
    };
  }
}
