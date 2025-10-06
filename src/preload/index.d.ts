import { ElectronAPI } from "@electron-toolkit/preload";
import { GaboratorParams, IpcApi } from "../main/lib/types";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: IpcApi;
    // Direct gaborator access (no IPC)
    gaborator?: {
      analyze: (
        filePath: string,
        params: GaboratorParams,
      ) => Promise<{
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
        sampleRate: number;
        format: string;
        codec: string;
        channels: number;
        isClamped: boolean;
        clampedDurationSeconds: number;
      }>;
      synthesize: (
        processedData: Float32Array,
        analysisMetadata: any,
        sampleRate: number,
        params: GaboratorParams,
        normalize: boolean,
      ) => Promise<Float32Array[]>;
      loadGaborator: () => any;
    };
    // Direct compression access for undo
    compression?: {
      compress: (data: Buffer) => Buffer;
      uncompress: (data: Buffer) => Buffer;
    };
    // Node.js utilities for direct access
    nodeFs?: typeof import("fs/promises");
    nodePath?: typeof import("path");
    nodeOs?: typeof import("os");
  }
}
