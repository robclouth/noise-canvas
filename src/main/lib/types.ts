import { BrowserWindow, ipcMain } from "electron";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
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
  magnitudeEnergy: number;
}

export type AnalysisParams = {
  bandsPerOctave: number;
  minFreq: number;
  /**
   * Re-derive the onset map during synthesis, from the packed data that pass
   * already walks. Ignored by analysis, which always returns onsets.
   */
  detectOnsets?: boolean;
  /**
   * Span of the file to re-derive onsets for, with the reference from the pass
   * that last read the whole file (see OnsetReference). A stroke only changes
   * its own span, so only that span's onsets need finding again; the caller
   * splices them into the ones it already has. Without a span, and without a
   * reference to go on, the whole file is walked.
   */
  onsetStartSec?: number;
  onsetEndSec?: number;
  onsetOdfReference?: number;
  onsetBandMax?: Float32Array;
};

/** Flat [time0, salience0, time1, salience1, …]; times in seconds. */
export type PackedOnsets = Float32Array;

/** Band layout of a packed spectrogram, as every coefficient pass wants it. */
export interface PackedLayout {
  numFrames: number;
  numChannels: number;
  numBands: number;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
}

/** Coefficients a pass rewrote: per-band [band, k0, count] plus their pixels. */
export interface CoefficientPatch {
  ranges: Uint32Array;
  pixels: Float32Array;
}

/** The span of the canvas a commit rebuilds: the dirty region, in frames and bands. */
export interface CommitWindow {
  startFrame: number;
  endFrame: number;
  startBand: number;
  endBand: number;
}

/** What the stroke itself asks of the commit, beyond the span it touched. */
export interface CommitStroke {
  footStartFrame: number;
  footEndFrame: number;
  /** Whether each time edge is a hard cut that must be exact in the time domain. */
  hardEdgeStart: boolean;
  hardEdgeEnd: boolean;
  applyLimiter: boolean;
  /** False skips the projection: the patch comes back empty and the canvas keeps its painted coefficients. */
  project: boolean;
}

/** Peak level per 5 ms hop over the window a commit rebuilt, from `startHop`. */
export interface CommitLevels {
  startHop: number;
  peaks: Float32Array;
  clipped: Uint8Array;
}

export interface CommitStrokeResult {
  channels: Float32Array[];
  peak: number;
  patch: CoefficientPatch;
  gainReductionDb: Float32Array;
  maxGainReductionDb: number;
  levels: CommitLevels;
  onsets?: PackedOnsets;
  onsetOdfMax?: number;
  onsetBandMax?: Float32Array;
}

/**
 * What a detection pass learned about the file as a whole: the level that
 * counts as silence, and each band's loudest moment. Everything else about an
 * onset is local to it, so handing these back is what lets a later pass read
 * one span of the file and still judge it on the file's own terms.
 */
export interface OnsetReference {
  odfMax: number;
  bandMax: Float32Array;
}

export interface OnsetResult extends OnsetReference {
  onsets: PackedOnsets;
}

export interface IpcMainHandlers {
  "update-menu-state": (event: Electron.IpcMainEvent, canUndo: boolean, canRedo: boolean) => void;
  // Renderer's answer to "app-will-quit": its shutdown work is finished.
  "quit-cleanup-done": (event: Electron.IpcMainEvent) => void;
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
  "export-image": () => void;
  undo: () => void;
  redo: () => void;
  "restore-original": () => void;
  "duplicate-active-file": () => void;
  "fill-grid": () => void;
  "close-active-file": () => void;
  "reanalyze-active-file": () => void;
  "double-active-file-length": () => void;
  "halve-active-file-length": () => void;
  "update-available": (info: UpdateInfo) => void;
  "update-not-available": () => void;
  "update-downloaded": (info: UpdateInfo) => void;
  "download-progress": (progressInfo: ProgressInfo) => void;
  "update-error": (message: string) => void;
  "app-will-quit": () => void;
  "run-walkthrough": () => void;
  "open-manual": (section?: string) => void;
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
