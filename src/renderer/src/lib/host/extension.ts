import type { Host, HostPath } from "./types";

// Host implementation for the Ableton extension build. The renderer core runs
// inside the extension's modal webview; capabilities that the Electron app got
// from Node/Electron are provided differently here:
//
//   - env / platform        → from the browser + values injected by the host
//   - link / updater         → no-ops (Live owns transport; no self-updater)
//   - path                   → a small browser implementation (POSIX semantics)
//   - fs / zlib / analysis    → served by the Node extension host over localhost
//     (wired in Phase 3). Until then they throw a clear, actionable error so a
//     premature call is obvious rather than a silent `undefined`.
//   - dialogs / files         → routed to the SDK host bridge (Phase 2 spike)
//
// Selected by the `@host-impl` build alias (see vite.extension.config.ts).

const pending = (capability: string): never => {
  throw new Error(
    `host.${capability} is not available in the extension build yet — ` +
      `it will be served by the Node extension host over localhost (Phase 3).`,
  );
};

// Minimal POSIX path implementation. The webview always deals in absolute
// localhost-served paths, so only join/dirname/basename/extname are needed and
// platform separators are always "/".
const browserPath: HostPath = {
  join: (...parts: string[]) =>
    parts
      .filter((p) => p.length > 0)
      .join("/")
      .replace(/\/+/g, "/"),
  dirname: (p: string) => {
    const i = p.replace(/\/+$/, "").lastIndexOf("/");
    return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i);
  },
  basename: (p: string, ext?: string) => {
    const base = p.replace(/\/+$/, "").split("/").pop() ?? "";
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  extname: (p: string) => {
    const base = p.split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot) : "";
  },
};

export const host: Host = {
  get fs(): Host["fs"] {
    return pending("fs");
  },
  path: browserPath,
  get os(): Host["os"] {
    return pending("os");
  },
  get zlib(): Host["zlib"] {
    return pending("zlib");
  },
  get analysis(): Host["analysis"] {
    return pending("analysis");
  },
  // Ableton Live is the transport clock, so in-app Ableton Link sync is inert:
  // a fully no-op device that always reports disabled. The extension UI hides
  // the Link control, so these are never driven in practice.
  link: {
    create: () => {},
    destroy: () => {},
    setCallbacks: () => {},
    enable: () => {},
    disable: () => {},
    isEnabled: () => false,
    enableStartStopSync: () => {},
    setIsPlaying: () => {},
    setTempo: () => {},
    requestBeatAtTime: () => {},
    captureState: () => ({ tempo: 120, beat: 0, phase: 0, isPlaying: false, numPeers: 0 }),
    init: () => {},
  },
  // The extension has no self-updater; the host installs updates.
  updater: {
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => false,
    quitAndInstall: () => {},
  },
  env: {
    get platform() {
      // The webview reports the host OS via the userAgent.
      return navigator.userAgent.includes("Win") ? "win32" : navigator.userAgent.includes("Mac") ? "darwin" : "linux";
    },
    get nodeEnv() {
      return import.meta.env.MODE;
    },
    get resourcesPath() {
      return "/";
    },
    cwd() {
      return "/";
    },
    getEnv() {
      return undefined;
    },
  },
  dialogs: {
    getUserDataPath: () => pending("dialogs.getUserDataPath"),
    showSaveDialog: () => pending("dialogs.showSaveDialog"),
    showDirectoryDialog: () => pending("dialogs.showDirectoryDialog"),
  },
  files: {
    getPathForFile: () => pending("files.getPathForFile"),
  },
};
