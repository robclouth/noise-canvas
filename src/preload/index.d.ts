import { ElectronAPI } from "@electron-toolkit/preload";
import type { IpcRenderer } from "electron";
import { AnalysisParams } from "../main/lib/types";

// Type definitions for window globals

declare global {
  interface Window {
    electron: ElectronAPI;
    // Direct IPC access (exposed to avoid Vite bundling issues)
    ipcRenderer: IpcRenderer;
    audioAnalysis: {
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
        normalize: boolean,
        existingAudio?: Float32Array[],
        startFrame?: number,
        endFrame?: number,
        startBand?: number,
        endBand?: number,
      ) => Promise<{
        channels: Float32Array[];
        peak: number;
      }>;
      isModelDownloaded: (modelFile: string) => boolean;
      downloadModel: (
        modelFile: string,
        onProgress?: (downloaded: number, total: number) => void,
      ) => Promise<void>;
      aiSeparate: (
        audioChannels: Float32Array[],
        sampleRate: number,
      ) => Promise<Record<string, Float32Array[]>>;
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
      exportAudio: (
        audioChannels: Float32Array[],
        outputPath: string,
        sampleRate: number,
        format?: string,
      ) => Promise<void>;
      init: () => void;
    };
    compression: {
      compress: (data: Buffer) => Buffer;
      uncompress: (data: Buffer) => Buffer;
    };
    nodeFs: typeof import("fs/promises");
    nodePath: typeof import("path");
    nodeOs: typeof import("os");
    platform: NodeJS.Platform;
    updater: {
      checkForUpdates: () => Promise<any>;
      downloadUpdate: () => Promise<boolean>;
      quitAndInstall: () => void;
    };
  }
}
