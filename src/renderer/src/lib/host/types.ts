// Portable host-capability surface shared by the Electron desktop app and the
// Ableton extension build. The renderer core depends only on this interface;
// each shell supplies a concrete implementation (see electron.ts). This is the
// single seam that lets one renderer core run in two host environments.

import type { DiagData, DiagLevel } from "../../../../main/lib/types";

/** Options accepted by the native "save file" dialog. */
export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
  buttonLabel?: string;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

/** Options accepted by the native "choose directory" dialog. */
export interface DirectoryDialogOptions {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
}

export interface DirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/** Process/runtime information that varies between host environments. */
export interface HostEnv {
  /** True in the Ableton extension build, false in the Electron app. Gates
   * extension-only UI such as the in-app menu bar (native menus are unavailable). */
  readonly isExtension: boolean;
  /** The OS platform, e.g. "darwin" | "win32" | "linux". */
  readonly platform: NodeJS.Platform;
  /** The CPU architecture, e.g. "arm64" | "x64". */
  readonly arch: NodeJS.Architecture;
  /** The value of NODE_ENV, or undefined when unset. */
  readonly nodeEnv: string | undefined;
  /** Absolute path to the app's bundled resources directory. */
  readonly resourcesPath: string;
  /** The current working directory. */
  cwd(): string;
  /** Read an environment variable by name. */
  getEnv(key: string): string | undefined;
}

/** Native file/directory pickers and the per-user data directory. */
export interface HostDialogs {
  /** Directory where the app may persist per-user data (history, presets). */
  getUserDataPath(): Promise<string>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
  showDirectoryDialog(options?: DirectoryDialogOptions): Promise<DirectoryDialogResult>;
}

export interface HostFiles {
  /**
   * False where the host cannot resolve a dropped File to a path — the
   * extension's webview, which has no filesystem. Callers must not offer a drop
   * target there rather than call `getPathForFile` and catch the failure.
   */
  canResolveDroppedPaths: boolean;
  /** Resolve the absolute filesystem path for a dropped File. */
  getPathForFile(file: File): string;
}

/**
 * The renderer↔host event channel: menu actions (undo/save/open…) and the
 * updater lifecycle. In Electron it rides `window.ipcRenderer`; in the extension
 * it is an in-process emitter the in-app menu bar drives. Listeners receive only
 * the payload args — the Electron event object is stripped by the impl.
 */
export interface HostEvents {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribe; returns an unsubscribe function. */
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
  once(channel: string, listener: (...args: unknown[]) => void): void;
}

/**
 * The path operations the renderer core uses. A subset of Node's `path` module
 * (the only members the core touches) so a non-Node host can supply a small
 * browser implementation without claiming the whole module surface. Node's
 * `path` is structurally assignable to this.
 */
export interface HostPath {
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
}

/** A directory entry, the subset of Node's `Dirent` the core reads. */
export interface HostDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** File stats, the subset of Node's `Stats` the core reads. */
export interface HostStats {
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The `fs/promises` operations the renderer core uses. Node's `fs/promises` is
 * structurally assignable to this, so the Electron host supplies it directly; a
 * non-Node host implements just these members (e.g. over a localhost RPC).
 */
export interface HostFs {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf-8" | "utf8"): Promise<string>;
  readFile(path: string, options: { encoding: "utf-8" | "utf8" }): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, encoding?: "utf-8" | "utf8"): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<HostDirent[]>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<HostStats>;
  access(path: string): Promise<void>;
}

/** The `os` members the core uses. */
export interface HostOs {
  homedir(): string;
  /** Total system memory in bytes. */
  totalmem(): number;
}

/**
 * An active host-driven editing session. Present only in the Ableton extension,
 * where the editor opens against a specific clip and renders audio back into the
 * Live set. Absent in the Electron app, which saves to disk instead.
 */
/** One rendered audio state bound for a new clip in the Live set. */
export interface HostRender {
  channels: Float32Array[];
  sampleRate: number;
  /** Clip name, e.g. the file name or a history node's label. */
  label: string;
}

export interface HostSession {
  /**
   * Send rendered audio back to the host and close the editor. One render
   * becomes one clip; multiple (a branch export) each become their own clip.
   */
  apply(renders: HostRender[]): Promise<void>;
}

/** The Zstandard helpers the core uses, keeping Node's callback signatures. */
export interface HostZlib {
  zstdCompress(buffer: Uint8Array, callback: (error: Error | null, result: Uint8Array) => void): void;
  zstdDecompress(buffer: Uint8Array, callback: (error: Error | null, result: Uint8Array) => void): void;
}

/**
 * The capabilities the renderer core needs from its host environment.
 *
 * `fs`/`path`/`os`/`zlib`/`analysis`/`link`/`updater` mirror the Node stdlib
 * and native-addon surfaces exactly — their types are reused from the global
 * `Window` augmentation (see src/preload/index.d.ts) so the migration away from
 * the old `window.*` access is a mechanical rename with no type drift.
 */
/** Opening a URL outside the app, so a link never navigates the editor away. */
export interface HostShell {
  openExternal(url: string): void;
}

/**
 * Where the persisted store slice lives: `localStorage` in the Electron app, a
 * file in Live's per-extension storage directory in the extension, whose modal
 * webview gets a fresh origin — and so an empty `localStorage` — every run.
 * Reads are synchronous, so an extension implementation must be primed before
 * the app mounts.
 */
export interface HostPrefs {
  read(name: string): string | null;
  write(name: string, value: string): void;
  remove(name: string): void;
}

/**
 * The diagnostic log: timings, memory readings and errors a user can send back.
 * The Electron app appends to a file in its user-data folder; the extension
 * has no writable log and only echoes to the console.
 */
export interface HostDiag {
  write(level: DiagLevel, scope: string, message: string, data?: DiagData): void;
  /** Selects the log file in the OS file manager; a no-op where there is none. */
  revealLogFile(): void;
}

export interface Host {
  readonly fs: HostFs;
  readonly diag: HostDiag;
  readonly path: HostPath;
  readonly os: HostOs;
  readonly zlib: HostZlib;
  readonly analysis: Window["audioAnalysis"];
  readonly link: Window["linkAddon"];
  readonly updater: Window["updater"];
  readonly env: HostEnv;
  readonly dialogs: HostDialogs;
  readonly files: HostFiles;
  readonly shell: HostShell;
  readonly prefs: HostPrefs;
  readonly events: HostEvents;
  /** Present only when the editor runs against a host-driven clip session. */
  readonly session?: HostSession;
}
