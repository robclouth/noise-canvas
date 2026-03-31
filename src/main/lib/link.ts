import { join } from "path";

interface LinkCallbacks {
  onTempoChanged: (tempo: number) => void;
  onStartStopChanged: (isPlaying: boolean) => void;
  onNumPeersChanged: (numPeers: number) => void;
}

interface LinkState {
  tempo: number;
  beat: number;
  phase: number;
  isPlaying: boolean;
  numPeers: number;
}

interface LinkAddon {
  create: (bpm: number) => void;
  destroy: () => void;
  setCallbacks: (callbacks: LinkCallbacks) => void;
  enable: () => void;
  disable: () => void;
  isEnabled: () => boolean;
  enableStartStopSync: (enable: boolean) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setTempo: (bpm: number) => void;
  requestBeatAtTime: (beat: number, quantum: number) => void;
  captureState: (quantum: number) => LinkState;
}

let linkAddon: LinkAddon | null = null;

export function getLinkAddonPath(): string {
  const isPackaged = __dirname.includes("app.asar");

  if (isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked/build/Release/link_addon.node");
  } else {
    return join(__dirname, "../../build/Release/link_addon.node");
  }
}

export function init(): LinkAddon {
  if (!linkAddon) {
    const path = getLinkAddonPath();
    console.log("Loading link addon from:", path);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    linkAddon = require(path);
    console.log("Link addon loaded successfully");
  }
  return linkAddon!;
}

export function create(bpm: number): void {
  init().create(bpm);
}

export function destroy(): void {
  if (linkAddon) linkAddon.destroy();
}

export function setCallbacks(callbacks: LinkCallbacks): void {
  init().setCallbacks(callbacks);
}

export function enable(): void {
  init().enable();
}

export function disable(): void {
  init().disable();
}

export function isEnabled(): boolean {
  return linkAddon ? linkAddon.isEnabled() : false;
}

export function enableStartStopSync(enabled: boolean): void {
  init().enableStartStopSync(enabled);
}

export function setIsPlaying(isPlaying: boolean): void {
  init().setIsPlaying(isPlaying);
}

export function setTempo(bpm: number): void {
  init().setTempo(bpm);
}

export function requestBeatAtTime(beat: number, quantum: number): void {
  init().requestBeatAtTime(beat, quantum);
}

export function captureState(quantum: number): LinkState {
  return init().captureState(quantum);
}
