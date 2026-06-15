// Portable host-capability surface shared by the Electron desktop app and the
// Ableton extension build. The renderer core depends only on this interface;
// each shell supplies a concrete implementation (see electron.ts). This is the
// single seam that lets one renderer core run in two host environments.

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

/** The single `os` member the core uses. */
export interface HostOs {
  homedir(): string;
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
export interface Host {
  readonly fs: HostFs;
  readonly path: HostPath;
  readonly os: HostOs;
  readonly zlib: HostZlib;
  readonly analysis: Window["audioAnalysis"];
  readonly link: Window["linkAddon"];
  readonly updater: Window["updater"];
  readonly env: HostEnv;
  readonly dialogs: HostDialogs;
  readonly files: HostFiles;
  readonly events: HostEvents;
}
