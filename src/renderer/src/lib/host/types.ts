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

/**
 * The capabilities the renderer core needs from its host environment.
 *
 * `fs`/`path`/`os`/`zlib`/`analysis`/`link`/`updater` mirror the Node stdlib
 * and native-addon surfaces exactly — their types are reused from the global
 * `Window` augmentation (see src/preload/index.d.ts) so the migration away from
 * the old `window.*` access is a mechanical rename with no type drift.
 */
export interface Host {
  readonly fs: Window["nodeFs"];
  readonly path: HostPath;
  readonly os: Window["nodeOs"];
  readonly zlib: Window["nodeZlib"];
  readonly analysis: Window["audioAnalysis"];
  readonly link: Window["linkAddon"];
  readonly updater: Window["updater"];
  readonly env: HostEnv;
  readonly dialogs: HostDialogs;
  readonly files: HostFiles;
}
