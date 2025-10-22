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
        analysisMetadata: any,
        sampleRate: number,
        params: AnalysisParams,
        normalize: boolean,
      ) => Promise<Float32Array[]>;
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
    updater: {
      checkForUpdates: () => Promise<any>;
      downloadUpdate: () => Promise<boolean>;
      quitAndInstall: () => void;
    };
  }
}
