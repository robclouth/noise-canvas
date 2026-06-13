import type { Host } from "./types";

// Host implementation backed by Electron's preload bridges. Every member reads
// `window.*` lazily (via getters / per-call closures) rather than capturing a
// reference at module load — this matches how the renderer accessed the bridges
// before, and is required for tests that attach `window.*` stubs after import.
//
// Selected by the `@host-impl` build alias for the Electron app build (and for
// tests / typecheck); the extension build maps `@host-impl` to extension.ts.
export const host: Host = {
  get fs() {
    return window.nodeFs;
  },
  get path() {
    return window.nodePath;
  },
  get os() {
    return window.nodeOs;
  },
  get zlib() {
    return window.nodeZlib;
  },
  get analysis() {
    return window.audioAnalysis;
  },
  get link() {
    return window.linkAddon;
  },
  get updater() {
    return window.updater;
  },
  env: {
    get platform() {
      return window.platform;
    },
    get nodeEnv() {
      return process.env.NODE_ENV;
    },
    get resourcesPath() {
      return process.resourcesPath;
    },
    cwd() {
      return process.cwd();
    },
    getEnv(key) {
      return process.env[key];
    },
  },
  dialogs: {
    getUserDataPath() {
      return window.ipcRenderer.invoke("get-user-data-path");
    },
    showSaveDialog(options) {
      return window.ipcRenderer.invoke("show-save-dialog", options);
    },
    showDirectoryDialog(options) {
      return window.ipcRenderer.invoke("show-directory-dialog", options);
    },
  },
  files: {
    getPathForFile(file) {
      return window.electron.webUtils.getPathForFile(file);
    },
  },
};
